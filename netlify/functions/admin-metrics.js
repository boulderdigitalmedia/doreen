// POST /api/admin-metrics
// Body: { password }
//
// Internal-only endpoint backing admin.html — Jake's enrollments/renewals/
// cancellations dashboard. Gated by a single shared password (ADMIN_DASHBOARD_
// PASSWORD env var), not a Supabase-authenticated user, since this isn't
// buyer- or recipient-facing. Uses the service-role key (via _shared's `sb`)
// to read profiles + subscription_events directly, bypassing RLS — nothing
// here is exposed to anon/authenticated roles at the database level.
//
// Returns:
//   summary — current-state counts/plan breakdown/MRR/approximate 30-day churn
//   events  — raw subscription_events rows from the last `days` days, for the
//             dashboard to bucket into a chart client-side
//
// NOTE: subscription_events only exists from whenever schema.sql's migration
// ran, plus a one-time backfill of existing profiles at that point — see the
// comment in schema.sql. Trend charts will look thin until more history
// accumulates; that's expected, not a bug.
//
// MRR is a flat monthly-equivalent estimate for every billable profile,
// computed entirely from list prices — no Stripe API calls needed, since
// neither plan has a subscription or "upcoming invoice" to look up any
// more (both are one-time payments — see create-checkout.js):
//   annual    — ANNUAL_PRICE / 12 per billable profile.
//   gift_pack — GIFT_PACK_PRICE per billable profile (its 30-day term is
//     close enough to a month that the sticker price doubles as its own
//     monthly-equivalent, with no /12 needed).
//
// Gift add-ons and the SMS add-on are both one-time Stripe payments (see
// create-addon-checkout.js and update-sms-addon.js), not recurring line
// items, so they're added back in separately as flat assumptions: every
// currently-active add-on gift renews at $20/yr (stripe-webhook.js
// enforces exactly that) — so it contributes $20/12 a month. SMS renews
// at a flat rate per plan (stripe-webhook.js's chargeSmsAddonCarryoverOneTime):
// $20/yr for annual (→ $20/12 a month) and $2 per gift_pack term (→ $2 a
// month, no /12, same reasoning as GIFT_PACK_PRICE above).

const { sb, ok, err, preflight } = require('./_shared');

// Kept in sync with index.html / the Stripe price IDs used by
// create-checkout.js — this is the only source MRR is computed from now
// that neither plan has a real subscription/invoice to look up in Stripe.
const ANNUAL_PRICE      = 59;
const GIFT_PACK_PRICE   = 14;
const ADDON_RENEWAL_PRICE = 20; // flat renewal rate for any add-on gift
const SMS_RENEWAL_PRICE = { annual: 20, gift_pack: 2 }; // flat renewal rate per plan (see update-sms-addon.js)

const EVENTS_WINDOW_DAYS = 180;

// BRUTE-FORCE LOCKOUT: this is a single shared password with no
// per-user row to attach a counter to, so the attempt count/lockout
// lives on the single-row admin_login_attempts table instead (see
// schema.sql). Same shape as the gift-password lockout in
// verify-gift-password.js / update-gift-password.js, just against
// one shared row rather than one row per gift.
const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS   = 15 * 60 * 1000; // 15 minutes

