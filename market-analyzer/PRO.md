# Pro Subscription (Razorpay) — Setup Guide

The app now has a freemium "Go Pro" flow. Free users see the top 3 momentum picks and
can track up to 3 portfolio holdings; Pro (₹199/mo) unlocks everything.

## What was added

- `index.html` — "⭐ Go Pro" button, subscription modal, Razorpay Checkout, Pro-state cache,
  feature gating (momentum top-3 / portfolio 3-holding cap).
- `cloudflare-worker/worker.js` — three new API endpoints:
  - `POST /api/subscribe` — creates a Razorpay subscription for an email.
  - `POST /api/webhook` — verifies the Razorpay signature and writes Pro status to KV.
  - `GET /api/status?email=…` — returns `{ pro, plan, until }` for the frontend.
- `cloudflare-worker/wrangler.toml` — `PREMIUM` KV namespace binding.

## One-time setup (takes ~20 min)

### 1. Razorpay account
1. Sign up free at https://dashboard.razorpay.com (works with a current account).
2. **Settings → Plans → Create plan** (monthly, ₹199, billing cycle 1 month). Copy the `plan_XXXX` ID.
3. Later switch to **Live mode** and create the plan there too.

### 2. Cloudflare Worker + KV
```bash
cd cloudflare-worker

# create the KV namespace (note the returned id)
npx wrangler kv namespace create PREMIUM

# put that id in wrangler.toml under [[kv_namespaces]] id = "..."

# store secrets (paste values when prompted)
npx wrangler secret put RAZORPAY_KEY_ID          # e.g. rzp_live_XXXX
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_PLAN_ID         # plan_XXXX
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET  # set this when adding the webhook (step 3)

# (optional) your TwelveData key
npx wrangler secret put TWELVEDATA_KEY

npx wrangler deploy
```

### 3. Razorpay webhook
In the Razorpay dashboard: **Settings → Webhooks → Add webhook**
- URL: `https://premarket-live.<your-name>.workers.dev/api/webhook`
- Events: `subscription.activated`, `subscription.charged`, `subscription.cancelled`,
  `subscription.halted`, `subscription.completed`, `payment.failed`
- Copy the generated **secret** into `RAZORPAY_WEBHOOK_SECRET` (step 2), then re-deploy.

### 4. Point the app at the worker
In `index.html`, set `CONFIG.dataProxy` to your worker URL:

```js
dataProxy: 'https://premarket-live.<your-name>.workers.dev',
```

Then rebuild/redeploy the Pages site (`./deploy.sh`).

## Testing
- Use a Razorpay **test key** + UPI/card test credentials (Razorpay provides dummy test cards).
- Pay via the modal → wait a few seconds → the "Go Pro" button turns green "⭐ Pro ✓".

## Manual grants (no payment, for testing / comps)
```bash
npx wrangler kv key put --binding=PREMIUM "pro:someone@example.com" \
  '{"email":"someone@example.com","subscriptionId":"manual","plan":"plan_manual","status":"active","currentPeriodStart":1756800000,"currentPeriodEnd":1759392000,"updatedAt":1756800000}'
```
The timestamp fields are Unix seconds; set `currentPeriodEnd` in the future.

## Security notes
- Pro status is keyed by the subscriber's email; only the paying customer's own email
  unlocks their account. The webhook signature prevents spoofed grants.
- The TwelveData and Razorpay secrets never reach the browser.
- Razorpay charges are handled entirely by Razorpay Checkout — no card data touches your app.
