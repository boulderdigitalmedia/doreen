// Stripe webhook handler — POST /.netlify/functions/stripe-webhook
// (mapped to /api/stripe-webhook in netlify.toml)
//
// A first-time buyer gets a 7-day free trial on either plan, but the two
// plans get there completely differently — installment's Price is a
// real recurring monthly price, so it uses a genuine Stripe subscription
// trial; annual's Price is one-time, so its trial is entirely
// self-managed (see create-checkout.js's header comment for the full
// rationale). That split runs through everything below:
//
//   checkout.session.completed (mode 'subscription') → INSTALLMENT ONLY
//     now (annual never creates one of these). Activates the
//     subscription, enforces its 12-month cancel_at (offset past the
//     trial if this checkout got one). A first-time buyer's subscription
//     lands here in 'trialing' status with NOTHING charged yet —
//     enrollment logging, the referral reward, and add-on/SMS carryover
//     are all deliberately deferred until invoice.payment_succeeded
//     below, once the trial actually converts. A returning buyer's
//     renewal checkout (no trial — see create-checkout.js's eligibility
//     check) is charged immediately, so it's logged right here.
//   checkout.session.completed (mode 'setup', annual_trial metadata) →
//     ANNUAL ONLY, first-time/trial-eligible buyers. No charge, no
//     subscription — just saves the card and starts the self-managed
//     trial clock (handleAnnualTrialSetup). process-annual-trials.js (a
//     separate scheduled function) is what actually charges that saved
//     card once the trial ends — nothing here or on Stripe's side does
//     that automatically for a one-time price.
//   checkout.session.completed (mode 'payment', gift_addon metadata) →
//     create the paid add-on gift, log 'addon_purchase'
//   checkout.session.completed (mode 'payment', plan_type 'annual') →
//     ANNUAL ONLY, buyers who AREN'T trial-eligible (a returning member
//     renewing after a lapse) — the original one-time $45 charge,
//     immediate, no trial.
//   customer.subscription.updated  → sync status/period (including
//     installment's 'trialing' → 'active' transition itself), mirror
//     the included gift's term_end_date. Installment only — annual has
//     no subscription to fire this at all.
//   customer.subscription.deleted  → installment's term truly over (no
//     successor, or its trial canceled before converting) — deactivate
//     ALL of this buyer's gifts (still viewable, no more sends), log
//     'cancellation'. Annual's equivalent (self-managed trial expiring
//     after failed retries, or an already-converted term simply
//     lapsing) is handled directly in process-annual-trials.js /
//     send-daily.js instead, since there's no subscription event to
//     fire here for it.
//   invoice.payment_succeeded (subscription_cycle) → installment only.
//     This is where its trial ACTUALLY CONVERTS to the buyer's first
//     real charge — billing_reason is 'subscription_cycle' rather than
//     'subscription_create' specifically because no invoice exists at
//     all while a subscription sits in 'trialing'. Distinguishes that
//     genuinely-new charge from a routine mid-term cycle (monthly
//     payments #2-12 within an already-established term) by checking
//     whether ANY event has already been recorded against this exact
//     stripe_subscription_id — only the very first successful invoice
//     for a given subscription is new, everything after that is already
//     accounted for.
//   invoice.payment_failed → installment only. Marks past_due, logs
//     'payment_failed' (also what fires if its trial's card gets
//     declined at conversion).
//
// A genuine first-ever enrollment (however it's detected — installment
// via invoice.payment_succeeded, or annual via
// process-annual-trials.js's own charge-success path) also calls
// maybeRewardReferral, which grants a free bonus gift_type='referral'
// credit to both this buyer and whoever referred them, if anyone did —
// see the REFERRAL PROGRAM block in schema.sql and record-referral.js
// for the rest of that flow.
//
// The subscription_events inserts feed the internal admin dashboard
// (admin.html / admin-metrics.js) — profiles only holds current status,
// so this append-only log is the only place enrollment/renewal/
// cancellation/add-on history lives. IMPORTANT: invoice.payment_succeeded
// must be enabled on the Stripe webhook endpoint (Dashboard → Developers
// → Webhooks → this endpoint → Add events) — with trials in the picture
// this is no longer just "for renewals," it's how every first-time
// installment trial conversion gets recorded at all.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Flat rate any add-on gift rebills at on renewal, regardless of which
// discounted tier it was originally bought at (spec: "billed at the
// full $20/year rate — regardless of the discounted tier rate
// originally paid").
const ADDON_RENEWAL_PRICE = 20;

