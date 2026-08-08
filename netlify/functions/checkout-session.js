// GET /api/checkout-session?session_id=<Stripe Checkout Session id>
//
// success.html lands here after create-checkout.js's Checkout session
// completes (success_url is /success?session_id={CHECKOUT_SESSION_ID} —
// see that file) and calls this to get just enough transaction detail to
// fire a real purchase/conversion event into GTM's dataLayer: what plan,
// for how much, in what currency. Without this, success.html had no
// tracking beyond a bare pageview — no order value, no plan, nothing a
// GA4/Ads/Meta tag in GTM could actually use to measure paid-acquisition
// ROI or optimize a campaign toward.
//
// No auth on this endpoint — a Checkout session id is itself the
// capability here, same trust level Stripe's own success-page guidance
// assumes (it's a long, random, single-purpose token, not a guessable
// slug). Deliberately returns only the handful of fields success.html
// actually needs for tracking, not the raw session object — no customer
// email/PII, no internal Supabase ids, nothing beyond amount/currency/
// plan.
//
// stripe-webhook.js remains the sole source of truth for actually
// granting access (updating profiles.plan/stripe_status/access_term_end)
// — this endpoint doesn't touch the database at all, it only reads back
// from Stripe. A tracking call failing here (or never happening, e.g. an
// ad-blocker) can never affect whether the purchase itself took effect.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const corsHeaders = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function ok(body)  { return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(body) }; }
function err(msg, code) { return { statusCode: code || 400, headers: corsHeaders, body: JSON.stringify({ error: msg }) }; }

const PLAN_LABELS = {
  gift_pack: '30-Day Gift Pack',
  annual:    'Annual Plan',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET') return err('Method not allowed', 405);

  const sessionId = ((event.queryStringParameters && event.queryStringParameters.session_id) || '').trim();
  // Real Checkout session ids always start with "cs_" — cheap sanity
  // check before spending a Stripe API call on something that clearly
  // isn't one.
  if (!sessionId || !sessionId.startsWith('cs_')) return err('Invalid session_id');

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (e) {
    return err('Session not found', 404);
  }

  if (session.payment_status !== 'paid') {
    return err('Payment not completed', 409);
  }

  const planType = (session.metadata && session.metadata.plan_type) || 'unknown';
  const isUpgrade = !!(session.metadata && session.metadata.upgrade);

  return ok({
    transactionId: session.id,
    value:         typeof session.amount_total === 'number' ? session.amount_total / 100 : null,
    currency:      (session.currency || 'usd').toUpperCase(),
    plan:          planType,
    planLabel:     (isUpgrade ? 'Upgrade to ' : '') + (PLAN_LABELS[planType] || planType),
    upgrade:       isUpgrade,
  });
};
