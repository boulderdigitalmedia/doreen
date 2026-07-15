// Netlify Scheduled Function — fires every 15 minutes.
// Delivery time is the recipient's own choice (set during onboarding on
// gift.html), falling back to the gift's default until they pick one. So
// instead of one fixed daily fire time, this runs frequently and only
// actually sends a gift's notification when "now" falls in that
// recipient's (or gift's default) local delivery window — see
// isDeliveryWindow in _shared.js, accurate to the nearest 15-minute
// bucket, e.g. picking 8:07am sends around 8:00-8:15am local time.
const { schedule } = require('@netlify/functions');
const { sb, shouldSendToday, isDeliveryWindow, sendGiftNotifications, applyTermStart, sendRenewalReminderEmail } = require('./_shared');

const TERM_START_GRACE_DAYS   = 30;
const TERM_LENGTH_DAYS        = 365;
const RENEWAL_REMINDER_DAYS   = 30;

// Term start is now normally anchored to the start_date the buyer chose
// for their included gift, the moment that gift is created — a Postgres
// trigger (anchor_term_from_gift_start in schema.sql) handles that
// atomically at INSERT time, not this sweep. This sweep is only a
// fallback for two cases the trigger can't cover:
//
//   1. A buyer who paid but never actually finished creating their
//      included gift at all — there's no start_date to anchor from, so
//      this falls back to the old flat 30-days-after-signup cap.
//   2. Defense in depth: if a profile somehow still has no
//      term_start_date 30+ days after signup despite having a gift on
//      file (the trigger should have caught this, but this is cheap
//      insurance against, say, a row inserted outside the normal app
//      flow), this looks up that gift's own start_date and uses it —
//      the same accurate source the trigger uses — rather than falling
//      back to the flat guess.
//
// Either way, the same danger applies as before to the flat 30-day
// fallback: for a long-standing account, created_at + 30 + 365 days can
// land in the past the instant it's written, which would make the very
// next sweep cycle treat a real, currently-serviced paying customer as
// already expired. The clamp below prevents that — if the computed term
// would already be expired, this anchors a full fresh 365 days from
// right now instead, same principle as the stale-date guard in
// stripe-webhook.js's handleNewTermStarted.
async function sweepTermStartGrace() {
  const cutoffISO = new Date(Date.now() - TERM_START_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: overdue, error } = await sb
    .from('profiles')
    .select('id, created_at')
    .is('term_start_date', null)
    .in('stripe_status', ['active', 'trialing', 'past_due'])
    .lte('created_at', cutoffISO);

  if (error) {
    console.error('Term-start grace sweep query failed:', error.message);
    return;
  }

  for (const profile of overdue || []) {
    const now = new Date();

    const { data: includedGift } = await sb
      .from('gifts')
      .select('start_date')
      .eq('user_id', profile.id)
      .eq('gift_type', 'included')
      .maybeSingle();

    let computedStart;
    if (includedGift && includedGift.start_date) {
      computedStart = new Date(includedGift.start_date);
    } else {
      computedStart = new Date(new Date(profile.created_at).getTime() + TERM_START_GRACE_DAYS * 24 * 60 * 60 * 1000);
    }
    const computedEnd = new Date(computedStart.getTime() + TERM_LENGTH_DAYS * 24 * 60 * 60 * 1000);
    const isAlreadyExpired = computedEnd.getTime() <= now.getTime();

    const termStart = isAlreadyExpired ? now : computedStart;
    const termEnd    = isAlreadyExpired ? new Date(now.getTime() + TERM_LENGTH_DAYS * 24 * 60 * 60 * 1000) : computedEnd;

    try {
      await applyTermStart(profile.id, termStart, termEnd);
      if (isAlreadyExpired) {
        console.log('Term-start grace cap applied for LEGACY profile', profile.id, '— anchored fresh from now, computed term was already expired');
      } else {
        console.log('Term-start grace cap applied for profile', profile.id);
      }
    } catch (e) {
      console.error('Failed to apply term-start grace cap for profile', profile.id, e.message);
    }
  }
}

