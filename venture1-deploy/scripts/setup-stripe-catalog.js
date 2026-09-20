/**
 * Provisions Venture1 Stripe catalog + Tax + Customer Portal for Billing/Invoicing.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=rk_test_... node scripts/setup-stripe-catalog.js
 *
 * Tax code candidate (confirm with your tax advisor):
 *   txcd_10105001 — AIaaS Cloud Based — Personal Use
 *   See https://docs.stripe.com/tax/ai and https://docs.stripe.com/api/tax_codes
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const SECRET = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY;
if (!SECRET) {
  console.error('Set STRIPE_SECRET_KEY (or STRIPE_API_KEY) before running setup.');
  process.exit(1);
}

const stripe = new Stripe(SECRET);
const TAX_CODE = process.env.STRIPE_PRODUCT_TAX_CODE || 'txcd_10105001';
const LOOKUP_MONTHLY = 'venture1_family_monthly';
const LOOKUP_YEARLY = 'venture1_family_yearly';

async function ensureProduct() {
  try {
    const existing = await stripe.products.search({
      query: "metadata['venture1_plan']:'family' AND active:'true'",
      limit: 1,
    });
    if (existing.data[0]) {
      console.log('Using existing product', existing.data[0].id);
      return existing.data[0];
    }
  } catch (err) {
    // Search may be unavailable on limited keys; fall through to list/create.
    console.warn('Product search skipped:', err.message.slice(0, 120));
  }

  const listed = await stripe.products.list({ limit: 100, active: true });
  const found = listed.data.find((p) => p.metadata?.venture1_plan === 'family');
  if (found) {
    console.log('Using existing product', found.id);
    return found;
  }

  const product = await stripe.products.create({
    name: 'Venture1 Family',
    description:
      'Safe, affordable AI learning companion for kids — Family plan with image creation and parent controls.',
    tax_code: TAX_CODE,
    metadata: {
      venture1_plan: 'family',
      business: 'venture1-ai.com',
    },
  });
  console.log('Created product', product.id, 'tax_code', TAX_CODE);
  return product;
}

async function ensurePrice(productId, { nickname, unitAmount, interval, lookupKey }) {
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], expand: ['data.product'], limit: 1 });
  if (found.data[0]) {
    console.log('Using existing price', found.data[0].id, lookupKey);
    return found.data[0];
  }

  const price = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: unitAmount,
    nickname,
    lookup_key: lookupKey,
    tax_behavior: 'exclusive',
    recurring: { interval },
    metadata: { venture1_plan: 'family', interval },
  });
  console.log('Created price', price.id, lookupKey, `$${(unitAmount / 100).toFixed(2)}/${interval}`);
  return price;
}

async function ensureTaxSettings() {
  try {
    const settings = await stripe.tax.settings.retrieve();
    if (settings.status === 'active') {
      console.log('Tax settings already active');
      return settings;
    }

    // Sandbox bootstrap only — replace with your real head-office address in live mode.
    const updated = await stripe.tax.settings.update({
      defaults: {
        tax_code: TAX_CODE,
        tax_behavior: 'exclusive',
      },
      head_office: {
        address: {
          line1: '354 Oyster Point Blvd',
          city: 'South San Francisco',
          state: 'CA',
          postal_code: '94080',
          country: 'US',
        },
      },
    });
    console.log('Tax settings status:', updated.status);
    return updated;
  } catch (err) {
    if (err.statusCode === 403) {
      console.warn(
        'Tax settings unavailable on this key (claim the sandbox or use a full test key). automatic_tax will collect $0 until Tax Settings + registrations are configured.'
      );
      return null;
    }
    throw err;
  }
}

async function ensureSandboxRegistration() {
  try {
    const regs = await stripe.tax.registrations.list({ status: 'active', limit: 10 });
    if (regs.data.length) {
      console.log(
        'Active tax registrations:',
        regs.data.map((r) => `${r.country}/${r.state || r.country_options?.us?.state || ''}`).join(', ')
      );
      return regs.data;
    }

    // Example sandbox registration so automatic_tax can calculate in tests.
    // This does NOT register you with a tax authority — record only jurisdictions
    // where you are already registered (or have your advisor confirm).
    const reg = await stripe.tax.registrations.create({
      country: 'US',
      country_options: {
        us: {
          state: 'CA',
          type: 'state_sales_tax',
        },
      },
      active_from: 'now',
    });
    console.log('Created sandbox tax registration', reg.id, 'US/CA (example only)');
    return [reg];
  } catch (err) {
    if (err.statusCode === 403) {
      console.warn('Tax registrations unavailable on this key — skip for now.');
      return [];
    }
    throw err;
  }
}

async function ensureCustomerPortal(productId, priceIds) {
  try {
    const configs = await stripe.billingPortal.configurations.list({ limit: 10 });
    const active = configs.data.find((c) => c.active);
    if (active) {
      console.log('Using existing Customer Portal config', active.id);
      return active;
    }

    // Start with cancel + invoice history. Enable plan switching in Dashboard
    // (Features → Subscription update) once both Family prices exist.
    const config = await stripe.billingPortal.configurations.create({
      business_profile: {
        headline: 'Manage your Venture1 Family subscription',
        privacy_policy_url: 'https://venture1-ai.com/privacy',
        terms_of_service_url: 'https://venture1-ai.com/terms',
      },
      features: {
        customer_update: {
          enabled: true,
          allowed_updates: ['email', 'address', 'tax_id'],
        },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end',
        },
        subscription_update: {
          enabled: false,
        },
      },
    });
    console.log('Created Customer Portal config', config.id);
    console.log(
      'Tip: enable subscription_update in Dashboard with product',
      productId,
      'prices',
      priceIds.join(', ')
    );
    return config;
  } catch (err) {
    if (err.statusCode === 403) {
      console.warn('Customer Portal config unavailable on this key — configure in Dashboard after claiming the sandbox.');
      return null;
    }
    throw err;
  }
}

async function writeEnvHints(monthly, yearly, productId) {
  const hintPath = path.join(__dirname, '..', '.env.stripe.generated');
  const product = productId || (typeof monthly.product === 'string' ? monthly.product : monthly.product?.id);
  const body = [
    `# Generated by scripts/setup-stripe-catalog.js — do not commit secrets`,
    `STRIPE_PRICE_FAMILY_MONTHLY=${monthly.id}`,
    `STRIPE_PRICE_FAMILY_YEARLY=${yearly.id}`,
    `STRIPE_PRODUCT_FAMILY=${product}`,
    `STRIPE_PRODUCT_TAX_CODE=${TAX_CODE}`,
    '',
  ].join('\n');
  fs.writeFileSync(hintPath, body, { mode: 0o600 });
  console.log('Wrote', hintPath);
}

async function main() {
  const product = await ensureProduct();
  const monthly = await ensurePrice(product.id, {
    nickname: 'Family Monthly',
    unitAmount: 999,
    interval: 'month',
    lookupKey: LOOKUP_MONTHLY,
  });
  const yearly = await ensurePrice(product.id, {
    nickname: 'Family Yearly',
    unitAmount: 7900,
    interval: 'year',
    lookupKey: LOOKUP_YEARLY,
  });

  await ensureTaxSettings();
  await ensureSandboxRegistration();
  await ensureCustomerPortal(product.id, [monthly.id, yearly.id]);
  await writeEnvHints(monthly, yearly, product.id);

  console.log('\nNext steps:');
  console.log('1. Copy price IDs into your environment / secrets vault');
  console.log('2. Confirm tax code', TAX_CODE, 'with your tax advisor');
  console.log('3. Add live-mode tax registrations before going live');
  console.log('4. Start webhook forwarding: stripe listen --forward-to localhost:3000/api/stripe/webhook');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
