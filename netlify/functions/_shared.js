// ── Shared utilities for all Netlify Functions (Phase 5 — with Twilio SMS)
const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');
const webpush          = require('web-push');
const twilio           = require('twilio');

// ── Clients ──────────────────────────────────────────────────────
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'you@example.com'}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Date helpers ─────────────────────────────────────────────────
// Day/time math is done in the *effective* timezone — the recipient's own
// choice if they've set one, otherwise the gift's buyer-set default —
// which matches how isDeliveryWindow decides *when* to send. Using the
// same resolution everywhere means the note index the page shows and the
// note index an email actually delivers can't disagree.

// `gift.start_date` comes back from Postgres as a plain "YYYY-MM-DD"
// string. `new Date('YYYY-MM-DD')` parses that as UTC midnight, which
// then gets shifted onto the *previous* local calendar day by any
// downstream .setHours(0,0,0,0) call in a timezone behind UTC — a classic
// off-by-one that made the site and emails disagree by a full day for
// recipients west of UTC. Parsing the pieces directly avoids that.
function parseLocalDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function resolveTimezone(gift, recipient) {
  return (recipient && recipient.timezone) || (gift && gift.timezone) || 'Pacific/Auckland';
}

function tzNow(timezone) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
}

// dayOffset lets callers ask "what would this be N days from now" — used
// to check tomorrow's note requirement in advance (see
// checkUpcomingNoteShortage below), without duplicating this math.
function getDaysElapsed(gift, recipient, dayOffset = 0) {
  const start = parseLocalDate(gift.start_date);
  start.setHours(0, 0, 0, 0);
  const now = tzNow(resolveTimezone(gift, recipient));
  now.setHours(0, 0, 0, 0);
  now.setDate(now.getDate() + dayOffset);
  return Math.max(0, Math.floor((now - start) / 86400000));
}

function getNoteIndex(gift, recipient, dayOffset = 0) {
  const days = getDaysElapsed(gift, recipient, dayOffset);
  if (gift.frequency === 'weekly')   return Math.floor(days / 7);
  if (gift.frequency === 'biweekly') return Math.floor(days / 14);
  if (gift.frequency === 'monthly') {
    const start = parseLocalDate(gift.start_date);
    const now   = tzNow(resolveTimezone(gift, recipient));
    now.setDate(now.getDate() + dayOffset);
    return Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()));
  }
  return days;
}

function shouldSendToday(gift, recipient) {
  const days = getDaysElapsed(gift, recipient);
  if (days === 0)                    return true;
  if (gift.frequency === 'daily')    return true;
  if (gift.frequency === 'weekly')   return days % 7  === 0;
  if (gift.frequency === 'biweekly') return days % 14 === 0;
  if (gift.frequency === 'monthly') {
    const start = parseLocalDate(gift.start_date);
    const now   = tzNow(resolveTimezone(gift, recipient));
    return now.getDate() === start.getDate();
  }
  return true;
}

// Is it currently the recipient's chosen delivery time (falling back to
// the gift's default if the recipient hasn't set their own), in whichever
// timezone applies? send-daily.js runs every 15 minutes, so this matches
// within that same 15-minute bucket rather than requiring an exact match.
function isDeliveryWindow(gift, recipient, windowMinutes = 15) {
  const timezone     = resolveTimezone(gift, recipient);
  const deliveryTime = (recipient && recipient.delivery_time)  || gift.delivery_time || '08:00:00';

  const now = tzNow(timezone);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const [h, m] = deliveryTime.split(':').map(Number);
  const targetMinutes = h * 60 + m;

  return Math.floor(nowMinutes / windowMinutes) === Math.floor(targetMinutes / windowMinutes);
}

// ── Push ────────────────────────────────────────────────────────

async function sendPush(pushSubscription, noteNum, senderName) {
  const payload = JSON.stringify({
    title: `💚 A note from ${senderName || 'Your Favorite'}`,
    body:  `Note ${noteNum} — tap to read today's reason`,
    url:   '/'
  });
  await webpush.sendNotification(pushSubscription, payload);
}

// ── Email ────────────────────────────────────────────────────────