// The annual plan is a one-time payment now (see create-checkout.js) —
// there's no Stripe subscription behind it, so nothing ever fires
// customer.subscription.deleted for it when a term ends with no renewal.
// The installment plan doesn't need this: cancel_at forces a real
// subscription-lifecycle event that stripe-webhook.js already catches.
// This sweep is the annual plan's equivalent — anything still marked
// 'active' whose access_term_end has already passed gets treated exactly
// like a lapsed installment subscription would: gifts deactivated (still
// viewable, no more sends — see the gifts RLS policy in schema.sql),
// status flipped so it stops showing as active, and a 'cancellation'
// event logged for the admin dashboard.
async function sweepExpiredAnnualTerms() {
  const nowISO = new Date().toISOString();

  const { data: expired, error } = await sb
    .from('profiles')
    .select('id, stripe_customer_id')
    .eq('plan', 'annual')
    .eq('stripe_status', 'active')
    .lt('access_term_end', nowISO);

  if (error) {
    console.error('Expired-annual-term sweep query failed:', error.message);
    return;
  }

  for (const profile of expired || []) {
    try {
      await sb.from('gifts')
        .update({ status: 'cancelled' })
        .eq('user_id', profile.id)
        .eq('status', 'active');

      await sb.from('profiles')
        .update({ stripe_status: 'canceled' })
        .eq('id', profile.id);

      await sb.from('subscription_events').insert({
        profile_id:         profile.id,
        stripe_customer_id: profile.stripe_customer_id || null,
        event_type:         'cancellation',
        plan:               'annual',
      });

      console.log('Expired annual term closed out for profile', profile.id);
    } catch (e) {
      console.error('Failed to close out expired annual term for profile', profile.id, e.message);
    }
  }
}

// Neither plan auto-renews past its 12-month term (annual is a one-time
// payment; installment's cancel_at forcibly ends it) — so a buyer who
// doesn't check their account page only learns their gift stopped once
// it already had. This sends one reminder email per term, roughly a
// month before access_term_end, to every billable profile that hasn't
// already gotten one for the CURRENT term (renewal_reminder_sent_at is
// reset to null whenever a new term starts — see schema.sql). Profiles
// whose term has already lapsed are excluded here — sweepExpiredAnnualTerms
// (and stripe-webhook.js's subscription.deleted handler for installment)
// handle that case instead, past the point a reminder would still help.
async function sweepRenewalReminders() {
  const now = new Date();
  const windowEndISO = new Date(now.getTime() + RENEWAL_REMINDER_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: dueSoon, error } = await sb
    .from('profiles')
    .select('id, plan, access_term_end')
    .in('stripe_status', ['active', 'trialing', 'past_due'])
    .is('renewal_reminder_sent_at', null)
    .not('access_term_end', 'is', null)
    .gt('access_term_end', now.toISOString())
    .lte('access_term_end', windowEndISO);

  if (error) {
    console.error('Renewal-reminder sweep query failed:', error.message);
    return;
  }

  for (const profile of dueSoon || []) {
    try {
      await sendRenewalReminderEmail(profile);
      await sb.from('profiles')
        .update({ renewal_reminder_sent_at: new Date().toISOString() })
        .eq('id', profile.id);
      console.log('Renewal reminder sent for profile', profile.id);
    } catch (e) {
      console.error('Failed to send/record renewal reminder for profile', profile.id, e.message);
    }
  }
}

exports.handler = schedule('*/15 * * * *', async () => {
  console.log('send-daily fired:', new Date().toISOString());

  await sweepTermStartGrace();
  await sweepExpiredAnnualTerms();
  await sweepRenewalReminders();

  const { data: gifts, error } = await sb
    .from('gifts')
    .select('*')
    .eq('status', 'active');

  if (error) {
    console.error('Failed to fetch gifts:', error.message);
    return { statusCode: 500 };
  }

  console.log(`Checking ${gifts.length} active gift(s)`);

  const giftIds = gifts.map(g => g.id);
  const { data: recipients } = await sb
    .from('recipients')
    .select('*')
    .in('gift_id', giftIds);

  const recipientByGiftId = new Map((recipients || []).map(r => [r.gift_id, r]));

  const results = await Promise.allSettled(
    gifts
      .filter(g => shouldSendToday(g, recipientByGiftId.get(g.id)) && isDeliveryWindow(g, recipientByGiftId.get(g.id)))
      .map(g => sendGiftNotifications(g))
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`Gift ${i} failed:`, r.reason);
  });

  const sent    = results.filter(r => r.status === 'fulfilled' && r.value?.sent).length;
  const skipped = results.filter(r => r.status === 'fulfilled' && r.value?.skipped).length;

  console.log(`Done — sent: ${sent}, skipped: ${skipped}`);
  return { statusCode: 200 };
});
