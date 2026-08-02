// POST /api/create-checkout
// Body: { plan: 'annual' | 'gift_pack' | 'upgrade' }
// Header: Authorization: Bearer <supabase_access_token>
//
// Creates (or reuses) a Stripe customer for this user, then returns a
// Stripe Checkout session URL for the chosen plan.
//
// Every plan here is a genuine ONE-TIME Stripe price, charged immediately
// at checkout — there is no free trial and no recurring subscription
// anywhere in this file any more (that changed along with the pricing
// overhaul that replaced the old $4.50/mo "installment" plan — see the
// PRICING UPDATE block in schema.sql):
//
//   gift_pack — $14, a single one-time payment covering a 30-day term.
//               Includes exactly 1 gift, same as annual. Does not
//               auto-renew — buying another gift pack (or upgrading, see
//               below) after it lapses is a brand new purchase.
//
//   annual    — $59/yr, a single one-time payment covering a 365-day
//               term. Doesn't auto-renew either — a returning buyer just
//               checks out again for a new term.
//
//   upgrade   — $45, ONLY available to a buyer whose current plan is
//               'gift_pack' and whose 30-day term hasn't lapsed yet (see
//               eligibility check below). Converts them straight to a
//               fresh 365-day annual term for $45 instead of the full
//               $59 — effectively crediting the $14 they already paid
//               for the gift pack. stripe-webhook.js's
//               handleUpgradeToAnnual is what actually applies this once
//               payment succeeds.
//
// Both real plans (not the upgrade) include exactly 1 gift. Additional
// gifts are purchased separately, one at a time, through
// create-addon-checkout.js.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PRICE_IDS = {
  annual:    process.env.STRIPE_ANNUAL_PRICE_ID,    // $59, one-time
  gift_pack: process.env.STRIPE_GIFT_PACK_PRICE_ID,  // $14, one-time
  upgrade:   process.env.STRIPE_UPGRADE_PRICE_ID,    // $45, one-time — gift_pack → annual only
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

  if (plan === 'monthly' || plan === 'installment') {
    return err('The old cancel-anytime monthly / $4.50-installment plan has been retired — use "gift_pack" ($14, 30 days) or "annual" ($59/yr) instead.', 410);
  }

  const priceId = PRICE_IDS[plan];
  if (!priceId) return err('Invalid plan — must be "annual", "gift_pack", or "upgrade"');

  const { data: profile } = await sb
    .from('profiles')
    .select('id, stripe_customer_id, stripe_status, plan, access_term_end')
    .eq('id', user.id)
    .maybeSingle();

  if (plan === 'upgrade') {
    // Only a currently-active gift_pack buyer, still within their 30-day
    // term, gets the discounted $45 upgrade price — see the file header
    // comment for why. Anyone else (no gift pack at all, or one that's
    // already lapsed) has to pay full price for a fresh annual term
    // instead, via plan: 'annual'.
    const stillWithinTerm = profile?.access_term_end && new Date(profile.access_term_end).getTime() > Date.now();
    if (!profile || profile.plan !== 'gift_pack' || profile.stripe_status !== 'active' || !stillWithinTerm) {
      return err('The $45 upgrade price is only available while your 30-Day Gift Pack is still active. Once it lapses, a new annual term is $59.', 409);
    }
  } else if (profile?.stripe_status === 'active') {
    // Already an active buyer on a real plan — nothing to check out for
    // (upgrading from gift_pack to annual goes through plan: 'upgrade'
    // above instead, not this branch).
    return err('You already have an active plan — use plan "upgrade" to move from the gift pack to annual, or the customer portal to manage billing', 409);
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

  // Every plan is a one-time Checkout Session now — no more trial /
  // subscription branching. setup_future_usage: 'off_session' saves the
  // card as the customer's default payment method (a one-time session
  // doesn't do this on its own), which every later off-session charge
  // for this buyer needs — add-on gifts, the SMS add-on, and (for
  // gift_pack/annual) a future renewal or upgrade checkout reusing the
  // saved card at Stripe's discretion.
  const planType = plan === 'upgrade' ? 'annual' : plan;
  const session = await stripe.checkout.sessions.create({
    customer:             customerId,
    mode:                 'payment',
    line_items:           [{ price: priceId, quantity: 1 }],
    success_url:          SITE_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url:           SITE_URL + '/account',
    metadata:             {
      supabase_uid: user.id,
      plan_type:    planType,
      ...(plan === 'upgrade' ? { upgrade: 'true' } : {}),
    },
    payment_intent_data:   { setup_future_usage: 'off_session' },
    allow_promotion_codes: true,
  });

  return ok({ url: session.url });
};
