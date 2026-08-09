// POST /api/create-addon-checkout
// Body: { display_name, sender_name, slug, start_date, frequency,
//         delivery_time, timezone, planned_notes_count }
// Header: Authorization: Bearer <supabase_access_token>
//
// Buys one additional gift. Pricing depends on the buyer's plan:
//
//   annual    — tiered by how much of the buyer's current 12-month term
//     is left at the moment of purchase:
//       7–12 months left → $20   4–6 months left → $15
//       1–3 months left  → $10   under 45 days   → closed (renew first)
//
//   gift_pack — a flat $14 (same as the base plan's own price), no
//     tiering. The annual tiers' 45-day minimum can never be satisfied
//     by a 30-day gift pack term, so it gets its own flat price instead
//     — available any time the gift pack's term is still active.
//
// This is a one-time Stripe Checkout payment (mode: 'payment'), not a
// recurring subscription item. The gift itself isn't created here: all
// the details the buyer entered travel as Checkout session metadata,
// and stripe-webhook.js creates the actual `gifts` row only once
// payment has actually succeeded (checkout.session.completed, mode
// 'payment'). That also means the price calculation happens here,
// server-side, at the moment of purchase — never trust a client-supplied
// tier/price.
//
// No rollover: this add-on's term_end_date is set to the base term's
// access_term_end (the fair, first-send-anchored term — see schema.sql
// — not Stripe's raw billing current_period_end) as of right now. If
// the base term later renews, stripe-webhook.js carries this add-on over
// into the new term automatically, rebilling it at a flat rate per plan
// (see ADDON_RENEWAL_PRICE there) regardless of which tier it was
// originally bought at.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SITE_URL = process.env.SITE_URL || 'https://yourdomain.com';

// Day-boundaries for the annual-plan tiers above, using 30-day months.
// Adjust here if you want different cutoffs — nothing else needs to
// change. Not used at all for gift_pack, which is a flat price instead.
const CLOSED_UNDER_DAYS = 45;
const LOW_TIER_MAX_DAYS  = 90;   // 45–90 days  → $10
const MID_TIER_MAX_DAYS  = 180;  // 91–180 days → $15
                                  // 181+ days   → $20

const TIER_PRICE_IDS = {
  high: process.env.STRIPE_ADDON_TIER_HIGH_PRICE_ID, // $20, 7–12 months left
  mid:  process.env.STRIPE_ADDON_TIER_MID_PRICE_ID,  // $15, 4–6 months left
  low:  process.env.STRIPE_ADDON_TIER_LOW_PRICE_ID,  // $10, 1–3 months left
};
const TIER_DOLLAR_AMOUNT = { high: 20, mid: 15, low: 10 };

// gift_pack add-ons reuse the same $14 Stripe Price as the base gift
// pack checkout — it's the exact same product/price, just purchased a
// second (or third...) time.
const GIFT_PACK_ADDON_PRICE_ID = process.env.STRIPE_GIFT_PACK_PRICE_ID;
const GIFT_PACK_ADDON_DOLLAR_AMOUNT = 14;

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

