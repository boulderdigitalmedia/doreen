// Stripe webhook handler — POST /.netlify/functions/stripe-webhook
// (mapped to /api/stripe-webhook in netlify.toml)
//
// Handles, for the 12-month-term pricing model:
//   checkout.session.completed (mode 'subscription') → activate base
//     plan, enforce the installment plan's 12-month cancel_at, log
//     'enrollment' (first-ever) or 'renewal' + carry over add-ons
//     (returning buyer starting a fresh term after a lapse)
//   checkout.session.completed (mode 'payment', gift_addon metadata) →
//     create the paid add-on gift, log 'addon_purchase'
//   customer.subscription.updated  → sync status/period, mirror the
//     included gift's term_end_date
//   customer.subscription.deleted  → term truly over (no successor) —
//     deactivate ALL of this buyer's gifts (still viewable, no more
//     sends), log 'cancellation'
//   invoice.payment_succeeded (subscription_cycle, annual plan only) →
//     log 'renewal', carry over add-ons. Skipped for the installment
//     plan's monthly cycles — those are routine payments within the
//     SAME term, not a new term starting (cancel_at ends it before it
//     would ever reach a real renewal via this event).
//   invoice.payment_failed → mark past_due, log 'payment_failed'
//
// The subscription_events inserts feed the internal admin dashboard
// (admin.html / admin-metrics.js) — profiles only holds current status,
// so this append-only log is the only place enrollment/renewal/
// cancellation/add-on history lives. IMPORTANT: invoice.payment_succeeded
// must be enabled on the Stripe webhook endpoint (Dashboard → Developers
// → Webhooks → this endpoint → Add events) for renewals to be tracked.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Flat rate any add-on gift rebills at on renewal, regardless of which
// discounted tier it was originally bought at (spec: "billed at the
// full $20/year rate — regardless of the discounted tier rate
// originally paid").
const ADDON_RENEWAL_PRICE = 20;

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

        if (session.mode !== 'subscription') break;

        // Fetch the full subscription to get period end
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const plan = getPlan(sub);
        const periodEnd = periodEndISO(sub);
        const profileId = await upsertProfile(session.customer, {
          stripe_subscription_id: sub.id,
          stripe_status:          sub.status,
          plan,
          current_period_end:     periodEnd,
        });

        // Enforce the installment plan's fixed 12-month term — under the
        // hood it's a normal recurring monthly subscription, but it
        // shouldn't auto-renew at $4.50/mo forever. cancel_at stops it
        // automatically after 12 payments; continuing past that means
        // checking out again for a fresh term (handled as a 'renewal'
        // below, the next time this case runs for the same buyer).
        if (plan === 'installment') {
          const startTs = sub.start_date || Math.floor(Date.now() / 1000);
          const cancelAt = startTs + 12 * 30 * 24 * 60 * 60; // ~12 months
          try {
            await stripe.subscriptions.update(sub.id, { cancel_at: cancelAt });
          } catch (e) {
            console.error('Failed to set cancel_at for installment subscription', sub.id, e.message);
          }
        }

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
          await logEvent(profileId, session.customer, 'renewal', plan, planAmount(sub));
          if (profileId) await handleNewTermStarted(profileId, session.customer);
        } else {
          await logEvent(profileId, session.customer, 'enrollment', plan, planAmount(sub));
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
        await logEvent(profileId, sub.customer, 'cancellation', plan, null);
        break;
      }

      // Fires on every successful invoice, including the very first one —
      // billing_reason distinguishes a brand-new subscription
      // ('subscription_create', already logged as 'enrollment' above) from
      // an actual renewal charge ('subscription_cycle'). Proration invoices
      // from mid-cycle plan/add-on changes ('subscription_update') are
      // deliberately not counted as renewals here.
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription || invoice.billing_reason !== 'subscription_cycle') break;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const plan = getPlan(sub);

        // Only the annual plan actually reaches a new term via this
        // event — the installment plan's monthly cycles fire it too, but
        // each one is just a routine payment within the SAME
        // already-counted 12-month term (cancel_at ends it before it
        // would ever auto-renew this way).
        if (plan !== 'annual') break;

        const profileId = await findProfileId(invoice.customer);
        await logEvent(profileId, invoice.customer, 'renewal', plan, (invoice.amount_paid || 0) / 100);
        if (profileId) await handleNewTermStarted(profileId, invoice.customer);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const profileId = await upsertProfile(sub.customer, {
          stripe_status: 'past_due',
        });
        await logEvent(profileId, sub.customer, 'payment_failed', getPlan(sub), (invoice.amount_due || 0) / 100);
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
async function logEvent(profileId, stripeCustomerId, eventType, plan, amount) {
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
// if the first-send grace period ever applied. If access_term_end was
// somehow never established (e.g. the previous term lapsed before the
// buyer ever sent a first note or hit the 30-day cap), this anchors
// fresh from right now instead of failing silently.
async function handleNewTermStarted(profileId, stripeCustomerId) {
  const { data: profile } = await sb
    .from('profiles')
    .select('access_term_end')
    .eq('id', profileId)
    .maybeSingle();

  const base = profile && profile.access_term_end ? new Date(profile.access_term_end) : new Date();
  const newTermEnd = new Date(base.getTime() + 365 * 24 * 60 * 60 * 1000);
  const newTermEndISO = newTermEnd.toISOString();

  await sb.from('profiles')
    .update({ access_term_end: newTermEndISO })
    .eq('id', profileId);

  // Keep the included gift's term in sync.
  await sb.from('gifts')
    .update({ term_end_date: newTermEndISO })
    .eq('user_id', profileId)
    .eq('gift_type', 'included');

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
}
