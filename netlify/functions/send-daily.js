// Netlify Scheduled Function — fires every 15 minutes.
// Delivery time is the recipient's own choice (set during onboarding on
// gift.html), falling back to the gift's default until they pick one. So
// instead of one fixed daily fire time, this runs frequently and only
// actually sends a gift's notification when "now" falls in that
// recipient's (or gift's default) local delivery window — see
// isDeliveryWindow in _shared.js, accurate to the nearest 15-minute
// bucket, e.g. picking 8:07am sends around 8:00-8:15am local time.
const { schedule } = require('@netlify/functions');
const {
  sb, shouldSendToday, isDeliveryWindow, sendGiftNotifications,
  checkNoteShortage, getGiftNoteStatus,
  applyTermStart, sendRenewalReminderEmail, sendGiftSetupReminderEmail,
  sendReengagementEmail,
} = require('./_shared');

const TERM_START_GRACE_DAYS     = 30;
// Term length depends on plan — 30 days for the gift_pack plan, 365 for
// everything else (annual, and any legacy plan value). Used only by the
// fallback sweeps below; a first-time buyer's real term length is set by
// the anchor_term_from_gift_start trigger in schema.sql, which already
// reads profiles.plan itself.
const TERM_LENGTH_DAYS = { annual: 365, gift_pack: 30 };
function termLengthDaysFor(plan) { return TERM_LENGTH_DAYS[plan] || TERM_LENGTH_DAYS.annual; }
// How long before access_term_end to send the "renew soon" reminder —
// also plan-aware: a 30-day gift pack needs a much shorter lead time
// than a 365-day annual term, or the reminder would fire almost
// immediately after purchase.
const RENEWAL_REMINDER_DAYS = { annual: 30, gift_pack: 5 };
function renewalReminderDaysFor(plan) { return RENEWAL_REMINDER_DAYS[plan] || RENEWAL_REMINDER_DAYS.annual; }
const GIFT_SETUP_REMINDER_DAY   = 25; // ~5 days before the 30-day auto-start cap
const REENGAGEMENT_INACTIVE_DAYS = 30; // how long without opening the app counts as "dormant"

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
    .select('id, created_at, plan')
    .is('term_start_date', null)
    .in('stripe_status', ['active', 'past_due'])
    .lte('created_at', cutoffISO);

  if (error) {
    console.error('Term-start grace sweep query failed:', error.message);
    return;
  }

  for (const profile of overdue || []) {
    const now = new Date();
    const termLengthDays = termLengthDaysFor(profile.plan);

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
    const computedEnd = new Date(computedStart.getTime() + termLengthDays * 24 * 60 * 60 * 1000);
    const isAlreadyExpired = computedEnd.getTime() <= now.getTime();

    const termStart = isAlreadyExpired ? now : computedStart;
    const termEnd    = isAlreadyExpired ? new Date(now.getTime() + termLengthDays * 24 * 60 * 60 * 1000) : computedEnd;

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

// Neither plan has a Stripe subscription behind it (see
// create-checkout.js — both are one-time payments), so nothing ever
// fires customer.subscription.deleted when a term ends with no renewal.
// This sweep is what closes out both plans' terms instead: anything
// still marked 'active' whose access_term_end has already passed gets
// gifts deactivated (still viewable, no more sends — see the gifts RLS
// policy in schema.sql), status flipped so it stops showing as active,
// and a 'cancellation' event logged for the admin dashboard.
async function sweepExpiredOneTimeTerms() {
  const nowISO = new Date().toISOString();

  const { data: expired, error } = await sb
    .from('profiles')
    .select('id, stripe_customer_id, plan')
    .in('plan', ['annual', 'gift_pack'])
    .eq('stripe_status', 'active')
    .lt('access_term_end', nowISO);

  if (error) {
    console.error('Expired one-time-plan-term sweep query failed:', error.message);
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
        plan:               profile.plan,
      });

      console.log('Expired term closed out for profile', profile.id, '(' + profile.plan + ')');
    } catch (e) {
      console.error('Failed to close out expired term for profile', profile.id, e.message);
    }
  }
}

