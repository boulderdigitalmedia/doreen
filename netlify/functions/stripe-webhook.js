// Stripe webhook handler — POST /.netlify/functions/stripe-webhook
// (mapped to /api/stripe-webhook in netlify.toml)
//
// Handles:
//   checkout.session.completed       → activate subscription, log 'enrollment'
//   customer.subscription.updated    → sync status/period
//   customer.subscription.deleted    → cancel, log 'cancellation'
//   invoice.payment_succeeded        → log 'renewal' (recurring cycles only)
//   invoice.payment_failed           → mark past_due, log 'payment_failed'
//
// The subscription_events inserts feed the internal admin dashboard
// (admin.html / admin-metrics.js) — profiles only holds current status,
// so this append-only log is the only place enrollment/renewal/
// cancellation history lives. IMPORTANT: invoice.payment_succeeded must
// be enabled on the Stripe webhook endpoint (Dashboard → Developers →
// Webhooks → this endpoint → Add events) for renewals to be tracked —
// it likely isn't yet, since nothing previously listened for it.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
        if (session.mode !== 'subscription') break;

        // Fetch the full subscription to get period end
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const plan = getPlan(sub);
        const profileId = await upsertProfile(session.customer, {
          stripe_subscription_id: sub.id,
          stripe_status:          sub.status,
          plan,
          current_period_end:     periodEndISO(sub),
        });
        await logEvent(profileId, session.customer, 'enrollment', plan, planAmount(sub));
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
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
        const profileId = await findProfileId(invoice.customer);
        await logEvent(profileId, invoice.customer, 'renewal', getPlan(sub), (invoice.amount_paid || 0) / 100);
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
// renewal/cancellation history lives (see schema.sql comment). Never
// throws: a logging failure shouldn't turn into a 500 that makes Stripe
// retry a webhook whose actual work (the profile update) already
// succeeded.
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
  if (interval === 'month') return 'monthly';
  return null;
}

// Dollar amount of the subscription's recurring price, for tagging the
// 'enrollment' event — best-effort only (ignores quantity/proration);
// renewal/payment_failed events use the actual invoice amount instead,
// which is exact.
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