function buildEmailHtml(gift, note, noteNum, giftUrl) {
  const photo = note.photo_url
    ? `<img src="${note.photo_url}" alt="" style="width:100%;max-width:560px;border-radius:12px;display:block;margin:0 auto 28px;" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f5f2ec;font-family:'Georgia',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ec;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #dde8dd;">
        <tr>
          <td style="padding:28px 32px 20px;border-bottom:1px solid #dde8dd;">
            <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:#8fa391;font-family:'DM Sans',sans-serif;">From</p>
            <p style="margin:4px 0 0;font-size:22px;font-weight:300;color:#2c3a2e;">${gift.sender_name || 'Your Favorite'}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 16px;">
            <span style="background:#e8f0e8;color:#7a9e7e;font-size:11px;font-family:'DM Sans',sans-serif;text-transform:uppercase;letter-spacing:0.08em;padding:4px 12px;border-radius:20px;border:1px solid #c8dbc9;">
              Note ${noteNum}
            </span>
          </td>
        </tr>
        ${photo ? `<tr><td style="padding:0 32px 24px;">${photo}</td></tr>` : ''}
        <tr>
          <td style="padding:0 32px 32px;">
            <p style="margin:0;font-size:20px;font-weight:300;font-style:italic;line-height:1.6;color:#2c3a2e;">
              "${note.text}"
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 36px;">
            <a href="${giftUrl}"
               style="display:inline-block;background:#7a9e7e;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:10px;font-size:14px;font-family:'DM Sans',sans-serif;font-weight:500;">
              Open the app →
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #dde8dd;">
            <p style="margin:0;font-size:12px;color:#8fa391;font-family:'DM Sans',sans-serif;">
              You're receiving this because someone special set this up for you.
              <br>Visit <a href="${giftUrl}" style="color:#7a9e7e;">${giftUrl}</a> anytime.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── SMS ──────────────────────────────────────────────────────────

function buildSmsBody(gift, note, noteNum, giftUrl) {
  // Keep it short — first ~100 chars of note + link
  const preview = note.text.length > 100
    ? note.text.substring(0, 97) + '…'
    : note.text;
  return `💚 Note ${noteNum} from ${gift.sender_name || 'Your Favorite'}: "${preview}" — ${giftUrl}`;
}

async function sendSms(phone, body) {
  await twilioClient.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to:   phone,
  });
}

// ── Low-notes alert (to the buyer, not the recipient) ─────────────
// Two triggers:
//   - "due today"    → a scheduled delivery had nothing to send, right now.
//   - "due tomorrow" → checkUpcomingNoteShortage (below) looked one day
//                      ahead and found tomorrow's slot is also empty, so
//                      the buyer gets a heads-up a day early instead of
//                      finding out only once the recipient already missed it.

async function sendNoteShortageAlert(gift, noteIndex, isAdvanceWarning = false) {
  try {
    const { data: userData, error: userErr } = await sb.auth.admin.getUserById(gift.user_id);
    const buyerEmail = userData && userData.user && userData.user.email;
    if (userErr || !buyerEmail) {
      console.error(`Could not find buyer email for gift ${gift.id}:`, userErr && userErr.message);
      return;
    }

    const dashboardUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/account`;
    const subject = isAdvanceWarning
      ? `⚠ "${gift.display_name}" needs a note for tomorrow`
      : `⚠ "${gift.display_name}" is out of notes`;
    const message = isAdvanceWarning
      ? `<strong>${gift.display_name}</strong> is set to send Note ${noteIndex + 1} tomorrow, but it hasn't been written yet.`
      : `<strong>${gift.display_name}</strong> was due to send Note ${noteIndex + 1} today, but no note has been written for that slot yet, so today's delivery was skipped.`;

    await resend.emails.send({
      from:    process.env.FROM_EMAIL || 'notes@yourdomain.com',
      to:      buyerEmail,
      subject,
      html: `<div style="font-family:'DM Sans',Arial,sans-serif;color:#2c3a2e;max-width:520px;margin:0 auto;padding:24px;">
        <p style="font-size:16px;">Heads up — ${message}</p>
        <p style="font-size:16px;">Add more notes from your dashboard so your recipient doesn't miss a day:</p>
        <p><a href="${dashboardUrl}" style="display:inline-block;background:#7a9e7e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;">Open your dashboard →</a></p>
      </div>`,
    });
  } catch (err) {
    console.error(`Failed to send note-shortage alert for gift ${gift.id}:`, err.message);
  }
}

