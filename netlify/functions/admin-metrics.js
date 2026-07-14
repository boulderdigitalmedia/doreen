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

const { sb, ok, err, preflight } = require('./_shared');

// Keep in sync with the pricing shown on index.html / the Stripe price IDs
// used by create-checkout.js. Used only to estimate MRR — if you change
// pricing, update these too (or MRR will quietly drift out of date).
const MONTHLY_PRICE = 9;
const ANNUAL_PRICE  = 90;

const EVENTS_WINDOW_DAYS = 180;

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
    .select('stripe_status, plan');

  if (profilesErr) return err('Failed to load profiles: ' + profilesErr.message, 500);

  const statusCounts = {};
  let monthlyBillable = 0;
  let annualBillable = 0;
  const billableStatuses = new Set(['active', 'trialing', 'past_due']);

  for (const p of profiles || []) {
    const status = p.stripe_status || 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (billableStatuses.has(status)) {
      if (p.plan === 'annual') annualBillable++;
      else if (p.plan === 'monthly') monthlyBillable++;
    }
  }

  const mrr = Math.round((monthlyBillable * MONTHLY_PRICE + annualBillable * (ANNUAL_PRICE / 12)) * 100) / 100;
  const billableTotal = monthlyBillable + annualBillable;

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
      cancellations30d,
      churnRate30d,
    },
    events: events || [],
  });
};
