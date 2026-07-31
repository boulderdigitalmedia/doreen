// POST /api/create-checkout
// Body: { plan: 'annual' | 'installment' }
// Header: Authorization: Bearer <supabase_access_token>
//
// Creates (or reuses) a Stripe customer for this user, then returns a
// Stripe Checkout session URL for the chosen plan.
//
// Both plans are a 12-month committed term, not cancel-anytime, and a
// first-time buyer gets a 7-day free trial on either one — but the two
// plans get there very differently, because the annual Price in Stripe
// is a genuine ONE-TIME price, not recurring, and Stripe can only put a
// native trial (trial_period_days) on a real subscription:
//
//   installment — $4.50/mo x 12 ($54/yr total). A real recurring monthly
//                 subscription, so Stripe's own trial_period_days works
//                 natively here — no special handling needed beyond
//                 setting it.
//
//   annual      — $45/yr, still the same one-time Price as always (no
//                 need to create a new recurring Price in Stripe just
//                 for this). Since there's no subscription to hang a
//                 native trial on, the trial is self-managed instead:
//                 a trial-eligible buyer gets a Checkout session in
//                 mode 'setup', which saves their card with nothing
//                 charged and no subscription created at all.
//                 stripe-webhook.js's handleAnnualTrialSetup then sets
//                 profiles.trial_ends_at (7 days out) and
//                 stripe_status='trialing' — a separate scheduled
//                 function, process-annual-trials.js, is what actually
//                 charges the saved card once that date arrives, since
//                 nothing on Stripe's side does that automatically for
//                 a one-time price. A buyer who ISN'T trial-eligible
//                 (see below) skips all of this and is charged
//                 immediately via the original one-time-payment
//                 Checkout session, exactly as before this trial
//                 feature existed.
//
// Neither plan auto-renews forever by accident: installment gets
// `cancel_at` (see stripe-webhook.js) 12 months out from when its trial
// ends; annual was never a subscription to begin with, so a "renewal"
// always means coming back and checking out again regardless.
//
// TRIAL ELIGIBILITY — only a buyer who has never successfully enrolled
// before gets the 7-day trial (checked below via subscription_events).
// Someone renewing after a lapse is charged immediately at checkout, same
// as before this change — otherwise every renewal would also grant another
// free week, which isn't the intent.
//
// Both plans include exactly 1 gift. Additional gifts are purchased
// separately, one at a time, through create-addon-checkout.js.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PRICE_IDS = {
  annual:      process.env.STRIPE_ANNUAL_PRICE_ID,      // $45/yr — still one-time, unchanged
  installment: process.env.STRIPE_INSTALLMENT_PRICE_ID, // $4.50/mo
};

const TRIAL_DAYS = 7;
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
  const { data: profile } = await sb.from('profiles').select('id, stripe_customer_id, stripe_status').eq('id', user.id).maybeSingle();

  // If already active, return portal URL instead
  if (profile?.stripe_status === 'active' || profile?.stripe_status === 'trialing') {
    return err('Subscription already active — use customer portal to manage billing', 409);
  }

  // Trial eligibility: has this buyer ever successfully enrolled before?
  // A brand-new profiles row (or none yet at all) means they haven't —
  // eligible for the 7-day trial. Someone with a prior 'enrollment' event
  // is renewing after a lapse and is charged immediately instead, exactly
  // like before this change (see the file header comment for why).
  let priorEnrollments = 0;
  if (profile?.id) {
    const { count } = await sb
      .from('subscription_events')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', profile.id)
      .eq('event_type', 'enrollment');
    priorEnrollments = count || 0;
  }
  const trialEligible = priorEnrollments === 0;

  let customerId = profile?.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email:    user.email,
      metadata: { supabase_uid: user.id },
    });
    customerId = customer.id;
    await sb.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
  }

  let session;

  if (plan === 'installment') {
    // Real recurring subscription — Stripe's native trial works directly,
    // and Checkout saves a default payment method automatically for any
    // subscription (trialing or not), so there's nothing extra to do here
    // beyond conditionally setting trial_period_days.
    session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 'subscription',
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url:          SITE_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:           SITE_URL + '/account',
      subscription_data: {
        metadata: { supabase_uid: user.id, plan_type: plan },
        ...(trialEligible ? { trial_period_days: TRIAL_DAYS } : {}),
      },
      allow_promotion_codes: true,
    });
  } else if (trialEligible) {
    // Annual, trial-eligible — mode 'setup' saves the card with $0 due
    // and creates no subscription at all (there's no recurring Price to
    // attach one to anyway). stripe-webhook.js's handleAnnualTrialSetup
    // picks this up from checkout.session.completed (session.mode ===
    // 'setup') and starts the self-managed trial clock — see the file
    // header comment above for the rest of that flow.
    session = await stripe.checkout.sessions.create({
      customer:    customerId,
      mode:        'setup',
      // Stripe requires an explicit currency for mode:'setup' sessions —
      // unlike the subscription/payment branches above and below, there's
      // no line item price here to infer one from. 'usd' matches the
      // annual Price's own currency everywhere else in the app.
      currency:    'usd',
      success_url: SITE_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  SITE_URL + '/account',
      metadata:    { supabase_uid: user.id, plan_type: 'annual', annual_trial: 'true' },
    });
  } else {
    // Annual, NOT trial-eligible (a returning buyer renewing after a
    // lapse) — charged immediately, exactly as this plan worked before
    // the trial feature existed. No trial, no self-managed clock.
    session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 'payment',
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url:          SITE_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:           SITE_URL + '/account',
      metadata:             { supabase_uid: user.id, plan_type: 'annual' },
      payment_intent_data:  { setup_future_usage: 'off_session' },
      allow_promotion_codes: true,
    });
  }

  return ok({ url: session.url });
};
