// Netlify Scheduled Function — fires every 15 minutes, same cadence as
// send-daily.js.
//
// The annual plan's Price in Stripe is a genuine ONE-TIME price, not
// recurring, so it can't carry a native Stripe subscription trial the
// way installment does — there's no subscription object at all behind
// it (see create-checkout.js's header comment for the full rationale).
// Instead, a trial-eligible annual signup gets its card saved via a
// Checkout 'setup' session (no charge, no subscription), and
// stripe-webhook.js's handleAnnualTrialSetup stamps
// profiles.trial_ends_at (7 days out) with stripe_status='trialing'.
// THIS FILE is what actually charges that saved card once
// trial_ends_at arrives — nothing on Stripe's side does that
// automatically for a one-time price, so something has to poll for it.
//
// Retry policy: charge once when trial_ends_at first arrives. If that
// fails (card declined, expired, etc.), retry once a day for up to
// TRIAL_CHARGE_MAX_ATTEMPTS total attempts, emailing the buyer after
// each failure asking them to update their payment method. After the
// last attempt still fails, the trial is treated as expired — access is
// cut off (gifts deactivated) exactly like a lapsed subscription, the
// same as customer.subscription.deleted's behavior for installment in
// stripe-webhook.js.
//
// Installment needs none of this — its trial is a real Stripe
// subscription trial, converted automatically by Stripe itself and
// handled entirely in stripe-webhook.js's invoice.payment_succeeded.

const { schedule } = require('@netlify/functions');
const Stripe = require('stripe');
const { sb, sendTrialPaymentFailedEmail, sendTrialExpiredEmail } = require('./_shared');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const TRIAL_CHARGE_MAX_ATTEMPTS = 4;                    // 1 initial charge + 3 retries (~3 days)
const RETRY_INTERVAL_MS         = 24 * 60 * 60 * 1000;  // ~1 day between attempts

// Appends a row to subscription_events — duplicated from
// stripe-webhook.js's logEvent rather than shared, matching this
// codebase's existing per-function style (see chargeOneTimeFee there).
async function logSubscriptionEvent(profileId, stripeCustomerId, eventType, plan, amount) {
  try {
    const { error } = await sb.from('subscription_events').insert({
      profile_id:         profileId || null,
      stripe_customer_id: stripeCustomerId || null,
      event_type:         eventType,
      plan:               plan || null,
      amount:             amount != null ? amount : null,
    });
    if (error) console.error('Failed to log subscription event:', eventType, error.message);
  } catch (err) {
    console.error('Failed to log subscription event:', eventType, err.message);
  }
}

// Duplicated from stripe-webhook.js's maybeRewardReferral (same shape,
// same idempotency guard via the conditional status='pending' update) —
// annual's trial-conversion enrollment happens here instead of in the
// webhook, so the referral check has to live here too.
async function maybeRewardReferral(profileId) {
  if (!profileId) return;

  const { data: updated, error } = await sb
    .from('referrals')
    .update({ status: 'rewarded', rewarded_at: new Date().toISOString() })
    .eq('referee_id', profileId)
    .eq('status', 'pending')
    .select('referrer_id, referee_id')
    .maybeSingle();

  if (error) {
    console.error('Referral reward check failed for profile', profileId, error.message);
    return;
  }
  if (!updated) return; // not referred by anyone, or already rewarded

  try {
    await sb.rpc('increment_referral_credits', { target_id: updated.referrer_id });
    await sb.rpc('increment_referral_credits', { target_id: updated.referee_id });
  } catch (e) {
    console.error('CRITICAL: referral marked rewarded but credit increment failed', profileId, e.message);
  }

  await logSubscriptionEvent(updated.referrer_id, null, 'referral_reward', null, null);
  await logSubscriptionEvent(updated.referee_id, null, 'referral_reward', null, null);
}