// Looks one day ahead (in the gift's own day-counting) and warns the buyer
// early if tomorrow's slot needs a *new* note that doesn't exist yet. If
// tomorrow's note index is the same as today's (e.g. mid-week for a weekly
// gift), nothing new is needed tomorrow, so this is a no-op.
async function checkUpcomingNoteShortage(gift, recipient) {
  const todayIndex    = getNoteIndex(gift, recipient, 0);
  const tomorrowIndex = getNoteIndex(gift, recipient, 1);

  if (tomorrowIndex === todayIndex) return;

  const { data: note } = await sb
    .from('notes')
    .select('id')
    .eq('gift_id', gift.id)
    .eq('order_index', tomorrowIndex)
    .maybeSingle();

  if (!note) {
    await sendNoteShortageAlert(gift, tomorrowIndex, true);
  }
}

// ── Core send function ───────────────────────────────────────────

async function sendGiftNotifications(gift, force = false) {
  const { data: recipient } = await sb
    .from('recipients')
    .select('*')
    .eq('gift_id', gift.id)
    .maybeSingle();

  if (!recipient || !recipient.channels || recipient.channels.length === 0) {
    return { skipped: true, reason: 'No recipient or no channels set up' };
  }

  if (!force && !shouldSendToday(gift, recipient)) {
    return { skipped: true, reason: `Not a send day (${gift.frequency})` };
  }

  const noteIndex = getNoteIndex(gift, recipient);
  const { data: note } = await sb
    .from('notes')
    .select('*')
    .eq('gift_id', gift.id)
    .eq('order_index', noteIndex)
    .maybeSingle();

  if (!note) {
    await sendNoteShortageAlert(gift, noteIndex);
    return { skipped: true, reason: `No note at index ${noteIndex}` };
  }

  const noteNum = noteIndex + 1;
  const giftUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/${gift.slug}`;
  const results = {};

  // Push
  if (recipient.channels.includes('push') && recipient.push_subscription) {
    try {
      await sendPush(recipient.push_subscription, noteNum, gift.sender_name);
      results.push = 'sent';
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await sb.from('recipients')
          .update({ push_subscription: null, channels: recipient.channels.filter(c => c !== 'push') })
          .eq('id', recipient.id);
        results.push = 'expired — cleared';
      } else {
        results.push = `error: ${err.message}`;
      }
    }
  }

  // Email
  if (recipient.channels.includes('email') && recipient.email) {
    try {
      await resend.emails.send({
        from:    process.env.FROM_EMAIL || 'notes@yourdomain.com',
        to:      recipient.email,
        subject: `💚 Note ${noteNum} from ${gift.sender_name || 'Your Favorite'} is waiting for you`,
        html:    buildEmailHtml(gift, note, noteNum, giftUrl)
      });
      results.email = 'sent';
    } catch (err) {
      results.email = `error: ${err.message}`;
    }
  }

  // SMS (gated: buyer must have sms_addon enabled, recipient must have chosen SMS + provided phone)
  if (recipient.channels.includes('sms') && gift.sms_addon && recipient.phone) {
    try {
      const body = buildSmsBody(gift, note, noteNum, giftUrl);
      await sendSms(recipient.phone, body);
      results.sms = 'sent';
    } catch (err) {
      results.sms = `error: ${err.message}`;
    }
  } else if (recipient.channels.includes('sms') && !gift.sms_addon) {
    results.sms = 'skipped — sms_addon not enabled for this gift';
  }

  console.log(`[${gift.slug}] note ${noteNum}:`, results);

  // Today's note went out fine — now peek at tomorrow so a gap gets caught
  // a day early instead of only being discovered when it's already due.
  await checkUpcomingNoteShortage(gift, recipient);

  return { sent: true, noteNum, results };
}

// ── HTTP helpers ─────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function ok(body)       { return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(body) }; }
function err(msg, code) { return { statusCode: code || 400, headers: corsHeaders, body: JSON.stringify({ error: msg }) }; }
function preflight()    { return { statusCode: 204, headers: corsHeaders, body: '' }; }

module.exports = {
  sb,
  getNoteIndex,
  shouldSendToday,
  isDeliveryWindow,
  sendGiftNotifications,
  ok, err, preflight
};
