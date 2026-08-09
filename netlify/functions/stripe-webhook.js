// Stripe webhook handler — POST /.netlify/functions/stripe-webhook
// (mapped to /api/stripe-webhook in netlify.toml)
//
// Every plan is a genuine ONE-TIME Stripe price now, charged immediately
// at checkout — there is no free trial, no recurring subscription, and no
// installment plan any more (that all changed in the pricing overhaul
// that introduced the $14 30-Day Gift Pack and bumped annual to $59 —
// see the PRICING UPDATE block in schema.sql). Everything below is
// mode:'payment' Checkout Sessions:
//
//   checkout.session.completed (mode 'payment', gift_addon metadata) →
//     create the paid add-on gift, log 'addon_purchase'
//   checkout.session.completed (mode 'payment', plan_type 'annual' or
//   'gift_pack', no upgrade metadata) → handleOneTimePlanPurchase — a
//     first-time purchase (either plan) or a returning buyer's renewal
//     (a fresh gift_pack or annual term after a lapsed one).
//   checkout.session.completed (mode 'payment', upgrade metadata) →
//     handleUpgradeToAnnual — ONLY reachable for a buyer whose current
//     plan is 'gift_pack' and still active (create-checkout.js enforces
//     this before ever creating the session). Converts them straight to
//     a fresh 365-day annual term for the discounted $45 upgrade price.
//
// A genuine first-ever enrollment (for either handler above) also calls
// maybeRewardReferral, which grants a free bonus gift_type='referral'
// credit to both this buyer and whoever referred them, if anyone did —
// see the REFERRAL PROGRAM block in schema.sql and record-referral.js
// for the rest of that flow.
//
// The subscription_events inserts feed the internal admin dashboard
// (admin.html / admin-metrics.js) — profiles only holds current status,
// so this append-only log is the only place enrollment/renewal/
// cancellation/add-on/upgrade history lives.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Flat rate any add-on gift rebills at on renewal, regardless of which
// discounted tier it was originally bought at (spec: "billed at the
// full $20/year rate — regardless of the discounted tier rate
// originally paid"). gift_pack add-ons rebill at gift_pack's own flat
// $14 rate instead — see create-addon-checkout.js.
const ADDON_RENEWAL_PRICE = { annual: 20, gift_pack: 14 };

// Neither plan has a Stripe subscription behind it any more, so the SMS
// add-on is always a flat one-time charge per gift on renewal — matching
// whichever flat price update-sms-addon.js charges for that plan when a
// buyer first turns it on.
const SMS_RENEWAL_PRICE = { annual: 20, gift_pack: 2 };

// How long a fresh term lasts, per plan — used only when a buyer's term
// RENEWS (handleNewTermStarted, below). The very first term for a new
// buyer is anchored by the anchor_term_from_gift_start trigger in
// schema.sql instead, which reads profiles.plan itself.
const TERM_DAYS = { annual: 365, gift_pack: 30 };

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
        if (session.mode !== 'payment') break; // nothing else creates a session any more

        if (session.metadata?.gift_addon === 'true') {
          await handleAddonPurchaseCompleted(session);
          break;
        }

        if (session.metadata?.upgrade === 'true') {
          await handleUpgradeToAnnual(session);
          break;
        }

        if (session.metadata?.plan_type === 'annual' || session.metadata?.plan_type === 'gift_pack') {
          await handleOneTimePlanPurchase(session, session.metadata.plan_type);
          break;
        }

        console.log('Unhandled mode:\'payment\' checkout.session.completed — no recognized metadata', session.id);
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

// Appends a row to subscription_events — the only place enrollment/
// renewal/cancellation/add-on/upgrade history lives (see schema.sql
// comment). Never throws: a logging failure shouldn't turn into a 500
// that makes Stripe retry a webhook whose actual work already succeeded.
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

// One-time off-session charge against a customer's default payment
// method — used for add-on renewal rebilling and SMS add-on renewal
// here, and for the equivalent charge in update-sms-addon.js
// (duplicated there rather than shared, matching this codebase's
// existing per-function style). finalizeInvoice + pay (rather than
// create with auto_advance) attempts the charge synchronously, so the
// caller gets an accurate result back immediately instead of racing
// Stripe's async auto-advance queue.
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
    recipient_relationship:       m.recipient_relationship || null,
    recipient_relationship_other: m.recipient_relationship_other || null,
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