// Neither plan auto-renews past its term (both are one-time payments —
// see create-checkout.js) — so a buyer who doesn't check their account
// page only learns their gift stopped once it already had. This sends
// one reminder email per term to every billable profile that hasn't
// already gotten one for the CURRENT term (renewal_reminder_sent_at is
// reset to null whenever a new term starts — see schema.sql), using a
// plan-aware lead time (30 days for annual, 5 for the much-shorter
// gift_pack term — see renewalReminderDaysFor). Profiles whose term has
// already lapsed are excluded here — sweepExpiredOneTimeTerms handles
// that case instead, past the point a reminder would still help.
//
// The query fetches everyone within the WIDEST possible window (the max
// of either plan's lead time) and then filters per-profile against its
// own plan's actual threshold, since Postgres can't express a
// column-dependent comparison directly in a single .lte() call here.
async function sweepRenewalReminders() {
  const now = new Date();
  const widestWindowDays = Math.max(...Object.values(RENEWAL_REMINDER_DAYS));
  const windowEndISO = new Date(now.getTime() + widestWindowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: dueSoonCandidates, error } = await sb
    .from('profiles')
    .select('id, plan, access_term_end')
    .in('stripe_status', ['active', 'past_due'])
    .is('renewal_reminder_sent_at', null)
    .not('access_term_end', 'is', null)
    .gt('access_term_end', now.toISOString())
    .lte('access_term_end', windowEndISO);

  if (error) {
    console.error('Renewal-reminder sweep query failed:', error.message);
    return;
  }

  const dueSoon = (dueSoonCandidates || []).filter((profile) => {
    const daysRemaining = (new Date(profile.access_term_end).getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    return daysRemaining <= renewalReminderDaysFor(profile.plan);
  });

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

// A buyer who subscribes but never actually creates their included gift
// still gets their term auto-started 30 days after signup regardless
// (sweepTermStartGrace above) — anchored to created_at + 30 days rather
// than a start_date they chose, since there's no gift to pull one from.
// That clock runs whether or not they ever set anything up, so this
// gives them a heads-up ~5 days before it happens. Only ever needs to
// fire once per account — gift_setup_reminder_sent_at never resets,
// since this "haven't created a gift yet" state can only occur once,
// before term_start_date is ever set for the first time (see schema.sql).
// Naturally stops matching once either the buyer creates a gift (the
// trigger sets term_start_date) or the 30-day cap fires above (this
// sweep runs first in the handler below, so by the time day 30 arrives
// term_start_date is already set and this query excludes them either way.
async function sweepGiftSetupReminders() {
  const cutoffISO = new Date(Date.now() - GIFT_SETUP_REMINDER_DAY * 24 * 60 * 60 * 1000).toISOString();

  const { data: overdue, error } = await sb
    .from('profiles')
    .select('id, created_at')
    .is('term_start_date', null)
    .is('gift_setup_reminder_sent_at', null)
    .in('stripe_status', ['active', 'past_due'])
    .lte('created_at', cutoffISO);

  if (error) {
    console.error('Gift-setup-reminder sweep query failed:', error.message);
    return;
  }

  for (const profile of overdue || []) {
    const autoStartDate = new Date(new Date(profile.created_at).getTime() + TERM_START_GRACE_DAYS * 24 * 60 * 60 * 1000);
    try {
      await sendGiftSetupReminderEmail(profile, autoStartDate);
      await sb.from('profiles')
        .update({ gift_setup_reminder_sent_at: new Date().toISOString() })
        .eq('id', profile.id);
      console.log('Gift-setup reminder sent for profile', profile.id);
    } catch (e) {
      console.error('Failed to send/record gift-setup reminder for profile', profile.id, e.message);
    }
  }
}

// Billing state (active/canceled/etc) says nothing about whether a paying
// buyer is actually opening the app — this catches the ones who aren't.
// last_active_at is stamped by touch-activity.js on every account.html
// load; NULL means "never recorded an active moment" (either a legacy
// profile that predates this column, or genuinely hasn't been back since
// signup) and is treated the same as "past the inactivity window." Only
// fires once per dormancy episode: touch-activity.js clears
// reengagement_email_sent_at back to NULL the instant the buyer is
// active again, so a later lapse is eligible for another nudge.
async function sweepReengagement() {
  const cutoffISO = new Date(Date.now() - REENGAGEMENT_INACTIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: dormant, error } = await sb
    .from('profiles')
    .select('id, created_at, last_active_at')
    .in('stripe_status', ['active', 'past_due'])
    .is('reengagement_email_sent_at', null)
    .or(`last_active_at.is.null,last_active_at.lte.${cutoffISO}`);

  if (error) {
    console.error('Re-engagement sweep query failed:', error.message);
    return;
  }

  for (const profile of dormant || []) {
    // For a legacy profile with no last_active_at on record at all, fall
    // back to created_at so the email's "X days" figure is still honest
    // rather than fabricated.
    const since = profile.last_active_at ? new Date(profile.last_active_at) : new Date(profile.created_at);
    const daysSinceActive = Math.max(0, Math.round((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)));

    // Actually check note supply rather than assuming it's fine — worst
    // status across all of this buyer's active gifts wins ('out' beats
    // 'low' beats 'ok'), so the email never undersells a real problem.
    let noteStatus = 'ok';
    try {
      const { data: activeGifts } = await sb
        .from('gifts')
        .select('id, slug, display_name, sender_name, frequency, start_date, delivery_time, timezone, sms_addon, user_id')
        .eq('user_id', profile.id)
        .eq('status', 'active');

      for (const g of activeGifts || []) {
        const status = await getGiftNoteStatus(g);
        if (status === 'out') { noteStatus = 'out'; break; }
        if (status === 'low') noteStatus = 'low';
      }
    } catch (e) {
      console.error('Failed to compute note status for profile', profile.id, e.message);
    }

    try {
      await sendReengagementEmail(profile, daysSinceActive, noteStatus);
      await sb.from('profiles')
        .update({ reengagement_email_sent_at: new Date().toISOString() })
        .eq('id', profile.id);
      console.log('Re-engagement nudge sent for profile', profile.id, '—', daysSinceActive, 'days inactive, note status:', noteStatus);
    } catch (e) {
      console.error('Failed to send/record re-engagement nudge for profile', profile.id, e.message);
    }
  }
}

// Standalone note-shortage check, once per gift per day — see the long
// comment on checkNoteShortage in _shared.js for why this is decoupled
// from sendGiftNotifications/the main send loop below rather than
// nested inside it: that path only ever ran for gifts with a fully
// onboarded recipient, on their exact scheduled send day, which silently
// missed a fresh gift under test (no recipient yet) or a weekly/
// biweekly/monthly gift on any day that isn't its send day.
//
// Gated per-gift by isDeliveryWindow so it still only actually runs once
// per day (matching the gift's own default delivery_time/timezone even
// when recipient is null), not once per 15-minute cycle.
async function sweepNoteShortageChecks(gifts, recipientByGiftId) {
  await Promise.allSettled(
    gifts
      .filter(g => isDeliveryWindow(g, recipientByGiftId.get(g.id)))
      .map(g => checkNoteShortage(g, recipientByGiftId.get(g.id)))
  );
}

exports.handler = schedule('*/15 * * * *', async () => {
  console.log('send-daily fired:', new Date().toISOString());

  await sweepGiftSetupReminders();
  await sweepTermStartGrace();
  await sweepExpiredOneTimeTerms();
  await sweepRenewalReminders();
  await sweepReengagement();

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

  // Independent of the actual send below — runs for every active gift
  // once/day regardless of cadence or recipient/channel completeness.
  await sweepNoteShortageChecks(gifts, recipientByGiftId);

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
