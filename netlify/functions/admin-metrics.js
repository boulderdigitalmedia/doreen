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
// MRR is computed differently by plan, since the annual plan is now a
// one-time payment with no subscription behind it (see
// create-checkout.js) — there's no "upcoming invoice" to look up for it
// at all:
//   installment — actual upcoming Stripe invoice (retrieveUpcoming), not
//     a flat list price — this correctly reflects the recurring SMS
//     add-on (still a real line item on the subscription). Only falls
//     back to list price (INSTALLMENT_PRICE below) for the rare profile
//     where the Stripe lookup genuinely fails or the subscription id on
//     file turns out to be stale — see mrrFallbackCount in the response.
//   annual — a flat ANNUAL_PRICE/12 monthly-equivalent for every
//     billable annual profile. This isn't a fallback or an
//     approximation of something more precise elsewhere — it's simply
//     how the math works for a flat one-time payment with no discounts
//     to look up, so annual profiles are deliberately excluded from
//     mrrFallbackCount rather than inflating it.
//
// Gift add-ons and the annual plan's SMS add-on are both one-time Stripe
// payments (see create-addon-checkout.js and update-sms-addon.js), not
// recurring subscription items, so neither shows up in any invoice-
// preview figure above. addonRevenueEstimate and annualSmsRevenueEstimate
// add them back in as flat assumptions: every currently-active add-on
// gift renews at $20/yr (stripe-webhook.js enforces exactly that), and
// every annual-plan gift with SMS on renews at the same $20/yr rate
// (chargeSmsAddonCarryoverOneTime) — so each contributes $20/12 a month,
// regardless of what tier it was originally bought at. Installment-plan
// SMS is NOT included in either estimate — it's still a real recurring
// subscription item, so it's already counted in that profile's upcoming-
// invoice figure above.

const Stripe = require('stripe');
const { sb, ok, err, preflight } = require('./_shared');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Fallback-only list prices — kept in sync with index.html / the Stripe
// price IDs used by create-checkout.js. Real MRR comes from Stripe itself;
// these are just what a profile falls back to if that lookup fails.
const INSTALLMENT_PRICE = 4.5;
const ANNUAL_PRICE      = 45;
const ADDON_RENEWAL_PRICE = 20; // flat renewal rate for any add-on gift
const SMS_ONE_TIME_ANNUAL_PRICE = 20; // flat renewal rate for annual-plan SMS (see stripe-webhook.js)

const EVENTS_WINDOW_DAYS = 180;

// Netlify functions have a request timeout, so don't fire off unlimited
// concurrent Stripe calls for a very large subscriber base — process in
// small batches instead. Fine either way for the scale this app runs at.
const STRIPE_BATCH_SIZE = 10;

async function mapWithConcurrency(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

// Actual next-invoice amount for an installment subscription, converted
// to a monthly-equivalent figure. Returns null (rather than throwing) on
// any failure so the caller can fall back to list price for just that
// one profile. Never called for annual profiles — they have no
// subscription to look up (see the comment above).
async function monthlyRevenueForSubscription(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  try {
    const upcoming = await stripe.invoices.retrieveUpcoming({ subscription: stripeSubscriptionId });
    return (upcoming.amount_due ?? upcoming.total ?? 0) / 100;
  } catch (e) {
    console.error('Upcoming invoice lookup failed for', stripeSubscriptionId, e.message);
    return null;
  }
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

  if (body.password !== process.env.ADMIN_DASHBOARD_PASSWORD) {
    return err('Unauthorized', 401);
  }

  const { data: profiles, error: profilesErr } = await sb
    .from('profiles')
    .select('id, stripe_status, plan, stripe_subscription_id');

  if (profilesErr) return err('Failed to load profiles: ' + profilesErr.message, 500);

  const statusCounts = {};
  let monthlyBillable = 0;
  let annualBillable = 0;
  const billableStatuses = new Set(['active', 'trialing', 'past_due']);
  const billableProfiles = [];

  for (const p of profiles || []) {
    const status = p.stripe_status || 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (billableStatuses.has(status)) {
      if (p.plan === 'annual') annualBillable++;
      else if (p.plan === 'installment') monthlyBillable++;
      billableProfiles.push(p);
    }
  }

  const billableTotal = monthlyBillable + annualBillable;

  // Real MRR for installment profiles: each one's actual upcoming Stripe
  // invoice, normalized to a monthly figure. Falls back to flat list
  // price only for the profiles where that lookup didn't work (a stale/
  // missing subscription id, or a transient Stripe API error) —
  // mrrFallbackCount tells the dashboard how many of those there were.
  // Annual profiles skip the lookup entirely and use a flat monthly-
  // equivalent instead, since they have no subscription at all — see the
  // comment above this file's constants for why that's not a "fallback."
  let mrrFallbackCount = 0;
  const monthlyAmounts = await mapWithConcurrency(billableProfiles, STRIPE_BATCH_SIZE, async (p) => {
    if (p.plan === 'annual') return ANNUAL_PRICE / 12;
    const real = await monthlyRevenueForSubscription(p.stripe_subscription_id);
    if (real != null) return real;
    mrrFallbackCount++;
    return INSTALLMENT_PRICE;
  });
  const baseMrr = monthlyAmounts.reduce((sum, n) => sum + n, 0);

  // Add-on gifts are one-time purchases, not subscription line items, so
  // they're not part of any subscription's upcoming invoice — estimated
  // separately here instead (see the comment above this file's constants).
  const { count: activeAddonCount } = await sb
    .from('gifts')
    .select('id', { count: 'exact', head: true })
    .eq('gift_type', 'addon')
    .eq('status', 'active');

  // Same idea for the annual plan's SMS add-on — also a one-time charge
  // now, so it's invisible to any invoice-preview lookup and has to be
  // estimated the same way add-on gifts are. Installment-plan SMS is
  // NOT included here — it's still a real recurring subscription item,
  // already counted in baseMrr above.
  const annualProfileIds = billableProfiles.filter((p) => p.plan === 'annual').map((p) => p.id);
  let annualSmsCount = 0;
  if (annualProfileIds.length > 0) {
    const { count } = await sb
      .from('gifts')
      .select('id', { count: 'exact', head: true })
      .eq('sms_addon', true)
      .eq('status', 'active')
      .in('user_id', annualProfileIds);
    annualSmsCount = count || 0;
  }

  const addonRevenueEstimate    = ((activeAddonCount || 0) * ADDON_RENEWAL_PRICE) / 12;
  const annualSmsRevenueEstimate = (annualSmsCount * SMS_ONE_TIME_ANNUAL_PRICE) / 12;
  const mrr = Math.round((baseMrr + addonRevenueEstimate + annualSmsRevenueEstimate) * 100) / 100;

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
      monthlyBillable,
      annualBillable,
      billableTotal,
      mrr,
      mrrFallbackCount,
      activeAddonCount: activeAddonCount || 0,
      annualSmsCount,
      cancellations30d,
      churnRate30d,
    },
    events: events || [],
  });
};