// One charge attempt for one buyer whose annual trial is due to convert
// (or due for a retry). Charges the exact STRIPE_ANNUAL_PRICE_ID Price
// object directly (rather than a hardcoded dollar amount) so this always
// bills whatever that Price is actually configured as — the same source
// of truth create-checkout.js's immediate-charge path uses.
async function attemptAnnualTrialCharge(profile) {
  const attemptNumber = (profile.trial_charge_attempts || 0) + 1;

  if (!profile.stripe_customer_id) {
    console.error('CRITICAL: annual trial due to convert but profile has no stripe_customer_id', profile.id);
    return;
  }

  let paid = false;
  let amount = null;
  try {
    const price = await stripe.prices.retrieve(process.env.STRIPE_ANNUAL_PRICE_ID);
    amount = price.unit_amount != null ? price.unit_amount / 100 : null;

    await stripe.invoiceItems.create({
      customer: profile.stripe_customer_id,
      price:    process.env.STRIPE_ANNUAL_PRICE_ID,
    });
    const invoice = await stripe.invoices.create({
      customer:           profile.stripe_customer_id,
      collection_method:  'charge_automatically',
      auto_advance:        false,
    });
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    // Same $0-invoice edge case as chargeOneTimeFee in stripe-webhook.js —
    // a customer-level discount/credit can resolve this invoice to $0,
    // which Stripe marks paid automatically at finalization. Calling
    // .pay() on it again throws "Invoice is already paid" instead of
    // confirming success, which would wrongly look like a declined card.
    if (finalized.status === 'paid') {
      paid = true;
    } else {
      const result = await stripe.invoices.pay(finalized.id);
      paid = result.status === 'paid';
    }
  } catch (e) {
    console.error('Annual trial conversion charge failed for profile', profile.id, e.message);
  }

  if (paid) {
    await sb.from('profiles').update({
      stripe_status: 'active',
      trial_ends_at: null,
    }).eq('id', profile.id);

    // Always this buyer's first-ever charge — trial eligibility (see
    // create-checkout.js) only ever applies to a buyer with zero prior
    // enrollments, so there's no "renewal via trial" case to branch on
    // here the way stripe-webhook.js has to for installment.
    await logSubscriptionEvent(profile.id, profile.stripe_customer_id, 'enrollment', 'annual', amount);
    await maybeRewardReferral(profile.id);

    console.log('Annual trial converted for profile', profile.id);
    return;
  }

  if (attemptNumber >= TRIAL_CHARGE_MAX_ATTEMPTS) {
    await sb.from('profiles').update({
      stripe_status:         'canceled',
      trial_charge_attempts: attemptNumber,
    }).eq('id', profile.id);

    await sb.from('gifts')
      .update({ status: 'cancelled' })
      .eq('user_id', profile.id)
      .eq('status', 'active');

    await logSubscriptionEvent(profile.id, profile.stripe_customer_id, 'cancellation', 'annual', null);

    try {
      await sendTrialExpiredEmail({ id: profile.id });
    } catch (e) {
      console.error('Failed to send trial-expired email for profile', profile.id, e.message);
    }

    console.log('Annual trial expired (all', TRIAL_CHARGE_MAX_ATTEMPTS, 'attempts failed) for profile', profile.id);
    return;
  }

  // Push trial_ends_at forward to the next retry time rather than
  // leaving it in the past — otherwise this sweep would re-attempt the
  // charge every 15 minutes instead of once a day.
  const nextAttemptISO = new Date(Date.now() + RETRY_INTERVAL_MS).toISOString();
  await sb.from('profiles').update({
    trial_ends_at:         nextAttemptISO,
    trial_charge_attempts: attemptNumber,
  }).eq('id', profile.id);

  try {
    await sendTrialPaymentFailedEmail({ id: profile.id }, TRIAL_CHARGE_MAX_ATTEMPTS - attemptNumber);
  } catch (e) {
    console.error('Failed to send trial-payment-failed email for profile', profile.id, e.message);
  }

  console.log('Annual trial charge attempt', attemptNumber, 'failed for profile', profile.id, '— will retry');
}

exports.handler = schedule('*/15 * * * *', async () => {
  console.log('process-annual-trials fired:', new Date().toISOString());

  const nowISO = new Date().toISOString();
  const { data: dueProfiles, error } = await sb
    .from('profiles')
    .select('id, stripe_customer_id, trial_charge_attempts')
    .eq('plan', 'annual')
    .eq('stripe_status', 'trialing')
    .lte('trial_ends_at', nowISO);

  if (error) {
    console.error('Annual-trial-conversion sweep query failed:', error.message);
    return { statusCode: 200 };
  }

  for (const profile of dueProfiles || []) {
    try {
      await attemptAnnualTrialCharge(profile);
    } catch (e) {
      console.error('Unhandled error processing annual trial for profile', profile.id, e.message);
    }
  }

  return { statusCode: 200 };
});
