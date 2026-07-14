// POST /api/create-checkout
// Body: { plan: 'annual' | 'installment' }
// Header: Authorization: Bearer <supabase_access_token>
//
// Creates (or reuses) a Stripe customer for this user, then returns a
// Stripe Checkout session URL for the chosen plan.
//
// Both plans are a 12-month committed term, not cancel-anytime — but
// they're structured very differently in Stripe:
//   annual      — $45 charged once, as a genuine ONE-TIME payment (mode
//                 'payment', not 'subscription'). There is no underlying
//                 Stripe subscription for annual buyers at all, so it
//                 cannot auto-renew even accidentally — continuing past
//                 the 12-month term always means coming back and
//                 checking out again (handled as a 'renewal' the same
//                 way as an installment restart — see stripe-webhook.js).
//                 Because there's no subscription to attach a default
//                 payment method to automatically, this checkout sets
//                 setup_future_usage so the card IS saved to the
//                 customer — required for any later off-session charges
//                 (add-on gifts, the one-time SMS fee, renewal add-on
//                 carryover) to work at all for an annual buyer.
//   installment — $4.50/mo x 12 ($54/yr total). This is a normal
//                 recurring monthly subscription under the hood, but
//                 stripe-webhook.js sets `cancel_at` on it (12 months
//                 from creation) once it's live, so it stops on its own
//                 after the 12th payment instead of auto-renewing
//                 forever at $4.50/mo. Continuing past that point means
//                 going through checkout again for a fresh term — see
//                 the renewal-carryover logic in stripe-webhook.js.
//
// Both plans include exactly 1 gift. Additional gifts are purchased
// separately, one at a time, through create-addon-checkout.js.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PRICE_IDS = {
  annual:      process.env.STRIPE_ANNUAL_PRICE_ID,      // $45/yr
  installment: process.env.STRIPE_INSTALLMENT_PRICE_ID, // $4.50/mo
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

  if (plan === 'monthly') {
    return err('The old cancel-anytime monthly plan has been retired — use "installment" for the new $4.50/mo, 12-month-term plan.', 410);
  }

  const priceId = PRICE_IDS[plan];
  if (!priceId) return err('Invalid plan — must be "annual" or "installment"');

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

  // Annual is a one-time payment — no subscription object exists for it
  // at all, so plan_type has to travel as session-level metadata instead
  // of subscription_data.metadata, and setup_future_usage is required to
  // save the card for later off-session charges (see the comment above).
  // Installment stays a real recurring subscription; plan_type there is
  // how stripe-webhook.js knows to apply cancel_at — it isn't derivable
  // from the price alone once there are promotion codes/price changes in
  // play.
  const session = plan === 'annual'
    ? await stripe.checkout.sessions.create({
        customer:             customerId,
        mode:                 'payment',
        line_items:           [{ price: priceId, quantity: 1 }],
        success_url:          SITE_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url:           SITE_URL + '/account',
        metadata:             { supabase_uid: user.id, plan_type: 'annual' },
        payment_intent_data:  { setup_future_usage: 'off_session' },
        allow_promotion_codes: true,
      })
    : await stripe.checkout.sessions.create({
        customer:             customerId,
        mode:                 'subscription',
        line_items:           [{ price: priceId, quantity: 1 }],
        success_url:          SITE_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url:           SITE_URL + '/account',
        subscription_data:    { metadata: { supabase_uid: user.id, plan_type: plan } },
        allow_promotion_codes: true,
      });

  return ok({ url: session.url });
};
