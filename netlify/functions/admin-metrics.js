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
// MRR is computed from each billable subscriber's actual upcoming Stripe
// invoice (retrieveUpcoming), not a flat list price — this means it
// correctly reflects coupons/discounts and any recurring add-ons (extra
// gift slots, SMS) riding on the same subscription, since those show up
// as line items on that same invoice. Only falls back to list price
// (MONTHLY_PRICE/ANNUAL_PRICE below) for the rare profile where the
// Stripe lookup fails or there's no subscription id on file — see
// mrrFallbackCount in the response.

const Stripe = require('stripe');
const { sb, ok, err, preflight } = require('./_shared');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Fallback-only list prices — kept in sync with index.html / the Stripe
// price IDs used by create-checkout.js. Real MRR comes from Stripe itself;
// these are just what a profile falls back to if that lookup fails.
const MONTHLY_PRICE = 9;
const ANNUAL_PRICE  = 90;

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

// Actual next-invoice amount for a subscription, converted to a monthly-
// equivalent figure. Returns null (rather than throwing) on any failure
// so the caller can fall back to list price for just that one profile.
async function monthlyRevenueForSubscription(stripeSubscriptionId, plan) {
  if (!stripeSubscriptionId) return null;
  try {
    const upcoming = await stripe.invoices.retrieveUpcoming({ subscription: stripeSubscriptionId });
    const amount = (upcoming.amount_due ?? upcoming.total ?? 0) / 100;
    return plan === 'annual' ? amount / 12 : amount;
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
    .select('stripe_status, plan, stripe_subscription_id');

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
      else if (p.plan === 'monthly') monthlyBillable++;
      billableProfiles.push(p);
    }
  }

  const billableTotal = monthlyBillable + annualBillable;

  // Real MRR: each billable profile's actual upcoming Stripe invoice,
  // normalized to a monthly figure. Falls back to flat list price only
  // for the profiles where that lookup didn't work (no subscription id
  // on file, or a transient Stripe API error) — mrrFallbackCount tells
  // the dashboard how many of those there were, if any.
  let mrrFallbackCount = 0;
  const monthlyAmounts = await mapWithConcurrency(billableProfiles, STRIPE_BATCH_SIZE, async (p) => {
    const real = await monthlyRevenueForSubscription(p.stripe_subscription_id, p.plan);
    if (real != null) return real;
    mrrFallbackCount++;
    return p.plan === 'annual' ? ANNUAL_PRICE / 12 : MONTHLY_PRICE;
  });
  const mrr = Math.round(monthlyAmounts.reduce((sum, n) => sum + n, 0) * 100) / 100;

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
      cancellations30d,
      churnRate30d,
    },
    events: events || [],
  });
};