// Same SMS add-on price IDs update-sms-addon.js uses — duplicated here
// rather than shared, matching this file's existing per-function style
// (see chargeOneTimeFee). Only used for the installment plan now, which
// still has a real subscription to attach the SMS item to.
const SMS_ADDON_MONTHLY_PRICE_ID = process.env.STRIPE_SMS_ADDON_PRICE_ID;
const SMS_ADDON_ANNUAL_PRICE_ID  = process.env.STRIPE_SMS_ADDON_ANNUAL_PRICE_ID;

// The annual plan has no subscription to hang a recurring SMS item off
// of, so its SMS add-on is a flat one-time charge instead — same $/year
// rate the recurring version used, just charged directly rather than
// through a subscription item. Matches update-sms-addon.js's identical
// constant for the same reason (duplicated, not shared — see above).
const SMS_ONE_TIME_ANNUAL_PRICE = 20;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    // event.body is a raw string when isBase64Encoded is false
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  console.log('Stripe event:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;

        if (session.mode === 'payment' && session.metadata?.gift_addon === 'true') {
          await handleAddonPurchaseCompleted(session);
          break;
        }

        if (session.mode === 'payment' && session.metadata?.plan_type === 'annual') {
          await handleAnnualOneTimePurchase(session);
          break;
        }

        // Annual, trial-eligible — a Checkout 'setup' session just saved
        // the buyer's card with nothing charged and no subscription
        // created at all (see create-checkout.js). Starts the
        // self-managed trial clock instead of anything below, which is
        // entirely about real Stripe subscriptions (installment only,
        // now that annual never creates one).
        if (session.mode === 'setup' && session.metadata?.annual_trial === 'true') {
          await handleAnnualTrialSetup(session);
          break;
        }

        if (session.mode !== 'subscription') break;

        // Only installment reaches here now — annual never creates a
        // mode 'subscription' session any more (see create-checkout.js
        // and handleAnnualTrialSetup/handleAnnualOneTimePurchase above).
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const plan = getPlan(sub);
        const periodEnd = periodEndISO(sub);
        const profileId = await upsertProfile(session.customer, {
          stripe_subscription_id: sub.id,
          stripe_status:          sub.status,
          plan,
          current_period_end:     periodEnd,
        });

        // Installment shouldn't silently auto-renew at $4.50/mo forever —
        // cancel_at stops it a fixed 12 months out from whenever the
        // trial ends (or from creation, for a renewal checkout that
        // didn't get a trial — see create-checkout.js's eligibility
        // check). Continuing past that point means checking out again
        // for a fresh term (handled as a 'renewal', below or in
        // invoice.payment_succeeded, whichever detects it).
        const baseTs = sub.trial_end || sub.start_date || Math.floor(Date.now() / 1000);
        const cancelAt = baseTs + 12 * 30 * 24 * 60 * 60; // ~12 months of $4.50 payments
        try {
          await stripe.subscriptions.update(sub.id, { cancel_at: cancelAt });
        } catch (e) {
          console.error('Failed to set cancel_at for subscription', sub.id, e.message);
        }

        // A subscription still in 'trialing' status hasn't charged the
        // buyer anything yet — enrollment/renewal logging, the referral
        // reward, and term/add-on carryover all wait for the trial to
        // actually convert to a real payment, which shows up as
        // invoice.payment_succeeded instead (see that case below). This
        // branch only reaches the logging below for a subscription that
        // was never trialing at all — a returning buyer's renewal
        // checkout, charged immediately (see create-checkout.js).
        if (sub.status !== 'trialing') {
          // A profile with prior enrollment history is a returning buyer
          // completing a fresh checkout for a new term (their previous one
          // lapsed) — that's a renewal, not a first-time enrollment, and
          // triggers add-on carryover. Otherwise this is their very first
          // subscription.
          let priorEnrollments = 0;
          if (profileId) {
            const res = await sb
              .from('subscription_events')
              .select('id', { count: 'exact', head: true })
              .eq('profile_id', profileId)
              .eq('event_type', 'enrollment');
            priorEnrollments = res.count || 0;
          }

          if (priorEnrollments > 0) {
            await logEvent(profileId, session.customer, 'renewal', plan, planAmount(sub), sub.id);
            if (profileId) await handleNewTermStarted(profileId, session.customer, sub.id, plan);
          } else {
            await logEvent(profileId, session.customer, 'enrollment', plan, planAmount(sub), sub.id);
            // Only a genuine first-ever enrollment can reward a referral —
            // see maybeRewardReferral for why this is keyed off "first
            // payment succeeded" rather than signup alone.
            if (profileId) await maybeRewardReferral(profileId);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        // current_period_end here is Stripe's raw billing date, kept only
        // for billing/cancel_at purposes — it deliberately does NOT drive
        // gifts.term_end_date any more. The buyer's actual "access term"
        // (profiles.access_term_end) is anchored to first-send-or-30-day-
        // cap instead (see schema.sql), and only ever advances via
        // ensureTermStarted (_shared.js), the grace-period sweep
        // (send-daily.js), or handleNewTermStarted (below) — not by
        // mirroring every incidental change to Stripe's billing period.
        await upsertProfile(sub.customer, {
          stripe_subscription_id: sub.id,
          stripe_status:          sub.status,
          plan:                   getPlan(sub),
          current_period_end:     periodEndISO(sub),
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const plan = getPlan(sub);
        const profileId = await upsertProfile(sub.customer, {
          stripe_subscription_id: sub.id,
          stripe_status:          'canceled',
          current_period_end:     periodEndISO(sub),
        });
        // The term is genuinely over with no successor lined up (natural
        // non-renewal, the installment plan's cancel_at firing, or an
        // explicit early cancellation via cancel-subscription.js) — stop
        // every one of this buyer's gifts from sending anything further.
        // Already-sent notes stay visible to recipients regardless (see
        // the gifts RLS policy in schema.sql).
        if (profileId) await deactivateAllGifts(profileId);
        await logEvent(profileId, sub.customer, 'cancellation', plan, null, sub.id);
        break;
      }

      // Fires on every successful invoice, including the very first one —
      // billing_reason distinguishes a brand-new NO-TRIAL subscription's
      // first invoice ('subscription_create', already logged as
      // 'enrollment' by checkout.session.completed directly) from
      // everything else ('subscription_cycle'), which now covers BOTH a
      // trial converting to a real charge for the first time AND a
      // routine mid-term cycle (installment's monthly payments #2-12).
      // The alreadyRecorded check below is what tells those two apart —
      // see the file header comment.
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription || invoice.billing_reason !== 'subscription_cycle') break;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const plan = getPlan(sub);
        const profileId = await findProfileId(invoice.customer);

        const { count: alreadyRecorded } = await sb
          .from('subscription_events')
          .select('id', { count: 'exact', head: true })
          .eq('stripe_subscription_id', sub.id);
        if (alreadyRecorded) break; // routine cycle within an already-established term

        let priorEnrollments = 0;
        if (profileId) {
          const res = await sb
            .from('subscription_events')
            .select('id', { count: 'exact', head: true })
            .eq('profile_id', profileId)
            .eq('event_type', 'enrollment');
          priorEnrollments = res.count || 0;
        }

        if (priorEnrollments > 0) {
          await logEvent(profileId, invoice.customer, 'renewal', plan, (invoice.amount_paid || 0) / 100, sub.id);
          if (profileId) await handleNewTermStarted(profileId, invoice.customer, sub.id, plan);
        } else {
          // This subscription's first-ever successful charge, and this
          // profile has never enrolled before — a trial just converted.
          await logEvent(profileId, invoice.customer, 'enrollment', plan, (invoice.amount_paid || 0) / 100, sub.id);
          if (profileId) await maybeRewardReferral(profileId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const profileId = await upsertProfile(sub.customer, {
          stripe_status: 'past_due',
        });
        await logEvent(profileId, sub.customer, 'payment_failed', getPlan(sub), (invoice.amount_due || 0) / 100, sub.id);
        break;
      }

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }
  } catch (err) {
    console.error('Handler error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function upsertProfile(stripeCustomerId, updates) {
  // Find the profile by Stripe customer ID
  const { data: profile, error } = await sb
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (error || !profile) {
    // Try to match via Stripe customer metadata
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const uid = customer.metadata?.supabase_uid;
    if (!uid) {
      console.error('No supabase_uid found for Stripe customer:', stripeCustomerId);
      return null;
    }
    await sb.from('profiles').upsert({ id: uid, stripe_customer_id: stripeCustomerId, ...updates });
    return uid;
  }

  await sb.from('profiles').update(updates).eq('id', profile.id);
  console.log('Profile updated:', profile.id, updates);
  return profile.id;
}

// Read-only version of the lookup half of upsertProfile, for handlers
// (like invoice.payment_succeeded) that need the profile id to tag an
// event with but have no status update of their own to write.
async function findProfileId(stripeCustomerId) {
  const { data: profile } = await sb
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();
  if (profile) return profile.id;

  const customer = await stripe.customers.retrieve(stripeCustomerId);
  return customer.metadata?.supabase_uid || null;
}

// Appends a row to subscription_events — the only place enrollment/
// renewal/cancellation/add-on history lives (see schema.sql comment).
// Never throws: a logging failure shouldn't turn into a 500 that makes
// Stripe retry a webhook whose actual work already succeeded.
async function logEvent(profileId, stripeCustomerId, eventType, plan, amount, stripeSubscriptionId) {
  try {
    const { error } = await sb.from('subscription_events').insert({
      profile_id:             profileId || null,
      stripe_customer_id:     stripeCustomerId || null,
      event_type:             eventType,
      plan:                   plan || null,
      amount:                 amount != null ? amount : null,
      stripe_subscription_id: stripeSubscriptionId || null,
    });
    if (error) console.error('Failed to log subscription event:', eventType, error.message);
  } catch (err) {
    console.error('Failed to log subscription event:', eventType, err.message);
  }
}

function getPlan(sub) {
  // Determine plan from price interval
  const item = sub.items?.data?.[0];
  const interval = item?.price?.recurring?.interval;
  if (interval === 'year') return 'annual';
  if (interval === 'month') return 'installment';
  return null;
}

// Dollar amount of the subscription's recurring price, for tagging the
// 'enrollment'/'renewal' events — best-effort only (ignores
// quantity/proration); invoice-driven events use the actual invoice
// amount instead, which is exact.
function planAmount(sub) {
  const price = sub.items?.data?.[0]?.price;
  return price?.unit_amount != null ? price.unit_amount / 100 : null;
}

// Newer Stripe API versions moved current_period_end off the Subscription
// object and onto each subscription item instead (since a subscription can
// now have items on different billing cycles) — sub.current_period_end can
// be undefined there. That turned `new Date(undefined * 1000).toISOString()`
// into a thrown RangeError ("Invalid time value"), which is what was making
// every customer.subscription.updated delivery fail with a 500: the crash
// happened before upsertProfile ever got called, so nothing after it in the
// handler ran either. This checks both shapes and never throws — falls back
// to null if a period end genuinely isn't available anywhere.
function periodEndISO(sub) {
  let raw = sub.current_period_end;
  if (raw == null) raw = sub.items?.data?.[0]?.current_period_end;
  if (raw == null) return null;
  const d = new Date(raw * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// One-time off-session charge against a customer's default payment
// method — used for add-on renewal rebilling here, and for the early-
// cancellation fee in cancel-subscription.js (duplicated there rather
// than shared, matching this codebase's existing per-function style).
// finalizeInvoice + pay (rather than create with auto_advance) attempts
// the charge synchronously, so the caller gets an accurate result back
// immediately instead of racing Stripe's async auto-advance queue.
async function chargeOneTimeFee(customerId, amountDollars, description) {
  await stripe.invoiceItems.create({
    customer:    customerId,
    amount:      Math.round(amountDollars * 100),
    currency:    'usd',
    description,
  });
  const invoice = await stripe.invoices.create({
    customer:           customerId,
    collection_method:  'charge_automatically',
    auto_advance:        false,
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  // A $0 invoice (fully offset by a customer-level discount/credit) is
  // marked paid by Stripe automatically at finalization, before any
  // explicit collection attempt — calling .pay() on it again throws
  // "Invoice is already paid" instead of confirming the success it
  // already is. Skip the redundant call in that case.
  if (finalized.status === 'paid') return true;
  const paid = await stripe.invoices.pay(finalized.id);
  return paid.status === 'paid';
}

// Creates the paid add-on gift once its one-time Checkout payment has
// actually succeeded. All the gift's details travel as session metadata
// from create-addon-checkout.js — see that file for why (the tier/price
// was computed server-side there, before the buyer ever paid).
async function handleAddonPurchaseCompleted(session) {
  const m = session.metadata || {};
  const profileId = m.supabase_uid;
  if (!profileId) {
    console.error('CRITICAL: add-on checkout completed with no supabase_uid in metadata', session.id);
    return;
  }

  const tierPrice = m.tier_price ? parseFloat(m.tier_price) : null;

  const { error } = await sb.from('gifts').insert({
    user_id:             profileId,
    slug:                m.slug,
    display_name:        m.display_name,
    sender_name:         m.sender_name || 'Your Favorite',
    start_date:          m.start_date,
    frequency:           m.frequency || 'daily',
    delivery_time:       m.delivery_time || '08:00:00',
    timezone:            m.timezone || 'Pacific/Auckland',
    planned_notes_count: m.planned_notes_count ? parseInt(m.planned_notes_count, 10) : null,
    status:              'active',
    gift_type:           'addon',
    term_end_date:       m.term_end_date || null,
    addon_tier_price:    tierPrice,
  });

  if (error) {
    // Payment already succeeded at this point — a failure here (e.g. a
    // slug collision that slipped past create-addon-checkout.js's
    // pre-check due to a race) leaves the buyer charged with no gift to
    // show for it. Rare, but needs a human to sort out — logged loudly
    // rather than silently swallowed, since there's no automatic refund
    // path wired up here.
    console.error('CRITICAL: paid add-on checkout succeeded but gift insert failed', session.id, error.message);
    return;
  }

  await logEvent(profileId, session.customer, 'addon_purchase', 'addon', tierPrice);
}

// Handles the annual plan's one-time $45 checkout — still very much a
// live path (create-checkout.js uses this for any buyer who ISN'T
// trial-eligible: a returning member renewing after a lapse, charged
// immediately with no trial). A first-time, trial-eligible buyer takes
// a different path entirely (handleAnnualTrialSetup, above/below) that
// defers this exact charge until their trial converts. There's no
// subscription behind either path — annual has never been a Stripe
// subscription — so nothing about it can auto-renew even by accident.
// Two things this has to do that the (real-subscription) installment
// path gets from Stripe for free:
//   1. Save the card used as the customer's default payment method. A
//      one-time Checkout Session doesn't do this on its own — without
//      it, every later off-session charge for this buyer (add-on gifts,
//      the one-time SMS fee, add-on renewal carryover) would have no
//      payment method to charge and would fail outright.
//   2. Decide enrollment vs. renewal itself from subscription_events,
//      exactly like the installment path does, since there's no Stripe
//      subscription lifecycle to lean on here either.
async function handleAnnualOneTimePurchase(session) {
  const uid = session.metadata?.supabase_uid;
  if (!uid) {
    console.error('CRITICAL: annual checkout completed with no supabase_uid in metadata', session.id);
    return;
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
    if (pi.payment_method) {
      await stripe.customers.update(session.customer, {
        invoice_settings: { default_payment_method: pi.payment_method },
      });
    } else {
      console.error('CRITICAL: annual checkout completed with no payment_method on its PaymentIntent', session.id);
    }
  } catch (e) {
    console.error('Failed to save default payment method for annual buyer', session.customer, e.message);
  }

  // No subscription for the annual plan means no stripe_subscription_id
  // and no Stripe-driven current_period_end — access_term_end (below,
  // via handleNewTermStarted) is the only clock that matters for it.
  // Explicitly nulls stripe_subscription_id in case this buyer had a
  // stale installment subscription id on file from switching plans.
  const profileId = await upsertProfile(session.customer, {
    stripe_subscription_id: null,
    stripe_status:          'active',
    plan:                   'annual',
  });

  let priorEnrollments = 0;
  if (profileId) {
    const res = await sb
      .from('subscription_events')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', profileId)
      .eq('event_type', 'enrollment');
    priorEnrollments = res.count || 0;
  }

  const amount = (session.amount_total || 0) / 100;

  if (priorEnrollments > 0) {
    await logEvent(profileId, session.customer, 'renewal', 'annual', amount);
    if (profileId) await handleNewTermStarted(profileId, session.customer, null, 'annual');
  } else {
    await logEvent(profileId, session.customer, 'enrollment', 'annual', amount);
    if (profileId) await maybeRewardReferral(profileId);
  }
}

// Starts the annual plan's SELF-MANAGED trial for a first-time,
// trial-eligible buyer (see create-checkout.js's mode 'setup' session —
// there's no subscription behind this at all, and nothing is charged
// here). Saves the card the SetupIntent collected as the customer's
// default payment method (required for the off-session charge
// process-annual-trials.js makes later), then sets
// profiles.trial_ends_at 7 days out and stripe_status='trialing' —
// exactly what account.html's existing "you're on a free trial" banner
// already checks for, same as installment's native trial.
//
// Deliberately does NOT log 'enrollment' or reward a referral here —
// nothing has been charged yet. That only happens once
// process-annual-trials.js successfully charges the saved card when
// trial_ends_at arrives.
const ANNUAL_TRIAL_DAYS = 7; // duplicated from create-checkout.js's TRIAL_DAYS — matching this file's per-function style (see chargeOneTimeFee)
async function handleAnnualTrialSetup(session) {
  const uid = session.metadata?.supabase_uid;
  if (!uid) {
    console.error('CRITICAL: annual trial setup completed with no supabase_uid in metadata', session.id);
    return;
  }

  try {
    const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent);
    if (setupIntent.payment_method) {
      await stripe.customers.update(session.customer, {
        invoice_settings: { default_payment_method: setupIntent.payment_method },
      });
    } else {
      console.error('CRITICAL: annual trial setup completed with no payment_method on its SetupIntent', session.id);
      return; // nothing to charge later without this — don't start a trial clock we can't collect on
    }
  } catch (e) {
    console.error('Failed to save default payment method for annual trial', session.customer, e.message);
    return;
  }

  const trialEndsAt = new Date(Date.now() + ANNUAL_TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await upsertProfile(session.customer, {
    stripe_subscription_id: null,
    stripe_status:          'trialing',
    plan:                   'annual',
    trial_ends_at:          trialEndsAt,
    trial_charge_attempts:  0,
  });
}

// Checks whether this buyer (identified here by profileId, the
// REFEREE) was referred by someone, and — if so, and if it hasn't
// already been rewarded — grants both sides one free bonus
// gift_type='referral' credit. Only ever called right after a buyer's
// very first successful enrollment (see the two call sites above), so
// this naturally never fires for renewals or add-on purchases.
//
// The conditional `.eq('status', 'pending')` update is what makes this
// safe to call more than once for the same buyer (Stripe redelivers
// webhooks on retry): the first successful call flips the row to
// 'rewarded' and returns it; every subsequent call matches zero rows
// and `updated` comes back null, so credits never get double-granted.
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

  await logEvent(updated.referrer_id, null, 'referral_reward', null, null);
  await logEvent(updated.referee_id, null, 'referral_reward', null, null);
}

// Sets every currently-active gift for this buyer to 'cancelled' — no
// more notes go out, but existing ones stay visible to recipients (see
// the gifts RLS policy in schema.sql). Called when a base term ends
// with no successor term lined up.
async function deactivateAllGifts(profileId) {
  await sb.from('gifts')
    .update({ status: 'cancelled' })
    .eq('user_id', profileId)
    .eq('status', 'active');
}

// Called when a buyer's base term genuinely renews into a NEW 12-month
// term — the annual plan's yearly auto-renewal, or a returning buyer
// completing a fresh installment checkout after a prior term ended.
// NOT called for each of the installment plan's 12 monthly payments
// within the same term (see the invoice.payment_succeeded case above).
//
// Advances the buyer's fair access_term_end (see schema.sql) by exactly
// 365 days from wherever it last ended — deliberately NOT from Stripe's
// own new billing period, which may have drifted from the access term
// if the first-send grace period ever applied.
//
// The "wherever it last ended" base is only used if that date is still
// in the future — i.e. a gapless or early renewal, where extending
// fairly from the exact old end date matters. If the stored
// access_term_end is already in the past (the buyer's term genuinely
// lapsed before they came back to renew — annual has no reminder email,
// so this is an expected, not rare, path) or was never established at
// all, this anchors a full fresh 365 days from right now instead.
// Without this check, a buyer who lapsed for, say, 14 months before
// resubscribing would get a "new" term stacked onto their stale end
// date — already expired the moment it was written.
//
// subscriptionId/plan are the NEW term's subscription — for the annual
// plan this is the SAME subscription object as before (Stripe just bills
// it again), but for the installment plan it's a brand-new subscription
// from a fresh checkout, since cancel_at fully ended the old one. That
// distinction matters for the SMS add-on carryover below.
async function handleNewTermStarted(profileId, stripeCustomerId, subscriptionId, plan) {
  const { data: profile } = await sb
    .from('profiles')
    .select('access_term_end')
    .eq('id', profileId)
    .maybeSingle();

  const now = new Date();
  const storedEnd = profile && profile.access_term_end ? new Date(profile.access_term_end) : null;
  const base = storedEnd && storedEnd.getTime() > now.getTime() ? storedEnd : now;
  const newTermEnd = new Date(base.getTime() + 365 * 24 * 60 * 60 * 1000);
  const newTermEndISO = newTermEnd.toISOString();

  await sb.from('profiles')
    .update({ access_term_end: newTermEndISO })
    .eq('id', profileId);

  // Keep the included gift's term in sync — and any free referral-reward
  // gift(s) too, which ride along on the same term for free rather than
  // being repurchased like an add-on (see the REFERRAL PROGRAM block in
  // schema.sql).
  await sb.from('gifts')
    .update({ term_end_date: newTermEndISO })
    .eq('user_id', profileId)
    .in('gift_type', ['included', 'referral']);

  // Any add-on still active from the old term carries over automatically,
  // rebilled at the flat $20 renewal rate regardless of its original
  // tier. A gift that already lapsed to 'cancelled' before this renewal
  // (e.g. the base term had a gap before this fresh checkout) is NOT
  // resurrected here — only ones still active right up to the renewal
  // qualify, per spec's "any active add-on gift carries over."
  const { data: addons } = await sb
    .from('gifts')
    .select('id')
    .eq('user_id', profileId)
    .eq('gift_type', 'addon')
    .eq('status', 'active');

  for (const addon of addons || []) {
    try {
      const paid = await chargeOneTimeFee(stripeCustomerId, ADDON_RENEWAL_PRICE, 'Add-on gift renewal');
      if (paid) {
        await sb.from('gifts').update({
          term_end_date:    newTermEndISO,
          addon_tier_price: ADDON_RENEWAL_PRICE,
        }).eq('id', addon.id);
        await logEvent(profileId, stripeCustomerId, 'addon_renewal', 'addon', ADDON_RENEWAL_PRICE);
      } else {
        await sb.from('gifts').update({ status: 'cancelled' }).eq('id', addon.id);
        await logEvent(profileId, stripeCustomerId, 'payment_failed', 'addon', ADDON_RENEWAL_PRICE);
      }
    } catch (e) {
      console.error('Add-on renewal charge failed for gift', addon.id, e.message);
      await sb.from('gifts').update({ status: 'cancelled' }).eq('id', addon.id);
      await logEvent(profileId, stripeCustomerId, 'payment_failed', 'addon', ADDON_RENEWAL_PRICE);
    }
  }

  // Carry the SMS add-on into the new term too — the mechanism differs
  // by plan since only the installment plan still has a subscription to
  // work with. Installment: sync (or recreate) the recurring SMS
  // subscription item on the new subscription, same as before — cancel_at
  // fully ends the old subscription every ~12 months, so without this
  // the item would silently vanish and buyers would have to re-enable it
  // per gift. Annual: there's no subscription at all, so each gift with
  // SMS on gets charged the flat one-time fee directly instead.
  if (plan === 'annual') {
    await chargeSmsAddonCarryoverOneTime(profileId, stripeCustomerId);
  } else {
    await syncSmsAddonCarryover(profileId, subscriptionId, plan);
  }
}

// One-time-charge equivalent of syncSmsAddonCarryover, for the annual
// plan. Charges SMS_ONE_TIME_ANNUAL_PRICE per still-active gift that has
// sms_addon on (the add-on carryover loop above has already resolved
// which add-on gifts survived into this term) — no subscription item to
// sync since annual buyers don't have one. A failed charge turns SMS off
// for that gift rather than leaving it silently enabled with nothing
// paid; the gift itself (notes) is unaffected either way.
async function chargeSmsAddonCarryoverOneTime(profileId, stripeCustomerId) {
  const { data: gifts } = await sb
    .from('gifts')
    .select('id, sms_addon')
    .eq('user_id', profileId)
    .eq('status', 'active');

  for (const gift of (gifts || []).filter((g) => g.sms_addon)) {
    try {
      const paid = await chargeOneTimeFee(stripeCustomerId, SMS_ONE_TIME_ANNUAL_PRICE, 'SMS add-on renewal');
      if (paid) {
        await logEvent(profileId, stripeCustomerId, 'sms_renewal', 'annual', SMS_ONE_TIME_ANNUAL_PRICE);
      } else {
        await sb.from('gifts').update({ sms_addon: false }).eq('id', gift.id);
        await logEvent(profileId, stripeCustomerId, 'payment_failed', 'annual', SMS_ONE_TIME_ANNUAL_PRICE);
      }
    } catch (e) {
      console.error('SMS renewal charge failed for gift', gift.id, e.message);
      await sb.from('gifts').update({ sms_addon: false }).eq('id', gift.id);
      await logEvent(profileId, stripeCustomerId, 'payment_failed', 'annual', SMS_ONE_TIME_ANNUAL_PRICE);
    }
  }
}

async function syncSmsAddonCarryover(profileId, subscriptionId, plan) {
  const priceId = plan === 'annual' ? SMS_ADDON_ANNUAL_PRICE_ID : SMS_ADDON_MONTHLY_PRICE_ID;
  if (!priceId || !subscriptionId) return;

  const { data: gifts } = await sb
    .from('gifts')
    .select('id, sms_addon')
    .eq('user_id', profileId)
    .eq('status', 'active');
  const smsCount = (gifts || []).filter((g) => g.sms_addon).length;

  try {
    const items = await stripe.subscriptionItems.list({ subscription: subscriptionId, limit: 100 });
    const existing = items.data.find((i) => i.price.id === priceId);

    if (smsCount > 0) {
      if (existing) {
        if (existing.quantity !== smsCount) {
          // 'none' rather than update-sms-addon.js's 'always_invoice' —
          // this fires right at the start of a fresh billing cycle/
          // subscription, so the quantity just becomes part of regular
          // recurring billing going forward rather than generating a
          // one-off prorated invoice.
          await stripe.subscriptionItems.update(existing.id, { quantity: smsCount, proration_behavior: 'none' });
        }
      } else {
        await stripe.subscriptionItems.create({
          subscription: subscriptionId,
          price:        priceId,
          quantity:     smsCount,
          proration_behavior: 'none',
        });
      }
    } else if (existing) {
      await stripe.subscriptionItems.del(existing.id, { proration_behavior: 'none' });
    }
  } catch (e) {
    console.error('SMS add-on carryover failed for profile', profileId, e.message);
  }
}
