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

// Caps the "fair term start" grace period (see the schema.sql comment
// next to profiles.term_start_date) — normally a buyer's 12-month access
// term starts from their first note actually sending (_shared.js's
// ensureTermStarted), but someone who never gets around to sending a
// first note at all shouldn't leave their term open-ended forever. Any
// billable profile that's gone 30+ days since signup with no
// term_start_date yet gets anchored right at that 30-day mark instead.
//
// This also has to be the catch-all for LEGACY accounts predating this
// whole term-tracking system entirely — ensureTermStarted only fires
// once, at the exact moment a gift's note #1 sends, and for an account
// whose first note already went out long before this code existed,
// that moment is gone for good. This sweep is the only thing left that
// can ever set term_start_date for them.
//
// That makes the naive created_at + 30 days math actively dangerous for
// long-standing accounts: for anyone whose profile is already more than
// ~13 months old (created_at + 30 + 365 days), that computed term_end
// lands in the PAST the instant it's written — which would make the very
// next sweep cycle treat a real, currently-serviced paying customer as
// already expired and deactivate their gifts, with zero warning, purely
// because of when this code happened to first catch up with them. The
// clamp below prevents that: if the created_at-anchored math would
// already be expired by the time it's applied, this anchors a full fresh
// 365 days from right now instead — exactly the same principle as the
// stale-date guard in stripe-webhook.js's handleNewTermStarted.
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
    const computedStart = new Date(new Date(profile.created_at).getTime() + TERM_START_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const computedEnd   = new Date(computedStart.getTime() + TERM_LENGTH_DAYS * 24 * 60 * 60 * 1000);
    const isAlreadyExpired = computedEnd.getTime() <= now.getTime();

    const termStart = isAlreadyExpired ? now : computedStart;
    const termEnd    = isAlreadyExpired ? new Date(now.getTime() + TERM_LENGTH_DAYS * 24 * 60 * 60 * 1000) : computedEnd;

    try {
      await applyTermStart(profile.id, termStart, termEnd);
      if (isAlreadyExpired) {
        console.log('Term-start grace cap applied for LEGACY profile', profile.id, '— anchored fresh from now, created_at-based math was already expired');
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
