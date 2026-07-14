// POST /api/cancel-subscription
// Body: { action: 'preview' | 'confirm' }
// Header: Authorization: Bearer <supabase_access_token>
//
// Mid-term cancellation for the 12-month base plan. Behavior differs by
// how the buyer is paying:
//
//   installment ($4.50/mo) — this is the plan the "not cancel-anytime"
//   term actually binds. Cancelling early costs a fee: half of the
//   remaining installments left in the 12-month term, capped at $20
//   (whichever is LESS). Access to send new notes ends immediately;
//   already-sent notes stay visible to the recipient either way (see
//   the gifts RLS policy in schema.sql). The fee is charged as a
//   one-time invoice before the subscription is actually canceled — if
//   that charge fails, nothing is canceled, so they're never left
//   without access AND without having paid the fee.
//
//   annual ($45/yr) — already paid in full for the year, so there's no
//   fee to compute. "Cancel" here just stops it from auto-renewing
//   (cancel_at_period_end) — access continues through the term they
//   already paid for, then lapses normally at term end (customer.
//   subscription.deleted in stripe-webhook.js handles that same as any
//   other non-renewal). This wasn't explicitly specified in the pricing
//   doc — flagging the assumption here rather than guessing silently.
//
// Call with { action: 'preview' } first to show the fee before charging
// anything; call again with { action: 'confirm' } once the buyer's
// agreed to it. gifts.status flips to 'cancelled' via the subscription.
// deleted webhook once Stripe actually processes the cancellation, not
// synchronously in this function — the webhook is the single place that
// touches gift status, to avoid two code paths racing each other.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const INSTALLMENT_MONTHLY_AMOUNT = 4.5;
const TERM_MONTHS = 12;
const EARLY_CANCEL_FEE_CAP = 20;

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

// Remaining whole months left in the term, 0–12. Approximates using
// 30-day months, same as create-addon-checkout.js's tier boundaries.
function remainingMonths(termEnd) {
  const days = (new Date(termEnd).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.min(TERM_MONTHS, Math.ceil(days / 30)));
}

function computeFee(months) {
  const remainingOwed = months * INSTALLMENT_MONTHLY_AMOUNT;
  return Math.round(Math.min(remainingOwed * 0.5, EARLY_CANCEL_FEE_CAP) * 100) / 100;
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
  const action = body.action === 'confirm' ? 'confirm' : 'preview';

  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('stripe_subscription_id, stripe_status, plan, current_period_end, access_term_end')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || !profile?.stripe_subscription_id) {
    return err('No active subscription found', 409);
  }
  if (!['active', 'trialing', 'past_due'].includes(profile.stripe_status)) {
    return err('Subscription is not currently active', 409);
  }

  // access_term_end (fair, first-send-anchored — see schema.sql) is what
  // actually governs remaining term/fee math here. It isn't set yet if
  // the buyer hasn't sent a first note and the 30-day cap hasn't hit —
  // in that edge case, fall back to Stripe's raw current_period_end
  // (the two haven't had a chance to diverge yet anyway).
  const termEnd = profile.access_term_end || profile.current_period_end;

  // ── Annual (pre-paid in full) — no fee, just stop future renewal ──
  if (profile.plan === 'annual') {
    if (action === 'preview') {
      return ok({
        plan: 'annual',
        fee: 0,
        message: 'Already paid in full for this term — cancelling stops future renewal. ' +
                  'You keep access through ' + new Date(termEnd).toLocaleDateString() + '.',
      });
    }
    await stripe.subscriptions.update(profile.stripe_subscription_id, { cancel_at_period_end: true });
    return ok({
      plan: 'annual',
      fee: 0,
      canceledAt: null,
      message: 'Renewal turned off — access continues through ' +
                new Date(termEnd).toLocaleDateString() + '.',
    });
  }

  // ── Installment — the plan the binding 12-month term actually applies to ──
  if (!termEnd) return err('Could not determine your term end date — contact support', 500);

  const months = remainingMonths(termEnd);
  const fee = computeFee(months);

  if (action === 'preview') {
    return ok({
      plan: 'installment',
      remainingMonths: months,
      fee,
      message: fee > 0
        ? `Cancelling now costs a one-time $${fee.toFixed(2)} fee (half of your ${months} remaining month(s) at $${INSTALLMENT_MONTHLY_AMOUNT}/mo, capped at $${EARLY_CANCEL_FEE_CAP}). You'll keep access to notes already sent, but won't receive any more.`
        : `Your term is effectively over — cancelling now has no fee.`,
    });
  }

  // action === 'confirm' — charge the fee first, only cancel if it succeeds.
  // finalizeInvoice + pay (rather than create with auto_advance) attempts
  // the charge synchronously, so we get an accurate paid/failed result
  // back before deciding whether to proceed with cancellation.
  if (fee > 0) {
    try {
      const customer = await stripe.subscriptions.retrieve(profile.stripe_subscription_id).then((s) => s.customer);
      await stripe.invoiceItems.create({
        customer,
        amount:      Math.round(fee * 100),
        currency:    'usd',
        description: `Early cancellation fee — ${months} month(s) remaining in term`,
      });
      const invoice = await stripe.invoices.create({
        customer,
        collection_method: 'charge_automatically',
        auto_advance:       false,
      });
      const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
      const paid = await stripe.invoices.pay(finalized.id);
      if (paid.status !== 'paid') {
        return err('The cancellation fee could not be charged — your subscription was not canceled. Update your payment method and try again.', 402);
      }
    } catch (e) {
      return err('The cancellation fee could not be charged — your subscription was not canceled. ' + e.message, 402);
    }
  }

  await stripe.subscriptions.cancel(profile.stripe_subscription_id);

  try {
    await sb.from('subscription_events').insert({
      profile_id: user.id,
      event_type: 'early_cancellation',
      plan:       'installment',
      amount:     fee,
    });
  } catch (e) {
    console.error('Failed to log early_cancellation event:', e.message);
  }

  return ok({
    plan: 'installment',
    fee,
    message: fee > 0
      ? `Canceled — $${fee.toFixed(2)} fee charged. You can still see notes already sent.`
      : `Canceled — no fee. You can still see notes already sent.`,
  });
};
