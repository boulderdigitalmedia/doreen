// Netlify Scheduled Function — fires every 15 minutes, same cadence as
// send-daily.js/process-annual-trials.js, and for the same reason:
// Netlify's cron is plain UTC with no timezone awareness, so a single
// fixed UTC cron expression for "8:00 AM Pacific/Auckland" would drift an
// hour off across NZ's DST changes. Running frequently and checking the
// *actual* current local time in that zone on every tick (tzNow, from
// _shared.js — already used the same way by isDeliveryWindow for
// recipient delivery windows) gets this right automatically instead.
//
// Sends Jake a daily digest of the previous 24 hours' activity —
// signups, renewals, upgrades, cancellations, payment failures, add-on/
// SMS purchases, new gifts created, recipient replies — plus a couple of
// running totals (active buyers, approximate base MRR) for context.
//
// daily_digest_runs (schema.sql) is what stops this from sending twice
// if more than one 15-minute tick lands inside the send hour.

const { schedule } = require('@netlify/functions');
const { sb, resend, tzNow, buildFrom } = require('./_shared');

const DIGEST_TIMEZONE = 'Pacific/Auckland';
const DIGEST_HOUR     = 8;  // local hour (0-23) the digest should land in
const DIGEST_WINDOW_MINUTES = 15; // matches this function's own run cadence
const DIGEST_TO       = process.env.DIGEST_EMAIL || 'jake@boulderdigitalmedia.com';

// Kept in sync with admin-metrics.js — same list prices, same reasoning
// (both plans are one-time payments now, no Stripe subscription/invoice
// to read an MRR figure back from). This digest only estimates the base
// plan MRR, not the admin dashboard's fuller add-on/SMS-inclusive figure
// — good enough for a daily "where do we stand" line without the extra
// per-plan add-on/SMS queries admin-metrics.js does for its more exact number.
const ANNUAL_PRICE    = 59;
const GIFT_PACK_PRICE = 14;

const EVENT_LABELS = {
  enrollment:         'New signups',
  renewal:            'Renewals',
  upgrade:            'Upgrades (gift pack → annual)',
  addon_purchase:     'Add-on gift purchases',
  addon_renewal:      'Add-on gift renewals',
  sms_purchase:       'SMS add-on purchases',
  sms_renewal:        'SMS add-on renewals',
  referral_reward:    'Referral rewards',
  cancellation:       'Cancellations',
  early_cancellation: 'Early cancellations',
  payment_failed:     'Payment failures',
};
// Rendered in this order regardless of what order rows happen to come
// back in — revenue-positive events first, then the ones worth frowning
// at, so a quick skim reads best-news-first.
const EVENT_ORDER = [
  'enrollment', 'renewal', 'upgrade', 'addon_purchase', 'addon_renewal',
  'sms_purchase', 'sms_renewal', 'referral_reward',
  'cancellation', 'early_cancellation', 'payment_failed',
];
const CONCERNING_EVENTS = new Set(['cancellation', 'early_cancellation', 'payment_failed']);

function pad2(n) { return String(n).padStart(2, '0'); }

// tzNow's returned Date is only trustworthy for reading LOCAL field values
// off (that's exactly how every other use of it in this codebase treats
// it) — its own internal epoch isn't a real instant, so it can't be used
// directly as a query bound against real created_at timestamps. This
// instead takes a real instant (`new Date()`) and subtracts the real
// elapsed duration since local midnight (read via tzNow's fields), which
// stays correct across DST since it's a duration subtraction, not a
// reconstruction. The one soft spot: +24h for the END boundary can be up
// to an hour short/long on the two DST-transition days themselves — a
// digest window being an hour off on two days a year isn't worth more
// machinery than that.
function startOfLocalDayUTC(timezone) {
  const now   = new Date();
  const local = tzNow(timezone);
  const elapsedMs = local.getHours() * 3600000 + local.getMinutes() * 60000 + local.getSeconds() * 1000 + local.getMilliseconds();
  return new Date(now.getTime() - elapsedMs);
}

