# CJ US STAYS marketplace upgrade

This is a full-stack starter package based on the current CJ US STAYS prototype. It adds server-side account management, owner listing access rules, guest bookings, ticket verification, and PayPal checkout scaffolding.

## Business rules implemented in code

- Owner first payment: **$500 USD**. Successful server-verified capture grants the first 30 days of listing access.
- Owner renewal: **$250 USD/month**, using a PayPal billing plan configured with `PAYPAL_MONTHLY_PLAN_ID`. The subscription is scheduled to start 30 days after the initial fee; the owner must approve it in PayPal.
- Guest booking fee: **$8 USD**. The booking is confirmed and a unique `CJ-...` ticket is issued only after PayPal capture is verified server-side.
- Accommodation charge: shown as the owner-set nightly price multiplied by nights; **paid directly to the property owner on arrival**, not collected by CJ US STAYS.
- Owners set property title, city, type, description, nightly price, guest limit, amenities, and an HTTPS image URL.
- Property management is blocked unless the $500 fee was paid and the first 30-day access period remains active or the subscription status is active.
- Ticket verification endpoint: `/api/bookings/:ticketNumber`.
- PayPal webhook signature verification is included for subscription status events.

## Important limitations before launch

- This is an implementation starter, **not a claim that live payments are already active**. It requires a PostgreSQL database, PayPal app credentials, a PayPal monthly billing plan, a configured webhook, and end-to-end testing.
- PayPal is the payment provider in this starter. It uses USD amounts. Live mode must not be enabled until sandbox tests pass and the PayPal business account is approved for the intended activity.
- Property photos currently use HTTPS image URLs, not direct file uploads. Add Cloudinary/S3-compatible storage before allowing direct photo upload.
- The initial implementation uses the first 30 days as the access period included in the $500 fee. The $250 monthly subscription is scheduled to start after 30 days, subject to the user's approval and PayPal plan setup.
- Subscription state depends on PayPal webhook delivery. Configure the webhook URL and test cancellation, suspension, renewal, duplicate events, and failed payments before launch.
- Add email delivery for booking tickets, password reset, owner/admin moderation, cancellation/refund workflows, privacy/terms review, anti-fraud controls, and monitoring before production.
- Ticket number confirms a platform reservation; it does not prove that the guest has paid the accommodation charge to the owner.

## Local setup

1. Install Node.js 20 or later and PostgreSQL.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` and a long random `JWT_SECRET`.
3. Create a PayPal Developer sandbox app. Set `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, and `PAYPAL_CLIENT_SECRET`.
4. Create a PayPal product and a USD monthly billing plan priced at **$250 per month**. Put the plan ID in `PAYPAL_MONTHLY_PLAN_ID`.
5. Set `APP_BASE_URL=http://localhost:3000`.
6. Run `npm install`, then `npm start`, and open `http://localhost:3000`.

## Deploy to Render

The existing Render service was created as a **Static Site**. This project needs a **Web Service** because payments, authentication, bookings and ticket issuance must run on a server. Do not replace the existing live site until the new service has passed tests.

1. Upload this project folder to a new GitHub repository or replace the current repository only after backing it up.
2. In Render, create a new **Web Service** connected to that repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Create a Render PostgreSQL database and set `DATABASE_URL` to its internal connection string where supported.
6. Add `JWT_SECRET`, `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MONTHLY_PLAN_ID`, `PAYPAL_WEBHOOK_ID`, and `APP_BASE_URL` in the Render service's Environment settings.
7. In the PayPal Developer Dashboard, configure a webhook URL: `https://YOUR-WEB-SERVICE-URL/api/paypal/webhook`. Subscribe to `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.UPDATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`, and `PAYMENT.SALE.COMPLETED`. Copy the webhook ID into Render.
8. Test owner registration, initial $500 sandbox payment, monthly subscription approval, listing creation, guest $8 sandbox payment, ticket verification, booking conflicts, cancellation/suspension and renewal. Only then plan a live-mode launch.

## API routes

- `GET /api/health`
- `GET /api/listings?q=...`
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/owner/listings`, `POST /api/owner/listings`, `GET /api/owner/bookings`
- `POST /api/paypal/create-order` (`kind: owner_initial` or `booking_fee`)
- `POST /api/paypal/capture-order`
- `POST /api/paypal/create-monthly-subscription`
- `POST /api/paypal/webhook`
- `GET /api/bookings/:ticketNumber`
