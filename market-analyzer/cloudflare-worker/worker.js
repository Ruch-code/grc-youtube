// Cloudflare Worker — Pre-Market Analyzer API
//  1) Proxies TwelveData so your API key stays server-side (free tier ~100k req/day)
//  2) Razorpay subscription backend: create subscriptions, verify webhooks, track Pro status in KV
//
// EASIEST SETUP (skip Settings/Variables entirely):
//   1. Paste this file into a new Worker and Deploy.
//   2. In the editor, replace  MY_KEY = ''  below with your TwelveData key, then Deploy again.
//   The key lives in the worker code server-side — visitors of your app can never read it.
//
// RAZORPAY SETUP (for subscriptions / Pro gating):
//   1. Create a free account at https://dashboard.razorpay.com
//   2. Create a Plan (Settings -> Plans, or via API) and copy its ID e.g. plan_XXXXXXXXXXXX
//   3. Add encrypted secrets (Settings -> Variables -> Add -> Encrypt):
//        RAZORPAY_KEY_ID       (public key, e.g. rzp_live_XXXXXX)
//        RAZORPAY_KEY_SECRET   (private key)
//        RAZORPAY_WEBHOOK_SECRET  (generated when you add a webhook in the dashboard)
//        RAZORPAY_PLAN_ID      (the plan you created)
//   4. In Razorpay dashboard: Settings -> Webhooks -> Add webhook:
//        URL:  https://<your-worker>.workers.dev/api/webhook
//        Events: subscription.activated, subscription.charged, subscription.cancelled,
//                subscription.halted, subscription.completed, payment.failed
//   5. Create a KV namespace and link it in the dashboard (or wrangler.toml):
//        Binding name: PREMIUM
//   6. In the dashboard create the namespace. Then put the KV id into wrangler.toml:
//        [[kv_namespaces]]
//        binding = "PREMIUM"
//        id = "<your-namespace-id>"

const MY_KEY = ''; // <-- paste your TwelveData key between the quotes

const TD_BASE = 'https://api.twelvedata.com';
const RZP_BASE = 'https://api.razorpay.com/v1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Razorpay-Signature',
  'Access-Control-Max-Age': '86400'
};

const CACHE_TTL_MS = 30 * 1000;
const ALLOWED_PATHS = ['/quote', '/price', '/time_series', '/rsi', '/macd'];
// /forex: free, keyless USD→INR rate (Moneycontrol blocks automated reads, so we
// use the same free market feed via frankfurter.dev, cached 1 hour).
const FOREX_TTL_MS = 3600 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

function jsonError(message, status = 400) {
  return json({ status: 'error', message }, status);
}

async function handleForex() {
  const cacheKey = new Request('https://cache.local/forex');
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const ts = Number(cached.headers.get('X-Cached-At') || 0);
    if (Date.now() - ts < FOREX_TTL_MS) return cached;
  }
  let usdInr = null;
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?from=USD&to=INR', {
      headers: { 'User-Agent': 'market-analyzer-worker' }
    });
    const j = await r.json();
    if (j && j.rates && j.rates.INR) usdInr = j.rates.INR;
  } catch (e) {}
  if (!usdInr) return json({ status: 'error', message: 'Forex feed unavailable' }, 502);
  const resp = json({ usdInr, source: 'frankfurter.dev', fetchedAt: new Date().toISOString() });
  resp.headers.set('X-Cached-At', String(Date.now()));
  await cache.put(cacheKey, resp.clone());
  return resp;
}

// ======================= RAZORPAY HELPERS =======================

const ACTIVE_STATUSES = ['active', 'authenticated'];
const TERMINAL_STATUSES = ['cancelled', 'halted', 'completed', 'expired'];

function rzpHeaders(env) {
  const token = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  return { 'Content-Type': 'application/json', Authorization: `Basic ${token}` };
}

function kvKey(email) {
  return `pro:${String(email || '').trim().toLowerCase()}`;
}

function isPro(record, nowMs) {
  if (!record) return false;
  const status = record.status;
  if (ACTIVE_STATUSES.includes(status)) return true;
  // Grace: a cancelled/halted sub stays Pro until its paid period ends.
  if (TERMINAL_STATUSES.includes(status)) {
    return Boolean(record.currentPeriodEnd) && record.currentPeriodEnd * 1000 > nowMs;
  }
  return false;
}

function proPayload(record, nowMs) {
  return {
    pro: isPro(record, nowMs),
    plan: record ? record.plan : null,
    status: record ? record.status : null,
    since: record ? record.currentPeriodStart || null : null,
    until: record ? record.currentPeriodEnd || null : null,
    email: record ? record.email : null
  };
}

async function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