function lockedMessage(lockedUntil) {
  const minutesLeft = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000));
  return `Too many attempts — try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  if (!process.env.ADMIN_DASHBOARD_PASSWORD) {
    return err('Admin dashboard not configured (missing ADMIN_DASHBOARD_PASSWORD)', 500);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return err('Invalid request body');
  }

  const { data: loginState } = await sb
    .from('admin_login_attempts')
    .select('attempts, locked_until')
    .eq('id', true)
    .maybeSingle();

  if (loginState && loginState.locked_until && new Date(loginState.locked_until) > new Date()) {
    return err(lockedMessage(loginState.locked_until), 429);
  }

  if (body.password !== process.env.ADMIN_DASHBOARD_PASSWORD) {
    const nextAttempts = (loginState ? loginState.attempts : 0) + 1;
    const updates = { attempts: nextAttempts };
    let responseMsg = 'Unauthorized';

    if (nextAttempts >= MAX_ADMIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + ADMIN_LOCKOUT_MS).toISOString();
      updates.attempts = 0; // the lockout window is the gate now, not the counter
      updates.locked_until = lockedUntil;
      responseMsg = lockedMessage(lockedUntil);
    }

    await sb.from('admin_login_attempts').update(updates).eq('id', true);
    return err(responseMsg, nextAttempts >= MAX_ADMIN_ATTEMPTS ? 429 : 401);
  }

  // Correct password — clear any stale counter from earlier wrong guesses.
  if (loginState && (loginState.attempts > 0 || loginState.locked_until)) {
    await sb.from('admin_login_attempts').update({ attempts: 0, locked_until: null }).eq('id', true);
  }

  const { data: profiles, error: profilesErr } = await sb
    .from('profiles')
    .select('id, stripe_status, plan');

  if (profilesErr) return err('Failed to load profiles: ' + profilesErr.message, 500);

  const statusCounts = {};
  let giftPackBillable = 0;
  let annualBillable = 0;
  // 'trialing' is no longer a status either plan can be in (neither has a
  // trial any more — see the PRICING UPDATE block in schema.sql), but is
  // left in this set defensively in case any historical row still carries
  // it rather than risk silently excluding it from billable counts.
  const billableStatuses = new Set(['active', 'trialing', 'past_due']);
  const billableProfiles = [];

  for (const p of profiles || []) {
    const status = p.stripe_status || 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (billableStatuses.has(status)) {
      if (p.plan === 'annual') annualBillable++;
      else if (p.plan === 'gift_pack') giftPackBillable++;
      billableProfiles.push(p);
    }
  }

  const billableTotal = giftPackBillable + annualBillable;

  // Flat list-price monthly-equivalent per billable profile — see the
  // comment above this file's constants for why no Stripe lookup is
  // needed for this any more.
  const baseMrr = billableProfiles.reduce((sum, p) => {
    if (p.plan === 'annual') return sum + ANNUAL_PRICE / 12;
    if (p.plan === 'gift_pack') return sum + GIFT_PACK_PRICE;
    return sum;
  }, 0);

  // Add-on gifts are one-time purchases, not subscription line items, so
  // they're not part of any subscription's upcoming invoice — estimated
  // separately here instead (see the comment above this file's constants).
  const { count: activeAddonCount } = await sb
    .from('gifts')
    .select('id', { count: 'exact', head: true })
    .eq('gift_type', 'addon')
    .eq('status', 'active');

  // Same idea for the SMS add-on — also a one-time charge now (on either
  // plan), so it's invisible to any invoice-preview lookup and has to be
  // estimated the same way add-on gifts are. Counted per plan since each
  // renews at a different flat rate (see SMS_RENEWAL_PRICE above).
  async function smsCountForPlan(plan) {
    const ids = billableProfiles.filter((p) => p.plan === plan).map((p) => p.id);
    if (ids.length === 0) return 0;
    const { count } = await sb
      .from('gifts')
      .select('id', { count: 'exact', head: true })
      .eq('sms_addon', true)
      .eq('status', 'active')
      .in('user_id', ids);
    return count || 0;
  }
  const annualSmsCount   = await smsCountForPlan('annual');
  const giftPackSmsCount = await smsCountForPlan('gift_pack');

  const addonRevenueEstimate = ((activeAddonCount || 0) * ADDON_RENEWAL_PRICE) / 12;
  const smsRevenueEstimate   = (annualSmsCount * SMS_RENEWAL_PRICE.annual) / 12 + (giftPackSmsCount * SMS_RENEWAL_PRICE.gift_pack);
  const mrr = Math.round((baseMrr + addonRevenueEstimate + smsRevenueEstimate) * 100) / 100;

  const cutoff = new Date(Date.now() - EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: events, error: eventsErr } = await sb
    .from('subscription_events')
    .select('event_type, plan, amount, created_at')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true });

  if (eventsErr) return err('Failed to load subscription_events: ' + eventsErr.message, 500);

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const cancellations30d = (events || []).filter(
    (e) => e.event_type === 'cancellation' && new Date(e.created_at).getTime() >= thirtyDaysAgo
  ).length;

  // Approximate: without a stored daily snapshot, "active 30 days ago" is
  // estimated as (currently active/billable + cancellations since then).
  // This is a simplification, not exact accounting — good enough to spot a
  // trend, not to reconcile against Stripe's own numbers.
  const churnDenominator = billableTotal + cancellations30d;
  const churnRate30d = churnDenominator > 0 ? cancellations30d / churnDenominator : null;

  return ok({
    summary: {
      statusCounts,
      giftPackBillable,
      annualBillable,
      billableTotal,
      mrr,
      activeAddonCount: activeAddonCount || 0,
      annualSmsCount,
      giftPackSmsCount,
      cancellations30d,
      churnRate30d,
    },
    events: events || [],
  });
};
