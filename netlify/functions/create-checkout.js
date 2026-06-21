// POST /api/create-checkout
// Body: { plan: 'monthly' | 'annual' }
// Header: Authorization: Bearer <supabase_access_token>
//
// Creates (or reuses) a Stripe customer for this user, then returns a
// Stripe Checkout session URL for the chosen plan.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PRICE_IDS = {
  monthly: process.env.STRIPE_MONTHLY_PRICE_ID,
  annual:  process.env.STRIPE_ANNUAL_PRICE_ID,
};

const SITE_URL = process.env.SITE_URL || 'https://yourdomain.com';

function ok(body)  { return { statusCode: 200, headers: cors(), body: JSON.stringify(body) }; }
function err(msg, code = 400) { return { statusCode: code, headers: cors(), body: JSON.stringify({ error: msg }) }; }
function preflight() { return { statusCode: 204, headers: cors() }; }
function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  // Verify Supabase session
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return err('Unauthorized', 401);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return err('Unauthorized', 401);

  // Parse body
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }
  const { plan } = body;

  const priceId = PRICE_IDS[plan];
  if (!priceId) return err('Invalid plan — must be monthly or annual');

  // Get or create Stripe customer
  const { data: profile } = await sb.from('profiles').select('stripe_customer_id, stripe_status').eq('id', user.id).single();

  // If already active, return portal URL instead
  if (profile?.stripe_status === 'active' || profile?.stripe_status === 'trialing') {
    return err('Subscription already active — use customer portal to manage billing', 409);
  }

  let customerId = profile?.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email:    user.email,
      metadata: { supabase_uid: user.id },
    });
    customerId = customer.id;
    await sb.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
  }

  // Create Checkout session
  const session = await stripe.checkout.sessions.create({
    customer:             customerId,
    mode:                 'subscription',
    line_items:           [{ price: priceId, quantity: 1 }],
    success_url:          SITE_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url:           SITE_URL + '/account',
    subscription_data:    { metadata: { supabase_uid: user.id } },
    allow_promotion_codes: true,
  });

  return ok({ url: session.url });
};