async function createSubscription(env, email) {
  const body = {
    plan_id: env.RAZORPAY_PLAN_ID,
    customer_notify: 1,
    notify_info: { notify_email: true },
    quantity: 1,
    total_count: 12,
    notes: { email: String(email).toLowerCase() },
    customer: { name: 'Pre-Market Analyzer Pro', email: String(email).toLowerCase() }
  };
  const r = await fetch(`${RZP_BASE}/subscriptions`, {
    method: 'POST',
    headers: rzpHeaders(env),
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('Razorpay create subscription error', r.status, JSON.stringify(data));
    return null;
  }
  return data;
}

// ======================= ROUTE HANDLERS =======================

async function handleSubscribe(request, env) {
  let email;
  try {
    const body = await request.json();
    email = String((body && body.email) || '').trim().toLowerCase();
  } catch (e) {
    return jsonError('Invalid JSON body');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError('A valid email is required');
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_PLAN_ID) {
    return jsonError('Razorpay is not configured on the server yet', 500);
  }
  const sub = await createSubscription(env, email);
  if (!sub || !sub.id) return jsonError('Could not create subscription — check your Razorpay config', 502);
  return json({
    key_id: env.RAZORPAY_KEY_ID,
    subscription_id: sub.id,
    plan_id: sub.plan_id,
    status: sub.status
  });
}

async function handleStatus(request, env) {
  const url = new URL(request.url);
  const email = String((url.searchParams.get('email') || '')).trim().toLowerCase();
  if (!email) return jsonError('?email= is required');
  if (!env.PREMIUM) return jsonError('KV namespace PREMIUM not bound on the server', 500);
  const record = await env.PREMIUM.get(kvKey(email), 'json');
  return json(proPayload(record, Date.now()));
}

async function handleWebhook(request, env) {
  if (!env.PREMIUM) return jsonError('KV namespace PREMIUM not bound on the server', 500);
  const rawBody = await request.text();
  const signature = request.headers.get('X-Razorpay-Signature');
  const secret = env.RAZORPAY_WEBHOOK_SECRET;

  const ok = await verifySignature(rawBody, signature, secret);
  if (!ok) return jsonError('Invalid webhook signature', 401);

  let event;
  try { event = JSON.parse(rawBody); } catch (e) { return jsonError('Invalid payload'); }

  const entity = event.payload && event.payload.subscription && event.payload.subscription.entity;
  if (!entity) return json({ received: true, skipped: 'no subscription entity' });

  const email = (entity.notes && entity.notes.email) || (entity.customer && entity.customer.email);
  const emailKey = kvKey(email || '');
  if (!emailKey) return json({ received: true, skipped: 'no email on subscription' });

  const key = emailKey;
  const existing = (await env.PREMIUM.get(key, 'json')) || {};

  const merged = Object.assign({}, existing, {
    email: String(email).toLowerCase(),
    subscriptionId: entity.id,
    plan: entity.plan_id || existing.plan || null,
    status: entity.status || existing.status,
    currentPeriodStart: entity.current_start || existing.currentPeriodStart || null,
    currentPeriodEnd: entity.current_end || existing.currentPeriodEnd || null,
    updatedAt: Date.now()
  });

  // Cancellation grace: keep Pro until the already-paid period ends.
  if (merged.status === 'cancelled' && existing.currentPeriodEnd) {
    merged.status = 'cancelled';
  }

  await env.PREMIUM.put(key, JSON.stringify(merged));
  return json({ received: true, pro: isPro(merged, Date.now()) });
}

// ======================= MAIN =======================

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    const path = url.pathname;

    // Razorpay API routes
    if (path === '/api/subscribe' && request.method === 'POST') return handleSubscribe(request, env);
    if (path === '/api/webhook' && request.method === 'POST') return handleWebhook(request, env);
    if (path === '/api/status' && request.method === 'GET') return handleStatus(request, env);

    // TwelveData proxy (existing behavior)
    if (path === '/forex') return handleForex();

    const tdPath = path === '/' || path === '' ? '/quote' : path;
    const apiKey = MY_KEY || env.TWELVEDATA_KEY;
    if (!apiKey) return json({ status: 'error', message: 'No TwelveData key configured' }, 500);
    if (!ALLOWED_PATHS.includes(tdPath)) return json({ status: 'error', message: `Unsupported endpoint ${tdPath}` }, 404);
    if (!url.searchParams.get('symbol')) return json({ status: 'error', message: 'Missing ?symbol= param' }, 400);

    // Cache key: path + query (apikey is injected here, never in the URL).
    const cacheKey = new Request(`https://cache.local${tdPath}?${url.searchParams.toString()}`);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const ts = Number(cached.headers.get('X-Cached-At') || 0);
      if (Date.now() - ts < CACHE_TTL_MS) return cached;
    }

    const params = new URLSearchParams(url.searchParams);
    params.set('apikey', apiKey);
    const upstream = await fetch(`${TD_BASE}${tdPath}?${params}`, {
      headers: { Accept: 'application/json' }
    });
    const data = await upstream.json();

    if (data && data.status === 'error') {
      console.error('TwelveData upstream error for', tdPath, url.searchParams.get('symbol'), data.message);
      return json(data, 502);
    }

    const resp = json(data);
    resp.headers.set('X-Cached-At', String(Date.now()));
    await cache.put(cacheKey, resp.clone());
    return resp;
  }
};