function money(n) {
  return '$' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function buildDigestData() {
  const dayStart = startOfLocalDayUTC(DIGEST_TIMEZONE);
  const dayEnd   = new Date(dayStart.getTime() + 24 * 3600000);

  // head:true count-only queries come back with the count on the response
  // object's `count` property, not `data` (which is null for these) —
  // same pattern admin-metrics.js's countForPlan already uses.
  const [{ data: events }, { count: newGiftsCount }, { count: repliesCount }, { data: activeProfiles }] = await Promise.all([
    sb.from('subscription_events').select('event_type, plan, amount').gte('created_at', dayStart.toISOString()).lt('created_at', dayEnd.toISOString()),
    sb.from('gifts').select('id', { count: 'exact', head: true }).gte('created_at', dayStart.toISOString()).lt('created_at', dayEnd.toISOString()),
    sb.from('note_replies').select('id', { count: 'exact', head: true }).eq('sender', 'recipient').gte('created_at', dayStart.toISOString()).lt('created_at', dayEnd.toISOString()),
    sb.from('profiles').select('plan, stripe_status'),
  ]);

  const buckets = {};
  let revenueToday = 0;
  (events || []).forEach((e) => {
    const b = buckets[e.event_type] || (buckets[e.event_type] = { count: 0, amount: 0, plans: {} });
    b.count++;
    if (typeof e.amount === 'number') { b.amount += e.amount; revenueToday += e.amount; }
    if (e.plan) b.plans[e.plan] = (b.plans[e.plan] || 0) + 1;
  });

  const billableStatuses = new Set(['active', 'trialing', 'past_due']);
  let activeCount = 0, annualCount = 0, giftPackCount = 0;
  (activeProfiles || []).forEach((p) => {
    if (!billableStatuses.has(p.stripe_status)) return;
    activeCount++;
    if (p.plan === 'annual') annualCount++;
    else if (p.plan === 'gift_pack') giftPackCount++;
  });
  const approxMrr = Math.round((annualCount * (ANNUAL_PRICE / 12) + giftPackCount * GIFT_PACK_PRICE) * 100) / 100;

  return {
    dayStart, dayEnd, buckets, revenueToday,
    newGiftsCount: newGiftsCount || 0,
    repliesCount:  repliesCount || 0,
    activeCount, approxMrr,
  };
}

function planBreakdownLabel(plans) {
  const parts = Object.keys(plans).map((p) => `${plans[p]}× ${p === 'gift_pack' ? 'Gift Pack' : p === 'annual' ? 'Annual' : p}`);
  return parts.length ? ' (' + parts.join(', ') + ')' : '';
}

function buildDigestHtml(data, dateLabel) {
  const rows = EVENT_ORDER
    .filter((type) => data.buckets[type])
    .map((type) => {
      const b = data.buckets[type];
      const concerning = CONCERNING_EVENTS.has(type);
      const amountStr = b.amount ? ' — ' + money(b.amount) : '';
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;color:${concerning ? '#c0392b' : '#2c3a2e'};font-size:15px;">${EVENT_LABELS[type] || type}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;color:${concerning ? '#c0392b' : '#2c3a2e'};font-size:15px;font-weight:500;">${b.count}${planBreakdownLabel(b.plans)}${amountStr}</td>
      </tr>`;
    }).join('');

  const noActivity = !rows.length && !data.newGiftsCount && !data.repliesCount;

  return `<div style="font-family:'DM Sans',Arial,sans-serif;color:#2c3a2e;max-width:560px;margin:0 auto;padding:24px;">
    <p style="font-size:20px;font-weight:500;margin-bottom:4px;">Daily digest — ${dateLabel}</p>
    <p style="font-size:14px;color:#8fa391;margin-bottom:20px;">Last 24 hours, Pacific/Auckland time</p>

    ${noActivity ? '<p style="font-size:15px;color:#8fa391;font-style:italic;">No billing activity in the last 24 hours.</p>' : `
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
      ${rows}
    </table>
    <p style="font-size:15px;font-weight:500;margin:12px 0 20px;">Revenue today: ${money(data.revenueToday)}</p>
    `}

    <div style="background:#f4f7f2;border-radius:10px;padding:16px;margin:16px 0;font-size:15px;">
      <div>🎁 New gifts created: <strong>${data.newGiftsCount}</strong></div>
      <div>💬 Recipient replies: <strong>${data.repliesCount}</strong></div>
    </div>

    <p style="font-size:13px;color:#8fa391;margin-top:24px;">
      Running totals — active buyers: <strong>${data.activeCount}</strong>
      (approx. base MRR: <strong>${money(data.approxMrr)}</strong>, excludes add-ons/SMS)
    </p>

    <p style="font-size:12px;color:#8fa391;margin-top:20px;">
      <a href="https://anoteforyou.app/admin" style="color:#7a9e7e;">Full admin dashboard →</a>
    </p>
  </div>`;
}

exports.handler = schedule('*/15 * * * *', async () => {
  const local = tzNow(DIGEST_TIMEZONE);
  const nowMinutes    = local.getHours() * 60 + local.getMinutes();
  const targetMinutes = DIGEST_HOUR * 60;

  // Same bucketing style as isDeliveryWindow in _shared.js.
  if (Math.floor(nowMinutes / DIGEST_WINDOW_MINUTES) !== Math.floor(targetMinutes / DIGEST_WINDOW_MINUTES)) {
    return { statusCode: 200, body: 'outside digest window' };
  }

  const digestDate = `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;

  // Claim today's date before doing any of the (slower) reporting work
  // below — the digest_date PRIMARY KEY is the actual de-dupe mechanism;
  // this insert failing is the expected/normal way a second overlapping
  // tick detects it lost the race and bails out, not an error.
  const claim = await sb.from('daily_digest_runs').insert({ digest_date: digestDate });
  if (claim.error) return { statusCode: 200, body: 'already sent (or sending) for ' + digestDate };

  try {
    const data = await buildDigestData();
    // No `timeZone` option here on purpose — `local` is tzNow()'s
    // round-tripped Date object, whose plain getters/format-without-a-
    // timeZone-option already read as Auckland's own field values (see
    // the comment on startOfLocalDayUTC above). Passing `timeZone:
    // DIGEST_TIMEZONE` again here would shift it a second time, off an
    // already-shifted value.
    const dateLabel = local.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    const signupCount = (data.buckets.enrollment && data.buckets.enrollment.count) || 0;
    const subjectHighlight = signupCount
      ? `${signupCount} new signup${signupCount === 1 ? '' : 's'}`
      : (data.revenueToday ? money(data.revenueToday) + ' in activity' : 'quiet day');

    await resend.emails.send({
      from:    buildFrom('A Note For You — Digest'),
      to:      DIGEST_TO,
      subject: `📊 Daily digest — ${dateLabel} — ${subjectHighlight}`,
      html:    buildDigestHtml(data, dateLabel),
    });

    return { statusCode: 200, body: 'sent digest for ' + digestDate };
  } catch (e) {
    // The claim row is already inserted at this point — a failure here
    // means today's digest just doesn't go out rather than retrying every
    // 15 minutes for the rest of the send-hour window (which would risk
    // spamming Jake once whatever's wrong resolves mid-window). Logged so
    // it's visible in Netlify's function logs either way.
    console.error('daily-digest failed for ' + digestDate + ':', e);
    return { statusCode: 500, body: 'digest failed: ' + e.message };
  }
});
