require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const CURRENCY = 'USD';
const INITIAL_OWNER_FEE = '500.00';
const MONTHLY_OWNER_FEE = '250.00';
const BOOKING_FEE = '8.00';
const paypalBase = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  console.error('Missing DATABASE_URL or JWT_SECRET. Copy .env.example to .env and configure them.');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/paypal', rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner',
      initial_fee_paid BOOLEAN NOT NULL DEFAULT FALSE,
      first_paid_at TIMESTAMPTZ, access_until TIMESTAMPTZ,
      paypal_subscription_id TEXT, subscription_status TEXT NOT NULL DEFAULT 'none',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS listings (
      id UUID PRIMARY KEY, owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, city TEXT NOT NULL, property_type TEXT NOT NULL,
      description TEXT NOT NULL, nightly_price NUMERIC(10,2) NOT NULL CHECK(nightly_price > 0),
      max_guests INTEGER NOT NULL CHECK(max_guests BETWEEN 1 AND 50),
      image_url TEXT, amenities TEXT[] NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'published',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id UUID PRIMARY KEY, ticket_number TEXT UNIQUE, listing_id UUID NOT NULL REFERENCES listings(id),
      guest_name TEXT NOT NULL, guest_email TEXT NOT NULL, check_in DATE NOT NULL, check_out DATE NOT NULL,
      guests INTEGER NOT NULL, nightly_price NUMERIC(10,2) NOT NULL, nights INTEGER NOT NULL,
      accommodation_total NUMERIC(10,2) NOT NULL, booking_fee NUMERIC(10,2) NOT NULL DEFAULT 8.00,
      status TEXT NOT NULL DEFAULT 'pending_payment', paypal_order_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(check_out > check_in)
    );
    CREATE TABLE IF NOT EXISTS payment_orders (
      id UUID PRIMARY KEY, paypal_order_id TEXT UNIQUE, user_id UUID REFERENCES users(id),
      booking_id UUID REFERENCES bookings(id), kind TEXT NOT NULL, amount NUMERIC(10,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'created',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), captured_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS bookings_listing_dates_idx ON bookings(listing_id, check_in, check_out);
    CREATE INDEX IF NOT EXISTS listings_owner_idx ON listings(owner_id);
  `);
}
function makeToken(user) { return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' }); }
function setAuthCookie(res, user) { res.cookie('cj_session', makeToken(user), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' }); }
async function auth(req, res, next) {
  try {
    const token = req.cookies.cj_session;
    if (!token) return res.status(401).json({ error: 'Please sign in first.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT id,name,email,role,initial_fee_paid,first_paid_at,access_until,paypal_subscription_id,subscription_status FROM users WHERE id=$1', [payload.sub]);
    if (!result.rowCount) return res.status(401).json({ error: 'Account not found.' });
    req.user = result.rows[0]; next();
  } catch { return res.status(401).json({ error: 'Your session expired. Please sign in again.' }); }
}
function ownerCanManage(user) {
  return user.initial_fee_paid && ((user.access_until && new Date(user.access_until) > new Date()) || user.subscription_status === 'ACTIVE');
}
function paypalConfigured() { return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && !process.env.PAYPAL_CLIENT_ID.startsWith('replace_') && !process.env.PAYPAL_CLIENT_SECRET.startsWith('replace_')); }
async function paypalAccessToken() {
  if (!paypalConfigured()) throw new Error('PayPal is not configured. Add the PayPal credentials in Render environment variables.');
  const authHeader = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${paypalBase}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const data = await r.json(); if (!r.ok) throw new Error(data.error_description || 'Could not authenticate with PayPal.'); return data.access_token;
}
async function paypalRequest(url, method, body) {
  const token = await paypalAccessToken();
  const r = await fetch(`${paypalBase}${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json(); if (!r.ok) { const err = new Error(data.message || data.details?.[0]?.description || 'PayPal request failed.'); err.status = r.status; throw err; } return data;
}
function validDateRange(start, end) {
  const a = new Date(`${start}T00:00:00Z`), b = new Date(`${end}T00:00:00Z`), today = new Date(); today.setUTCHours(0,0,0,0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || Number.isNaN(a.valueOf()) || Number.isNaN(b.valueOf()) || a < today || b <= a) return false;
  return Math.ceil((b-a)/86400000) <= 90;
}
function publicUser(u) { return { id:u.id, name:u.name, email:u.email, role:u.role, initialFeePaid:u.initial_fee_paid, accessUntil:u.access_until, subscriptionStatus:u.subscription_status }; }
app.get('/api/config', (req,res)=>res.json({ paypalClientId: process.env.PAYPAL_CLIENT_ID && !process.env.PAYPAL_CLIENT_ID.startsWith('replace_') ? process.env.PAYPAL_CLIENT_ID : null, currency:CURRENCY, fees:{ownerInitial:INITIAL_OWNER_FEE, ownerMonthly:MONTHLY_OWNER_FEE, booking:BOOKING_FEE}, paymentsMode:process.env.PAYPAL_MODE==='live'?'live':'sandbox' }));
app.get('/api/health', async (req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:'connected'});}catch{res.status(503).json({ok:false,database:'unavailable'});}});
app.post('/api/auth/register', async (req,res)=>{
  try { const name=String(req.body.name||'').trim(), email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
    if(name.length<2 || name.length>100 || !/^\S+@\S+\.\S+$/.test(email) || password.length<10) return res.status(400).json({error:'Enter your name, a valid email and a password of at least 10 characters.'});
    const id=crypto.randomUUID(), hash=await bcrypt.hash(password,12); const r=await pool.query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,initial_fee_paid,first_paid_at,access_until,paypal_subscription_id,subscription_status',[id,name,email,hash,'owner']);
    setAuthCookie(res,r.rows[0]);res.status(201).json({user:publicUser(r.rows[0])});
  } catch(e){if(e.code==='23505')return res.status(409).json({error:'An account with that email already exists.'}); console.error(e);res.status(500).json({error:'Could not create account.'});}
});
app.post('/api/auth/login',async(req,res)=>{try{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const r=await pool.query('SELECT * FROM users WHERE email=$1',[email]);if(!r.rowCount||!await bcrypt.compare(password,r.rows[0].password_hash))return res.status(401).json({error:'Email or password is incorrect.'});setAuthCookie(res,r.rows[0]);res.json({user:publicUser(r.rows[0])});}catch(e){console.error(e);res.status(500).json({error:'Could not sign in.'});}});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('cj_session',{path:'/'});res.json({ok:true});});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));
app.get('/api/listings',async(req,res)=>{try{const q=String(req.query.q||'').trim();const r=await pool.query(`SELECT l.id,l.title,l.city,l.property_type,l.description,l.nightly_price,l.max_guests,l.image_url,l.amenities,l.owner_id,u.name AS owner_name FROM listings l JOIN users u ON u.id=l.owner_id WHERE l.status='published' AND ($1='' OR (l.title||' '||l.city||' '||l.description) ILIKE '%'||$1||'%') ORDER BY l.created_at DESC`,[q]);res.json({listings:r.rows});}catch(e){console.error(e);res.status(500).json({error:'Could not load listings.'});}});
app.get('/api/owner/listings',auth,async(req,res)=>{try{const r=await pool.query('SELECT * FROM listings WHERE owner_id=$1 ORDER BY created_at DESC',[req.user.id]);res.json({canManage:ownerCanManage(req.user),listings:r.rows,user:publicUser(req.user)});}catch(e){console.error(e);res.status(500).json({error:'Could not load your listings.'});}});
app.post('/api/owner/listings',auth,async(req,res)=>{try{if(!ownerCanManage(req.user))return res.status(402).json({error:'Pay the $500 initial fee and maintain an active subscription before managing listings.'});const title=String(req.body.title||'').trim(),city=String(req.body.city||'').trim(),type=String(req.body.propertyType||'').trim(),description=String(req.body.description||'').trim(),price=Number(req.body.nightlyPrice),guests=Number(req.body.maxGuests),image=String(req.body.imageUrl||'').trim(),amenities=Array.isArray(req.body.amenities)?req.body.amenities.map(x=>String(x).trim()).filter(Boolean).slice(0,15):[];if(title.length<3||city.length<2||type.length<2||description.length<20||!Number.isFinite(price)||price<=0||price>100000||!Number.isInteger(guests)||guests<1||guests>50)return res.status(400).json({error:'Complete all required fields. Description must be at least 20 characters.'});if(image && !/^https:\/\//i.test(image))return res.status(400).json({error:'Use a secure HTTPS image URL.'});const id=crypto.randomUUID();const r=await pool.query('INSERT INTO listings(id,owner_id,title,city,property_type,description,nightly_price,max_guests,image_url,amenities) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[id,req.user.id,title,city,type,description,price,guests,image||null,amenities]);res.status(201).json({listing:r.rows[0]});}catch(e){console.error(e);res.status(500).json({error:'Could not save property.'});}});
app.post('/api/paypal/create-order',async(req,res)=>{
  try { const kind=String(req.body.kind||'');let amount,userId=null,bookingId=null,description='CJ US STAYS payment',booking=null;
    if(kind==='owner_initial'){if(!req.cookies.cj_session)return res.status(401).json({error:'Sign in as a property owner first.'});const p=jwt.verify(req.cookies.cj_session,process.env.JWT_SECRET);const ur=await pool.query('SELECT * FROM users WHERE id=$1',[p.sub]);if(!ur.rowCount)return res.status(401).json({error:'Account not found.'});if(ur.rows[0].initial_fee_paid)return res.status(409).json({error:'The initial $500 fee is already paid for this account.'});userId=ur.rows[0].id;amount=INITIAL_OWNER_FEE;description='CJ US STAYS initial owner listing and first-month fee';}
    else if(kind==='booking_fee') {const b=req.body.booking||{};const name=String(b.guestName||'').trim(),email=String(b.guestEmail||'').trim().toLowerCase(),listingId=String(b.listingId||''),start=String(b.checkIn||''),end=String(b.checkOut||''),guests=Number(b.guests);if(name.length<2||name.length>100||!/^\S+@\S+\.\S+$/.test(email)||!validDateRange(start,end)||!Number.isInteger(guests)||guests<1||guests>50)return res.status(400).json({error:'Enter valid guest details, dates and guest count.'});const lr=await pool.query("SELECT * FROM listings WHERE id=$1 AND status='published'",[listingId]);if(!lr.rowCount)return res.status(404).json({error:'This property is not available for booking.'});const l=lr.rows[0];if(guests>l.max_guests)return res.status(400).json({error:`This property allows up to ${l.max_guests} guests.`});const conflicts=await pool.query("SELECT 1 FROM bookings WHERE listing_id=$1 AND check_in < $3 AND check_out > $2 AND (status='confirmed' OR (status='pending_payment' AND created_at > NOW()-INTERVAL '15 minutes')) LIMIT 1",[listingId,start,end]);if(conflicts.rowCount)return res.status(409).json({error:'Those dates are reserved or being checked out. Please choose different dates or try again in 15 minutes.'});const nights=Math.ceil((new Date(`${end}T00:00:00Z`)-new Date(`${start}T00:00:00Z`))/86400000),total=(Number(l.nightly_price)*nights).toFixed(2);bookingId=crypto.randomUUID();const br=await pool.query("INSERT INTO bookings(id,listing_id,guest_name,guest_email,check_in,check_out,guests,nightly_price,nights,accommodation_total,booking_fee,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending_payment') RETURNING *",[bookingId,listingId,name,email,start,end,guests,l.nightly_price,nights,total,BOOKING_FEE]);booking=br.rows[0];amount=BOOKING_FEE;description='CJ US STAYS guest booking fee';}
    else return res.status(400).json({error:'Unknown payment type.'});
    const internalId=crypto.randomUUID();const order=await paypalRequest('/v2/checkout/orders','POST',{intent:'CAPTURE',purchase_units:[{reference_id:internalId,custom_id:bookingId||userId,description,amount:{currency_code:CURRENCY,value:amount}}],application_context:{brand_name:'CJ US STAYS',landing_page:'BILLING',user_action:'PAY_NOW',return_url:`${BASE_URL}/?payment=return`,cancel_url:`${BASE_URL}/?payment=cancel`}});
    await pool.query('INSERT INTO payment_orders(id,paypal_order_id,user_id,booking_id,kind,amount,currency,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[internalId,order.id,userId,bookingId,kind,amount,CURRENCY,'created']);if(bookingId)await pool.query('UPDATE bookings SET paypal_order_id=$1 WHERE id=$2',[order.id,bookingId]);res.json({id:order.id});
  }catch(e){console.error(e);res.status(e.status||500).json({error:e.message||'Could not start checkout.'});}
});
app.post('/api/paypal/capture-order',async(req,res)=>{try{const orderId=String(req.body.orderId||'');if(!orderId)return res.status(400).json({error:'Missing payment order.'});const pr=await pool.query('SELECT * FROM payment_orders WHERE paypal_order_id=$1',[orderId]);if(!pr.rowCount)return res.status(404).json({error:'Payment order not found.'});const row=pr.rows[0];if(row.status==='captured'){if(row.booking_id){const b=await pool.query('SELECT ticket_number,status FROM bookings WHERE id=$1',[row.booking_id]);return res.json({status:'COMPLETED',ticket:b.rows[0]});}return res.json({status:'COMPLETED'});}const cap=await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,'POST',{});const capture=cap.purchase_units?.[0]?.payments?.captures?.[0];if(cap.status!=='COMPLETED'||capture?.status!=='COMPLETED'||capture?.amount?.currency_code!==row.currency||Number(capture?.amount?.value).toFixed(2)!==Number(row.amount).toFixed(2))return res.status(402).json({error:'Payment could not be verified. No booking or owner access was activated.'});await pool.query("UPDATE payment_orders SET status='captured',captured_at=NOW() WHERE id=$1",[row.id]);if(row.kind==='booking_fee'){const ticket='CJ-'+crypto.randomBytes(5).toString('hex').toUpperCase();const br=await pool.query("UPDATE bookings SET status='confirmed',ticket_number=$1 WHERE id=$2 RETURNING ticket_number,guest_name,guest_email,check_in,check_out,guests,nightly_price,nights,accommodation_total,booking_fee,status",[ticket,row.booking_id]);const listing=await pool.query('SELECT title,city,owner_id FROM listings WHERE id=(SELECT listing_id FROM bookings WHERE id=$1)',[row.booking_id]);return res.json({status:'COMPLETED',ticket:{...br.rows[0],property:listing.rows[0].title,city:listing.rows[0].city}});}if(row.kind==='owner_initial'){await pool.query("UPDATE users SET initial_fee_paid=TRUE,first_paid_at=NOW(),access_until=NOW()+INTERVAL '30 days' WHERE id=$1",[row.user_id]);return res.json({status:'COMPLETED',message:'Initial $500 payment verified. First 30 days of owner access are active. Set up the $250 monthly subscription before the first month ends.'});}res.json({status:'COMPLETED'});}catch(e){console.error(e);res.status(e.status||500).json({error:e.message||'Could not verify payment.'});}});
app.post('/api/paypal/create-monthly-subscription',auth,async(req,res)=>{try{if(!req.user.initial_fee_paid)return res.status(402).json({error:'Pay the initial $500 fee first.'});if(['ACTIVE','APPROVAL_PENDING'].includes(req.user.subscription_status))return res.status(409).json({error:'A monthly subscription is already active or awaiting approval.'});if(!process.env.PAYPAL_MONTHLY_PLAN_ID||process.env.PAYPAL_MONTHLY_PLAN_ID.startsWith('replace_'))return res.status(503).json({error:'Set PAYPAL_MONTHLY_PLAN_ID to a PayPal $250 USD monthly billing plan before enabling subscriptions.'});const start=new Date(Date.now()+30*24*60*60*1000).toISOString().replace(/\.\d{3}Z$/,'Z');const sub=await paypalRequest('/v1/billing/subscriptions','POST',{plan_id:process.env.PAYPAL_MONTHLY_PLAN_ID,start_time:start,subscriber:{name:{given_name:req.user.name.split(' ')[0],surname:req.user.name.split(' ').slice(1).join(' ')||req.user.name},email_address:req.user.email},application_context:{brand_name:'CJ US STAYS',user_action:'SUBSCRIBE_NOW',return_url:`${BASE_URL}/?subscription=approved`,cancel_url:`${BASE_URL}/?subscription=cancelled`}});await pool.query("UPDATE users SET paypal_subscription_id=$1,subscription_status='APPROVAL_PENDING' WHERE id=$2",[sub.id,req.user.id]);res.json({id:sub.id,approvalUrl:sub.links?.find(l=>l.rel==='approve')?.href||null,startTime:start});}catch(e){console.error(e);res.status(e.status||500).json({error:e.message||'Could not start monthly subscription.'});}});
app.get('/api/bookings/:ticket',async(req,res)=>{try{const r=await pool.query(`SELECT b.ticket_number,b.guest_name,b.check_in,b.check_out,b.guests,b.nightly_price,b.nights,b.accommodation_total,b.booking_fee,b.status,l.title AS property,l.city,u.name AS owner_name FROM bookings b JOIN listings l ON l.id=b.listing_id JOIN users u ON u.id=l.owner_id WHERE b.ticket_number=$1`,[String(req.params.ticket).toUpperCase()]);if(!r.rowCount)return res.status(404).json({error:'Ticket not found.'});res.json({ticket:r.rows[0]});}catch(e){console.error(e);res.status(500).json({error:'Could not verify ticket.'});}});
app.get('/api/owner/bookings',auth,async(req,res)=>{try{const r=await pool.query(`SELECT b.ticket_number,b.guest_name,b.guest_email,b.check_in,b.check_out,b.guests,b.accommodation_total,b.status,l.title AS property FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE l.owner_id=$1 ORDER BY b.created_at DESC`,[req.user.id]);res.json({bookings:r.rows});}catch(e){console.error(e);res.status(500).json({error:'Could not load bookings.'});}});
app.post('/api/paypal/webhook',async(req,res)=>{try{const webhookId=process.env.PAYPAL_WEBHOOK_ID;if(!webhookId)return res.status(503).send('Webhook is not configured');const verification=await paypalRequest('/v1/notifications/verify-webhook-signature','POST',{auth_algo:req.headers['paypal-auth-algo'],cert_url:req.headers['paypal-cert-url'],transmission_id:req.headers['paypal-transmission-id'],transmission_sig:req.headers['paypal-transmission-sig'],transmission_time:req.headers['paypal-transmission-time'],webhook_id:webhookId,webhook_event:req.body});if(verification.verification_status!=='SUCCESS')return res.status(400).send('Invalid webhook signature');const event=req.body;if(event.event_type==='BILLING.SUBSCRIPTION.ACTIVATED'||event.event_type==='BILLING.SUBSCRIPTION.UPDATED'){const sid=event.resource?.id;if(sid)await pool.query("UPDATE users SET subscription_status='ACTIVE',access_until=GREATEST(COALESCE(access_until,NOW()),NOW()+INTERVAL '30 days') WHERE paypal_subscription_id=$1",[sid]);}else if(event.event_type==='BILLING.SUBSCRIPTION.CANCELLED'||event.event_type==='BILLING.SUBSCRIPTION.SUSPENDED'||event.event_type==='BILLING.SUBSCRIPTION.EXPIRED'||event.event_type==='BILLING.SUBSCRIPTION.PAYMENT.FAILED'){const sid=event.resource?.id||event.resource?.billing_agreement_id;if(sid){const state=event.event_type==='BILLING.SUBSCRIPTION.CANCELLED'?'CANCELLED':event.event_type==='BILLING.SUBSCRIPTION.EXPIRED'?'EXPIRED':event.event_type==='BILLING.SUBSCRIPTION.PAYMENT.FAILED'?'PAYMENT_FAILED':'SUSPENDED';await pool.query("UPDATE users SET subscription_status=$1 WHERE paypal_subscription_id=$2",[state,sid]);}}else if(event.event_type==='PAYMENT.SALE.COMPLETED'){const sid=event.resource?.billing_agreement_id;if(sid)await pool.query("UPDATE users SET subscription_status='ACTIVE',access_until=NOW()+INTERVAL '35 days' WHERE paypal_subscription_id=$1",[sid]);}res.sendStatus(200);}catch(e){console.error('PayPal webhook error',e);res.sendStatus(500);}});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
initDb().then(()=>app.listen(PORT,()=>console.log(`CJ US STAYS running on port ${PORT}`))).catch(e=>{console.error('Database initialization failed',e);process.exit(1);});
