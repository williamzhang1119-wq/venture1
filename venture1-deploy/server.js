'use strict';

/**
 * Venture1 — Express app with Stripe Billing, Invoicing, and Tax.
 *
 * Keys never live in source; set STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY
 * (prefer restricted keys rk_*) via your secrets vault or environment.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Stripe = require('stripe');

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {
  /* dotenv is optional */
}

const PORT = Number(process.env.PORT) || 3000;
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ENTITLEMENTS_PATH = path.join(__dirname, 'data', 'entitlements.json');

const stripeSecret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
const stripePublishable = process.env.STRIPE_PUBLISHABLE_KEY || '';
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

const PRICE_MONTHLY = process.env.STRIPE_PRICE_FAMILY_MONTHLY || '';
const PRICE_YEARLY = process.env.STRIPE_PRICE_FAMILY_YEARLY || '';

const stripe = stripeSecret
  ? new Stripe(stripeSecret, {
      apiVersion: '2026-08-26.dahlia',
      appInfo: { name: 'Venture1', url: 'https://venture1-ai.com', version: '1.0.0' },
    })
  : null;

/** Cached tax readiness: automatic_tax needs active Tax Settings + registrations. */
let taxReadyCache = { checkedAt: 0, ready: false, reason: 'unchecked' };

async function isAutomaticTaxReady() {
  if (!stripe) return false;
  const forced = process.env.STRIPE_AUTOMATIC_TAX;
  if (forced === '0' || forced === 'false') {
    return false;
  }
  if (forced === '1' || forced === 'true') {
    return true;
  }
  const now = Date.now();
  if (now - taxReadyCache.checkedAt < 60_000) {
    return taxReadyCache.ready;
  }
  try {
    const settings = await stripe.tax.settings.retrieve();
    const ready = settings.status === 'active';
    taxReadyCache = {
      checkedAt: now,
      ready,
      reason: ready ? 'active' : `tax_settings_${settings.status}`,
    };
  } catch (err) {
    taxReadyCache = {
      checkedAt: now,
      ready: false,
      reason: err.statusCode === 403 ? 'tax_settings_forbidden' : err.message,
    };
  }
  if (!taxReadyCache.ready) {
    console.warn(
      'Stripe Tax not ready (',
      taxReadyCache.reason,
      ') — Checkout will run without automatic_tax until Tax Settings + registrations are configured.'
    );
  }
  return taxReadyCache.ready;
}

function ensureDataDir() {
  const dir = path.dirname(ENTITLEMENTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(ENTITLEMENTS_PATH)) fs.writeFileSync(ENTITLEMENTS_PATH, '{}', 'utf8');
}

function readEntitlements() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(ENTITLEMENTS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeEntitlements(map) {
  ensureDataDir();
  fs.writeFileSync(ENTITLEMENTS_PATH, JSON.stringify(map, null, 2));
}

function upsertEntitlement(customerId, patch) {
  const map = readEntitlements();
  map[customerId] = { ...(map[customerId] || {}), ...patch, updatedAt: new Date().toISOString() };
  writeEntitlements(map);
  return map[customerId];
}

function findEntitlementByEmail(email) {
  if (!email) return null;
  const map = readEntitlements();
  const needle = String(email).trim().toLowerCase();
  return Object.values(map).find((e) => (e.email || '').toLowerCase() === needle) || null;
}

function randomIntegrationSuffix() {
  return crypto.randomBytes(4).toString('hex').slice(0, 8);
}

function requireStripe(res) {
  if (!stripe) {
    res.status(503).json({
      error: 'stripe_not_configured',
      message: 'STRIPE_SECRET_KEY is not set. Add it to your environment secrets.',
    });
    return false;
  }
  return true;
}

const app = express();

// Webhook must receive the raw body for signature verification.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!requireStripe(res)) return;

  let event = req.body;
  if (webhookSecret) {
    const sig = req.headers['stripe-signature'];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    console.warn('STRIPE_WEBHOOK_SECRET unset — accepting unverified webhook payloads (dev only)');
    event = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? JSON.parse(req.body) : req.body;
  }

  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'webhook_handler_failed' });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stripe/config', async (_req, res) => {
  const taxReady = await isAutomaticTaxReady();
  res.json({
    publishableKey: stripePublishable || null,
    configured: Boolean(stripe && PRICE_MONTHLY && PRICE_YEARLY),
    automaticTax: taxReady,
    prices: {
      familyMonthly: PRICE_MONTHLY || null,
      familyYearly: PRICE_YEARLY || null,
    },
    appBaseUrl: APP_BASE_URL,
  });
});

app.get('/api/billing/status', async (req, res) => {
  const email = (req.query.email || '').toString().trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email_required' });

  const local = findEntitlementByEmail(email);
  if (local) {
    return res.json({
      email,
      status: local.status || 'none',
      plan: local.plan || null,
      customerId: local.customerId || null,
      subscriptionId: local.subscriptionId || null,
      imageCreation: local.status === 'active' || local.status === 'trialing',
    });
  }

  if (!stripe) {
    return res.json({ email, status: 'none', imageCreation: false });
  }

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    const customer = customers.data[0];
    if (!customer) {
      return res.json({ email, status: 'none', imageCreation: false });
    }
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 5,
    });
    const sub = subs.data.find((s) => ['active', 'trialing', 'past_due'].includes(s.status));
    const status = sub ? sub.status : 'none';
    const ent = upsertEntitlement(customer.id, {
      customerId: customer.id,
      email,
      status,
      subscriptionId: sub ? sub.id : null,
      plan: sub?.items?.data?.[0]?.price?.id || null,
    });
    return res.json({
      email,
      status: ent.status,
      plan: ent.plan,
      customerId: ent.customerId,
      subscriptionId: ent.subscriptionId,
      imageCreation: ent.status === 'active' || ent.status === 'trialing',
    });
  } catch (err) {
    console.error('billing status error:', err);
    return res.status(500).json({ error: 'billing_status_failed', message: err.message });
  }
});

