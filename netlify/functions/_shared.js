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
// All day/time math is done in the gift's own `timezone` (buyer-chosen),
// not the server's — falls back to the original NZ default for any gift
// created before this column existed.

function getGiftNow(gift) {
  const tz = (gift && gift.timezone) || 'Pacific/Auckland';
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

function getDaysElapsed(gift) {
  const start = new Date(gift.start_date);
  start.setHours(0, 0, 0, 0);
  const now = getGiftNow(gift);
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((now - start) / 86400000));
}

function getNoteIndex(gift) {
  const days = getDaysElapsed(gift);
  if (gift.frequency === 'weekly')   return Math.floor(days / 7);
  if (gift.frequency === 'biweekly') return Math.floor(days / 14);
  if (gift.frequency === 'monthly') {
    const start = new Date(gift.start_date);
    const now   = getGiftNow(gift);
    return Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()));
  }
  return days;
}

function shouldSendToday(gift) {
  const days = getDaysElapsed(gift);
  if (days === 0)                    return true;
  if (gift.frequency === 'daily')    return true;
  if (gift.frequency === 'weekly')   return days % 7  === 0;
  if (gift.frequency === 'biweekly') return days % 14 === 0;
  if (gift.frequency === 'monthly') {
    const start = new Date(gift.start_date);
    const now   = getGiftNow(gift);
    return now.getDate() === start.getDate();
  }
  return true;
}

// Is it currently the recipient's chosen delivery time (falling back to
// the gift's default if the recipient hasn't set their own), in whichever
// timezone applies? send-daily.js runs every 15 minutes, so this matches
// within that same 15-minute bucket rather than requiring an exact match.
function isDeliveryWindow(gift, recipient, windowMinutes = 15) {
  const timezone     = (recipient && recipient.timezone)      || gift.timezone      || 'Pacific/Auckland';
  const deliveryTime = (recipient && recipient.delivery_time)  || gift.delivery_time || '08:00:00';

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
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

// ── Core send function ───────────────────────────────────────────

async function sendGiftNotifications(gift, force = false) {
  if (!force && !shouldSendToday(gift)) {
    return { skipped: true, reason: `Not a send day (${gift.frequency})` };
  }

  const { data: recipient } = await sb
    .from('recipients')
    .select('*')
    .eq('gift_id', gift.id)
    .single();

  if (!recipient || !recipient.channels || recipient.channels.length === 0) {
    return { skipped: true, reason: 'No recipient or no channels set up' };
  }

  const noteIndex = getNoteIndex(gift);
  const { data: note } = await sb
    .from('notes')
    .select('*')
    .eq('gift_id', gift.id)
    .eq('order_index', noteIndex)
    .single();

  if (!note) {
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