// Handles a buyer's one-time plan checkout — annual ($59) or gift_pack
// ($14) — for either a first-time buyer or a returning one renewing
// after a lapse. Neither plan has ever been a Stripe subscription, so
// nothing about it can auto-renew even by accident. Two things this has
// to do that a real subscription would get from Stripe for free:
//   1. Save the card used as the customer's default payment method —
//      needed for every later off-session charge (add-on gifts, the
//      annual plan's SMS add-on, add-on renewal carryover). Handled by
//      create-checkout.js's setup_future_usage: 'off_session' on the
//      PaymentIntent; this just records the resulting payment method as
//      the customer's default explicitly.
//   2. Decide enrollment vs. renewal itself from subscription_events,
//      since there's no Stripe subscription lifecycle to lean on.
async function handleOneTimePlanPurchase(session, plan) {
  const uid = session.metadata?.supabase_uid;
  if (!uid) {
    console.error('CRITICAL: plan checkout completed with no supabase_uid in metadata', session.id);
    return;
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
    if (pi.payment_method) {
      await stripe.customers.update(session.customer, {
        invoice_settings: { default_payment_method: pi.payment_method },
      });
    } else {
      console.error('CRITICAL: plan checkout completed with no payment_method on its PaymentIntent', session.id);
    }
  } catch (e) {
    console.error('Failed to save default payment method for buyer', session.customer, e.message);
  }

  // No subscription for either plan means no stripe_subscription_id and
  // no Stripe-driven current_period_end — access_term_end (below, via
  // handleNewTermStarted, or the anchor_term_from_gift_start trigger for
  // a first-time buyer) is the only clock that matters. Explicitly nulls
  // stripe_subscription_id in case this buyer somehow had a stale one on
  // file from before the pricing overhaul.
  const profileId = await upsertProfile(session.customer, {
    stripe_subscription_id: null,
    stripe_status:          'active',
    plan,
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
    await logEvent(profileId, session.customer, 'renewal', plan, amount);
    if (profileId) await handleNewTermStarted(profileId, session.customer, plan);
  } else {
    await logEvent(profileId, session.customer, 'enrollment', plan, amount);
    if (profileId) await maybeRewardReferral(profileId);
  }
}

// Handles the $45 upgrade-from-gift_pack-to-annual checkout. Only ever
// reachable for a buyer create-checkout.js already verified was (or
// still is) on the 'gift_pack' plan at the moment the session was
// created — this offer never expires, even after their 30-day term has
// lapsed. Doesn't re-check that here, since the payment has already
// succeeded by the time this webhook fires; the eligibility check only
// matters before money changes hands.
//
// Grants a full fresh 365-day annual term starting now (not just the
// remaining days left on the old gift pack) — the $45 price already
// reflects the $14 they paid for the gift pack being credited toward
// the full $59 annual price, so this is a clean switch to annual, not a
// term extension.
async function handleUpgradeToAnnual(session) {
  const uid = session.metadata?.supabase_uid;
  if (!uid) {
    console.error('CRITICAL: upgrade checkout completed with no supabase_uid in metadata', session.id);
    return;
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
    if (pi.payment_method) {
      await stripe.customers.update(session.customer, {
        invoice_settings: { default_payment_method: pi.payment_method },
      });
    }
  } catch (e) {
    console.error('Failed to save default payment method for upgrade buyer', session.customer, e.message);
  }

  const profileId = await upsertProfile(session.customer, {
    stripe_subscription_id: null,
    stripe_status:          'active',
    plan:                   'annual',
  });

  if (!profileId) {
    console.error('CRITICAL: upgrade checkout succeeded but could not resolve a profile', session.id);
    return;
  }

  const now = new Date();
  const newTermEnd = new Date(now.getTime() + TERM_DAYS.annual * 24 * 60 * 60 * 1000);
  const newTermEndISO = newTermEnd.toISOString();

  await sb.from('profiles')
    .update({ access_term_end: newTermEndISO, renewal_reminder_sent_at: null, upgrade_nudge_sent_at: null })
    .eq('id', profileId);

  await sb.from('gifts')
    .update({ term_end_date: newTermEndISO })
    .eq('user_id', profileId)
    .in('gift_type', ['included', 'referral', 'addon']);

  const amount = (session.amount_total || 0) / 100;
  await logEvent(profileId, session.customer, 'upgrade', 'annual', amount);
}

// Checks whether this buyer (identified here by profileId, the
// REFEREE) was referred by someone, and — if so, and if it hasn't
// already been rewarded — grants both sides one free bonus
// gift_type='referral' credit. Only ever called right after a buyer's
// very first successful enrollment (see the call site above), so this
// naturally never fires for renewals, upgrades, or add-on purchases.
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

// Called when a buyer's base term genuinely renews into a NEW term — a
// returning buyer completing a fresh checkout for the same plan after
// their previous term ended. NOT called for the initial (first-ever)
// purchase, which is anchored by the anchor_term_from_gift_start trigger
// in schema.sql instead once the buyer actually creates their gift.
//
// Advances the buyer's access_term_end (see schema.sql) by exactly
// TERM_DAYS[plan] days from wherever it last ended — deliberately NOT
// from "now", except when the stored end date has already passed.
//
// The "wherever it last ended" base is only used if that date is still
// in the future — i.e. a gapless or early renewal, where extending
// fairly from the exact old end date matters. If the stored
// access_term_end is already in the past (the buyer's term genuinely
// lapsed before they came back to renew) or was never established at
// all, this anchors a full fresh term from right now instead. Without
// this check, a buyer who lapsed for, say, 14 months before
// resubscribing would get a "new" term stacked onto their stale end
// date — already expired the moment it was written.
async function handleNewTermStarted(profileId, stripeCustomerId, plan) {
  const { data: profile } = await sb
    .from('profiles')
    .select('access_term_end')
    .eq('id', profileId)
    .maybeSingle();

  const now = new Date();
  const storedEnd = profile && profile.access_term_end ? new Date(profile.access_term_end) : null;
  const base = storedEnd && storedEnd.getTime() > now.getTime() ? storedEnd : now;
  const termDays = TERM_DAYS[plan] || TERM_DAYS.annual;
  const newTermEnd = new Date(base.getTime() + termDays * 24 * 60 * 60 * 1000);
  const newTermEndISO = newTermEnd.toISOString();

  await sb.from('profiles')
    .update({ access_term_end: newTermEndISO, renewal_reminder_sent_at: null, upgrade_nudge_sent_at: null })
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
  // rebilled at a flat renewal rate per plan (see ADDON_RENEWAL_PRICE)
  // regardless of its original tier. A gift that already lapsed to
  // 'cancelled' before this renewal (e.g. the base term had a gap before
  // this fresh checkout) is NOT resurrected here — only ones still
  // active right up to the renewal qualify, per spec's "any active
  // add-on gift carries over."
  const addonRenewalPrice = ADDON_RENEWAL_PRICE[plan] || ADDON_RENEWAL_PRICE.annual;
  const { data: addons } = await sb
    .from('gifts')
    .select('id')
    .eq('user_id', profileId)
    .eq('gift_type', 'addon')
    .eq('status', 'active');

  for (const addon of addons || []) {
    try {
      const paid = await chargeOneTimeFee(stripeCustomerId, addonRenewalPrice, 'Add-on gift renewal');
      if (paid) {
        await sb.from('gifts').update({
          term_end_date:    newTermEndISO,
          addon_tier_price: addonRenewalPrice,
        }).eq('id', addon.id);
        await logEvent(profileId, stripeCustomerId, 'addon_renewal', 'addon', addonRenewalPrice);
      } else {
        await sb.from('gifts').update({ status: 'cancelled' }).eq('id', addon.id);
        await logEvent(profileId, stripeCustomerId, 'payment_failed', 'addon', addonRenewalPrice);
      }
    } catch (e) {
      console.error('Add-on renewal charge failed for gift', addon.id, e.message);
      await sb.from('gifts').update({ status: 'cancelled' }).eq('id', addon.id);
      await logEvent(profileId, stripeCustomerId, 'payment_failed', 'addon', addonRenewalPrice);
    }
  }

  // Carry the SMS add-on into the new term too — a flat one-time charge
  // per still-active gift with SMS on, since neither plan has a
  // subscription to hang a recurring item off of any more. Priced per
  // whichever plan this new term is actually on.
  await chargeSmsAddonCarryoverOneTime(profileId, stripeCustomerId, plan);
}

// Charges SMS_RENEWAL_PRICE[plan] per still-active gift that has
// sms_addon on (the add-on carryover loop above has already resolved
// which add-on gifts survived into this term) — no subscription item to
// sync since neither plan has one. A failed charge turns SMS off for
// that gift rather than leaving it silently enabled with nothing paid;
// the gift itself (notes) is unaffected either way.
async function chargeSmsAddonCarryoverOneTime(profileId, stripeCustomerId, plan) {
  const price = SMS_RENEWAL_PRICE[plan] || SMS_RENEWAL_PRICE.annual;

  const { data: gifts } = await sb
    .from('gifts')
    .select('id, sms_addon')
    .eq('user_id', profileId)
    .eq('status', 'active');

  for (const gift of (gifts || []).filter((g) => g.sms_addon)) {
    try {
      const paid = await chargeOneTimeFee(stripeCustomerId, price, 'SMS add-on renewal');
      if (paid) {
        await logEvent(profileId, stripeCustomerId, 'sms_renewal', plan, price);
      } else {
        await sb.from('gifts').update({ sms_addon: false }).eq('id', gift.id);
        await logEvent(profileId, stripeCustomerId, 'payment_failed', plan, price);
      }
    } catch (e) {
      console.error('SMS renewal charge failed for gift', gift.id, e.message);
      await sb.from('gifts').update({ sms_addon: false }).eq('id', gift.id);
      await logEvent(profileId, stripeCustomerId, 'payment_failed', plan, price);
    }
  }
}