app.post('/api/checkout/session', async (req, res) => {
  if (!requireStripe(res)) return;

  const { priceId, email, interval } = req.body || {};
  let resolvedPrice = priceId;
  if (!resolvedPrice) {
    if (interval === 'year') resolvedPrice = PRICE_YEARLY;
    else resolvedPrice = PRICE_MONTHLY;
  }
  if (!resolvedPrice) {
    return res.status(400).json({
      error: 'price_not_configured',
      message: 'Set STRIPE_PRICE_FAMILY_MONTHLY / STRIPE_PRICE_FAMILY_YEARLY (run npm run stripe:setup).',
    });
  }

  try {
    const taxReady = await isAutomaticTaxReady();
    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: resolvedPrice, quantity: 1 }],
      success_url: `${APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/pricing.html`,
      // Do NOT set payment_method_types — enable dynamic payment methods in Dashboard.
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      subscription_data: {
        metadata: {
          venture1_plan: 'family',
          product: 'venture1',
        },
      },
      metadata: {
        venture1_plan: 'family',
      },
      integration_identifier: `venture1_family_checkout_${randomIntegrationSuffix()}`,
    };

    if (taxReady) {
      sessionParams.automatic_tax = { enabled: true };
    }

    if (email) {
      // New customers: pass email only. customer_update requires an existing customer id.
      sessionParams.customer_email = String(email).trim().toLowerCase();
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('Checkout session error:', err);
    return res.status(500).json({ error: 'checkout_failed', message: err.message });
  }
});

app.post('/api/billing/portal', async (req, res) => {
  if (!requireStripe(res)) return;

  const email = (req.body?.email || '').toString().trim().toLowerCase();
  const customerId = (req.body?.customerId || '').toString().trim();
  if (!email && !customerId) {
    return res.status(400).json({ error: 'email_or_customer_required' });
  }

  try {
    let customer = customerId;
    if (!customer) {
      const list = await stripe.customers.list({ email, limit: 1 });
      if (!list.data[0]) {
        return res.status(404).json({ error: 'customer_not_found' });
      }
      customer = list.data[0].id;
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${APP_BASE_URL}/pricing.html`,
    });
    return res.json({ url: portal.url });
  } catch (err) {
    console.error('Portal session error:', err);
    return res.status(500).json({ error: 'portal_failed', message: err.message });
  }
});

app.get('/api/checkout/session/:id', async (req, res) => {
  if (!requireStripe(res)) return;
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id, {
      expand: ['line_items.data.taxes', 'subscription', 'invoice', 'customer'],
    });
    return res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_details?.email || session.customer_email,
      subscription_id: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
      amount_total: session.amount_total,
      currency: session.currency,
      tax: session.total_details?.amount_tax ?? null,
      automatic_tax: session.automatic_tax,
    });
  } catch (err) {
    return res.status(404).json({ error: 'session_not_found', message: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'server_misconfigured', message: 'ANTHROPIC_API_KEY is not set.' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'proxy_error', message: err.message });
  }
});

async function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
        console.log('Skipping fulfillment; payment_status=', session.payment_status);
        break;
      }
      await fulfillCheckoutSession(session);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      let email = null;
      if (customerId) {
        try {
          const customer = await stripe.customers.retrieve(customerId);
          email = !customer.deleted ? customer.email : null;
        } catch (_) {
          /* ignore */
        }
      }
      upsertEntitlement(customerId, {
        customerId,
        email,
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
        subscriptionId: sub.id,
        plan: sub.items?.data?.[0]?.price?.id || null,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      });
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        upsertEntitlement(customerId, {
          customerId,
          email: invoice.customer_email || undefined,
          lastInvoiceId: invoice.id,
          lastInvoiceStatus: invoice.status,
          lastInvoicePaidAt: new Date().toISOString(),
        });
      }
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        upsertEntitlement(customerId, {
          customerId,
          email: invoice.customer_email || undefined,
          status: 'past_due',
          lastInvoiceId: invoice.id,
          lastInvoiceStatus: invoice.status,
        });
      }
      console.warn('Invoice payment failed', invoice.id, invoice.customer_email);
      break;
    }
    default:
      break;
  }
}

async function fulfillCheckoutSession(session) {
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const subscriptionId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  const email = session.customer_details?.email || session.customer_email || null;

  let status = 'active';
  let plan = null;
  if (subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    status = sub.status;
    plan = sub.items?.data?.[0]?.price?.id || null;
  }

  if (customerId) {
    upsertEntitlement(customerId, {
      customerId,
      email,
      status,
      subscriptionId,
      plan,
      checkoutSessionId: session.id,
    });
  }
  console.log('Fulfilled checkout', session.id, 'customer', customerId, 'email', email);
}

app.listen(PORT, () => {
  console.log(`Venture 1 running on port ${PORT}`);
  console.log(
    `Stripe: ${stripe ? 'configured' : 'NOT configured'} | prices monthly=${Boolean(PRICE_MONTHLY)} yearly=${Boolean(PRICE_YEARLY)}`
  );
});