function tierForDaysRemaining(days) {
  if (days < CLOSED_UNDER_DAYS) return null;
  if (days <= LOW_TIER_MAX_DAYS) return 'low';
  if (days <= MID_TIER_MAX_DAYS) return 'mid';
  return 'high';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return err('Unauthorized', 401);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return err('Unauthorized', 401);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }

  const {
    display_name, sender_name, slug, start_date, frequency,
    delivery_time, timezone, planned_notes_count,
    recipient_relationship, recipient_relationship_other,
  } = body;

  if (!display_name || !slug || !start_date) {
    return err('display_name, slug, and start_date are required');
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return err('Slug must be lowercase letters, numbers and hyphens only');
  }
  const validFrequencies = ['daily', 'weekly', 'biweekly', 'monthly'];
  if (frequency && !validFrequencies.includes(frequency)) {
    return err('Invalid frequency');
  }
  // Purely a demographic signal for admin-metrics.js's aggregate
  // breakdown (see schema.sql) — silently dropped rather than rejected
  // if it doesn't match, since it's optional and never gates a purchase.
  const validRelationships = ['partner', 'parent', 'grandparent', 'child', 'sibling', 'friend', 'coworker', 'other'];
  const relationship = validRelationships.includes(recipient_relationship) ? recipient_relationship : null;
  const relationshipOther = relationship === 'other' && recipient_relationship_other
    ? String(recipient_relationship_other).slice(0, 60)
    : null;

  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('stripe_customer_id, stripe_status, plan, access_term_end')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || !profile?.stripe_customer_id) {
    return err('No active plan found — buy the base plan first', 409);
  }
  if (profile.stripe_status !== 'active') {
    return err('Your plan isn\'t active — resolve billing before adding another gift', 409);
  }
  // access_term_end (not Stripe's raw current_period_end) is the fair
  // term used for add-on pricing — anchored to the start_date chosen for
  // the included gift, capped at 30 days after signup for anyone who
  // never actually creates one (see schema.sql). It isn't set yet in
  // that latter case — there's no fair term to price against yet, so
  // add-ons just aren't purchasable until then.
  if (!profile.access_term_end) {
    return err(
      'Your term hasn\'t started yet — it begins once you set up your included gift (or automatically within 30 days of subscribing). Add-on gifts open up after that.',
      409
    );
  }

  const termEnd = new Date(profile.access_term_end);
  const daysRemaining = Math.ceil((termEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

  let priceId, dollarAmount;

  if (profile.plan === 'gift_pack') {
    // Flat $14, no tiering — just needs the gift pack's own term to
    // still be active (see file header comment for why the annual tiers
    // don't apply here at all).
    if (daysRemaining <= 0) {
      return err(
        'Your 30-Day Gift Pack has ended — buy another gift pack (or upgrade to annual) to add another gift.',
        409
      );
    }
    priceId = GIFT_PACK_ADDON_PRICE_ID;
    dollarAmount = GIFT_PACK_ADDON_DOLLAR_AMOUNT;
    if (!priceId) return err('Add-on pricing isn\'t configured for the gift pack plan', 500);
  } else {
    const tier = tierForDaysRemaining(daysRemaining);
    if (!tier) {
      return err(
        `Your current term ends in ${Math.max(daysRemaining, 0)} day(s) — too soon to add another gift. ` +
        `Renew your plan first, then add the gift under the new term.`,
        409
      );
    }
    priceId = TIER_PRICE_IDS[tier];
    dollarAmount = TIER_DOLLAR_AMOUNT[tier];
    if (!priceId) return err(`Add-on pricing isn't configured for the ${tier} tier`, 500);
  }

  // Fail before charging anyone, not after — a slug collision here would
  // otherwise mean a successful payment with nowhere for it to land.
  const { data: existing } = await sb.from('gifts').select('id').eq('slug', slug).maybeSingle();
  if (existing) return err('That slug is already taken', 409);

  const session = await stripe.checkout.sessions.create({
    customer:    profile.stripe_customer_id,
    mode:        'payment',
    line_items:  [{ price: priceId, quantity: 1 }],
    success_url: SITE_URL + '/account?addon=success',
    cancel_url:  SITE_URL + '/account',
    // Same as the base-plan checkout in create-checkout.js — shows a
    // "promotion code" field on the Stripe-hosted page. Codes still have
    // to actually exist (Stripe Dashboard → Product catalog → Coupons /
    // Promotion codes) for there to be anything to redeem; this just
    // turns the field on.
    allow_promotion_codes: true,
    metadata: {
      gift_addon:          'true',
      supabase_uid:        user.id,
      slug,
      display_name,
      sender_name:         sender_name || 'Your Favorite',
      start_date,
      frequency:           frequency || 'daily',
      delivery_time:       delivery_time || '08:00:00',
      timezone:            timezone || 'Pacific/Auckland',
      planned_notes_count: planned_notes_count != null ? String(planned_notes_count) : '',
      term_end_date:       termEnd.toISOString(),
      tier_price:          String(dollarAmount),
      recipient_relationship:       relationship || '',
      recipient_relationship_other: relationshipOther || '',
    },
  });

  return ok({ url: session.url });
};
