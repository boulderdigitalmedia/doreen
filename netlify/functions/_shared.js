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

// ── Email "From" name ────────────────────────────────────────────
// FROM_EMAIL may be a bare address ("notes@domain.com") or already have a
// display name on it ("Pigeon Post <notes@domain.com>"). Either way we only
// want the address out of it — the display name is built per-email below so
// recipient-facing notes can say "A Note For You From <sender name>".
function fromAddress() {
  const raw = process.env.FROM_EMAIL || 'notes@yourdomain.com';
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1] : raw.trim();
}
function buildFrom(displayName) {
  return `${displayName} <${fromAddress()}>`;
}

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

async function sendPush(pushSubscription, noteNum, senderName, giftUrl) {
  const payload = JSON.stringify({
    title: `💚 A note from ${senderName || 'Your Favorite'}`,
    body:  `Note ${noteNum} — tap to read today's reason`,
    // This gift's own page, e.g. https://yoursite.com/jake-and-doreen —
    // NOT the homepage. sw.js's notificationclick reads this straight
    // through as the tap destination; falls back to '/' only if a caller
    // ever omits it.
    url:   giftUrl || '/'
  });
  await webpush.sendNotification(pushSubscription, payload);
}

// SMS can't render a distinct callout box the way the HTML emails below
// can (buildSmsBody is one plain-text line) — this is its stand-in for a
// voice-only note (no typed text — see notes.voice_url in schema.sql),
// so it isn't left quoting an empty string, or —worse— interpolating
// `null` literally if text is ever NULL rather than ''.
function noteQuoteText(note) {
  if (note.text) return note.text;
  if (note.voice_url) return '🎤 (a voice note — open the app to listen)';
  return '';
}

// The HTML emails, unlike SMS, have room for a proper callout instead of
// squeezing the voice-note prompt into the quote line — email clients
// can't play audio inline regardless, so this is deliberately a "go
// listen in the app" nudge rather than an attempt to embed the clip.
function voiceNoteEmailBanner(note) {
  if (!note.voice_url) return '';
  return `<tr>
    <td style="padding:0 32px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#e8f0e8;border:1px solid #c8dbc9;border-radius:12px;">
        <tr>
          <td style="padding:16px 20px;font-family:'DM Sans',sans-serif;font-size:14px;line-height:1.5;color:#4a5c4b;">
            🎤 <strong style="color:#2c3a2e;">This note includes a voice message.</strong>
            Email can't play it directly — tap below to open the app and listen.
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

// Voice-only notes (no note.text) deserve a CTA that says what's actually
// waiting, rather than the generic "Open the app" that reads like there's
// nothing there to open for.
function emailCtaLabel(note, defaultLabel) {
  return note.voice_url && !note.text ? '🎤 Listen to your note →' : defaultLabel;
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
        ${note.text ? `<tr>
          <td style="padding:0 32px 32px;">
            <p style="margin:0;font-size:20px;font-weight:300;font-style:italic;line-height:1.6;color:#2c3a2e;">
              "${note.text}"
            </p>
          </td>
        </tr>` : ''}
        ${voiceNoteEmailBanner(note)}
        <tr>
          <td style="padding:0 32px 36px;">
            <a href="${giftUrl}"
               style="display:inline-block;background:#7a9e7e;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:10px;font-size:14px;font-family:'DM Sans',sans-serif;font-weight:500;">
              ${emailCtaLabel(note, 'Open the app →')}
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

// The recipient's very first gift email — sent by sendGiftNotifications in
// place of the regular buildEmailHtml template, but only for noteNum === 1.
// Every later note still uses the plain "a new note is waiting" template;
// this one also orients them (who set this up, what to expect, how it'll
// reach them) before showing note 1 itself, so their first message doubles
// as an introduction instead of arriving as a bare, context-free note.

function frequencyLabel(gift) {
  if (gift.frequency === 'weekly')   return 'a new note every week';
  if (gift.frequency === 'biweekly') return 'a new note every two weeks';
  if (gift.frequency === 'monthly')  return 'a new note every month';
  return 'a new note every day';
}

function welcomeTourItems(gift, recipient) {
  const items = [];

  items.push({
    title: `A new note ${frequencyLabel(gift).replace('a new note ', '')}`,
    body: `Some are just a few words, some come with a photo — each one written by ${gift.sender_name || 'Your Favorite'} just for you. You can choose how you want to receive yours — text message, email, and/or push notifications. You can change that anytime from the settings icon on your gallery page.`
  });

  items.push({
    title: 'Nothing gets lost',
    body: `Every note you've been sent stays saved on your page, so you can always scroll back — bookmark your link and come back anytime to relive your memories.`
  });

  items.push({
    title: 'Save your favorites',
    body: `Tap the heart on any note to keep it in your Favorites, so the ones that mean the most to you are easy to find again later.`
  });

  items.push({
    title: "It's just for you",
    body: `Your page is protected by the password you set — no one else can open it without it, so it's a private space between you and ${gift.sender_name || 'Your Favorite'}.`
  });

  items.push({
    title: 'Share your favorite notes',
    body: `Found one that made your day? Tap the share icon in the top corner of any note to send it — photo and all — straight to a friend or family member by text, or to your favorite social app.`
  });

  items.push({
    title: 'Change your mind anytime',
    body: `Not loving text messages, or want your notes at a different time of day? Tap the settings icon on your page to update how and when they reach you, whenever and however you like.`
  });

  return items;
}

function buildFirstNoteEmailHtml(gift, note, recipient, giftUrl) {
  const senderName = gift.sender_name || 'Your Favorite';
  const photo = note.photo_url
    ? `<img src="${note.photo_url}" alt="" style="width:100%;max-width:496px;border-radius:12px;display:block;margin:0 auto 24px;" />`
    : '';
  const tourRows = welcomeTourItems(gift, recipient).map(function(item) {
    return `<tr>
      <td style="padding:0 0 20px;vertical-align:top;">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;padding-right:12px;">
            <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;background:#e8f0e8;color:#7a9e7e;border-radius:50%;font-size:12px;font-family:'DM Sans',sans-serif;">✦</span>
          </td>
          <td style="vertical-align:top;">
            <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#2c3a2e;font-family:'DM Sans',sans-serif;">${item.title}</p>
            <p style="margin:0;font-size:14px;line-height:1.6;color:#4a5c4b;font-family:'DM Sans',sans-serif;">${item.body}</p>
          </td>
        </tr></table>
      </td>
    </tr>`;
  }).join('');

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
            <p style="margin:4px 0 0;font-size:22px;font-weight:300;color:#2c3a2e;">${senderName}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 16px;">
            <span style="background:#e8f0e8;color:#7a9e7e;font-size:11px;font-family:'DM Sans',sans-serif;text-transform:uppercase;letter-spacing:0.08em;padding:4px 12px;border-radius:20px;border:1px solid #c8dbc9;">
              ✦ Welcome
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 14px;">
            <p style="margin:0;font-size:24px;font-weight:300;line-height:1.4;color:#2c3a2e;">
              ${senderName} set up <em>A Note For You</em>.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 28px;">
            <p style="margin:0;font-size:16px;line-height:1.7;color:#4a5c4b;font-family:'DM Sans',sans-serif;">
              It's a little corner of the internet made just for you — a small, steady reason to smile, written one note at a time by someone who's thinking of you. Here's what to expect:
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 8px;">
            <table width="100%" cellpadding="0" cellspacing="0">${tourRows}</table>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 32px 6px;border-top:1px solid #dde8dd;">
            <p style="margin:20px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#8fa391;font-family:'DM Sans',sans-serif;">
              And here's your very first note
            </p>
          </td>
        </tr>
        ${photo ? `<tr><td style="padding:16px 32px 20px;">${photo}</td></tr>` : ''}
        ${note.text ? `<tr>
          <td style="padding:0 32px 32px;">
            <p style="margin:0;font-size:20px;font-weight:300;font-style:italic;line-height:1.6;color:#2c3a2e;">
              "${note.text}"
            </p>
          </td>
        </tr>` : ''}
        ${voiceNoteEmailBanner(note)}
        <tr>
          <td style="padding:0 32px 36px;">
            <a href="${giftUrl}"
               style="display:inline-block;background:#7a9e7e;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:10px;font-size:14px;font-family:'DM Sans',sans-serif;font-weight:500;">
              ${emailCtaLabel(note, 'Open your gift →')}
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
  // Keep it short — first ~100 chars of note + link. Goes through
  // noteQuoteText() first — note.text is '' (not null) for photo/voice-only
  // notes, but .length/.substring() on a bare null would still crash this
  // send job outright, so this can't just assume a string.
  const quoteText = noteQuoteText(note);
  const preview = quoteText.length > 100
    ? quoteText.substring(0, 97) + '…'
    : quoteText;
  return `💚 Note ${noteNum} from ${gift.sender_name || 'Your Favorite'}: "${preview}" — ${giftUrl}`;
}

async function sendSms(phone, body, mediaUrl) {
  const payload = {
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to:   phone,
  };
  // Attaching mediaUrl turns this into an MMS (Twilio auto-detects based on
  // presence of media). The photo is already a public Supabase Storage URL,
  // so Twilio can fetch it directly — no extra upload/signing needed.
  if (mediaUrl) payload.mediaUrl = [mediaUrl];
  await twilioClient.messages.create(payload);
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
      from:    buildFrom('A Note For You'),
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

// ── Renewal reminder (fires ~30 days before a term ends) ────────────
// Neither plan auto-renews past its 12-month term anymore — annual is a
// one-time payment (create-checkout.js) and installment's cancel_at
// forcibly ends it (stripe-webhook.js) — so without this, a buyer who
// doesn't happen to check their account page only finds out their gift
// stopped once it already had. Called from send-daily.js's
// sweepRenewalReminders, which also stamps profiles.renewal_reminder_
// sent_at so this only ever goes out once per term (see schema.sql).
async function sendRenewalReminderEmail(profile) {
  try {
    const { data: userData, error: userErr } = await sb.auth.admin.getUserById(profile.id);
    const buyerEmail = userData && userData.user && userData.user.email;
    if (userErr || !buyerEmail) {
      console.error(`Could not find buyer email for renewal reminder, profile ${profile.id}:`, userErr && userErr.message);
      return;
    }

    const termEndLabel = new Date(profile.access_term_end).toLocaleDateString();
    const accountUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/account`;

    const isGiftPack = profile.plan === 'gift_pack';
    const planNote = isGiftPack
      ? "Your 30-Day Gift Pack is a one-time payment, so it won't renew on its own — come back and buy another gift pack (or upgrade to the annual plan) to keep it going."
      : "Your annual plan is a one-time yearly payment, so it won't renew on its own — you'll need to come back and check out again for a new 12-month term.";
    const termLabel = isGiftPack ? 'Your current 30-day term' : 'Your current 12-month term';

    await resend.emails.send({
      from:    buildFrom('A Note For You'),
      to:      buyerEmail,
      subject: `Your term ends ${termEndLabel} — renew to keep it going`,
      html: `<div style="font-family:'DM Sans',Arial,sans-serif;color:#2c3a2e;max-width:520px;margin:0 auto;padding:24px;">
        <p style="font-size:16px;">${termLabel} ends on <strong>${termEndLabel}</strong>.</p>
        <p style="font-size:16px;">${planNote} Once it ends, your gift(s) stop sending new notes — though everything already sent stays visible to your recipient(s).</p>
        <p><a href="${accountUrl}" style="display:inline-block;background:#7a9e7e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;">Renew from your account →</a></p>
      </div>`,
    });
  } catch (err) {
    console.error(`Failed to send renewal reminder for profile ${profile.id}:`, err.message);
  }
}

// ── Re-engagement nudge (fires after a stretch of no app activity) ──
// Billing state alone doesn't tell you whether a paying buyer is actually
// using the thing they're paying for — this is the "come back and check
// on your gift" email for someone who is (last_active_at is stamped by
// touch-activity.js, called from account.html's boot()). Called from
// send-daily.js's sweepReengagement, which also stamps profiles.
// reengagement_email_sent_at so this only fires once per dormancy episode
// — touch-activity.js clears that column the moment they're active again,
// so a later lapse is eligible for a fresh nudge (unlike the one-time-ever
// gift_setup_reminder_sent_at).
// noteStatus is the WORST status (see getGiftNoteStatus) across all of
// this buyer's active gifts, computed by sweepReengagement before calling
// this — never guessed here. 'out' and 'low' get an honest, specific
// warning; 'ok' gets a genuine (verified, not assumed) all-clear instead
// of a generic "probably fine."
async function sendReengagementEmail(profile, daysSinceActive, noteStatus) {
  try {
    const { data: userData, error: userErr } = await sb.auth.admin.getUserById(profile.id);
    const buyerEmail = userData && userData.user && userData.user.email;
    if (userErr || !buyerEmail) {
      console.error(`Could not find buyer email for re-engagement nudge, profile ${profile.id}:`, userErr && userErr.message);
      return;
    }

    const accountUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/account`;

    const statusLine = noteStatus === 'out'
      ? `One of your gifts is <strong>currently out of written notes</strong> — your recipient won't get anything new until you add more.`
      : noteStatus === 'low'
        ? `One of your gifts is <strong>running low on upcoming notes</strong> — worth adding a few more soon so you don't run out.`
        : `Your notes are all set for now — no shortage on any active gift.`;

    await resend.emails.send({
      from:    buildFrom('A Note For You'),
      to:      buyerEmail,
      subject: noteStatus === 'out'
        ? `Your gift is out of notes — and we haven't seen you in a while`
        : `It's been a while — everything okay with your gift?`,
      html: `<div style="font-family:'DM Sans',Arial,sans-serif;color:#2c3a2e;max-width:520px;margin:0 auto;padding:24px;">
        <p style="font-size:16px;">We haven't seen you in your account in a while (about ${daysSinceActive} days) — just checking in.</p>
        <p style="font-size:16px;">${statusLine}</p>
        <p><a href="${accountUrl}" style="display:inline-block;background:#7a9e7e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;">Check on your gift →</a></p>
      </div>`,
    });
  } catch (err) {
    console.error(`Failed to send re-engagement nudge for profile ${profile.id}:`, err.message);
  }
}

// ── Gift setup reminder (fires ~5 days before the 30-day auto-start) ──
// A buyer who subscribes but never actually creates their included gift
// still gets their 12-month term auto-started 30 days after signup
// (send-daily.js's sweepTermStartGrace) — anchored to created_at + 30
// days rather than a start_date they chose, since there's no gift to
// pull one from. That clock runs whether or not they ever set anything
// up, so this gives them a heads-up first. Called from send-daily.js's
// sweepGiftSetupReminders, which also stamps profiles.gift_setup_
// reminder_sent_at so this only ever goes out once (see schema.sql —
// unlike the renewal reminder, this never needs to reset).
async function sendGiftSetupReminderEmail(profile, autoStartDate) {
  try {
    const { data: userData, error: userErr } = await sb.auth.admin.getUserById(profile.id);
    const buyerEmail = userData && userData.user && userData.user.email;
    if (userErr || !buyerEmail) {
      console.error(`Could not find buyer email for gift-setup reminder, profile ${profile.id}:`, userErr && userErr.message);
      return;
    }

    const autoStartLabel = autoStartDate.toLocaleDateString();
    const accountUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/account`;

    await resend.emails.send({
      from:    buildFrom('A Note For You'),
      to:      buyerEmail,
      subject: `Set up your gift before ${autoStartLabel}`,
      html: `<div style="font-family:'DM Sans',Arial,sans-serif;color:#2c3a2e;max-width:520px;margin:0 auto;padding:24px;">
        <p style="font-size:16px;">Looks like you haven't set up your gift yet.</p>
        <p style="font-size:16px;">Your 12-month term starts automatically on <strong>${autoStartLabel}</strong> whether or not your gift is ready by then — so any time between now and that date is time you won't get back once the clock starts.</p>
        <p><a href="${accountUrl}" style="display:inline-block;background:#7a9e7e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;">Set up your gift now →</a></p>
      </div>`,
    });
  } catch (err) {
    console.error(`Failed to send gift-setup reminder for profile ${profile.id}:`, err.message);
  }
}

// NOTE: sendTrialPaymentFailedEmail / sendTrialExpiredEmail (and the
// process-annual-trials.js scheduled function that called them) were
// removed when both plans dropped their free trial — see the PRICING
// UPDATE block in schema.sql. Both plans are now charged immediately at
// checkout, so there's no self-managed trial clock left to email about.

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

// ── Note-shortage check — standalone, once per gift per day ─────────
// Previously this only ran as the tail end of a successful
// sendGiftNotifications call, which meant it silently never fired for a
// gift with no recipient yet (or a recipient who hasn't picked
// notification channels — sendGiftNotifications bails out before this
// point in both cases), and for weekly/biweekly/monthly gifts it was only
// reachable on their actual send day, since the outer send-daily.js loop
// only calls sendGiftNotifications when shouldSendToday is already true.
// A buyer testing a fresh gift, or one on an off-day for a non-daily
// cadence, would see no alert at all despite having zero notes written.
//
// Called from send-daily.js's sweepNoteShortageChecks instead — once per
// gift per day (gated there by isDeliveryWindow, using the gift's own
// default delivery_time/timezone even absent a recipient), independent
// of whether today happens to be a scheduled send day or whether a
// recipient/channels exist yet.
async function checkNoteShortage(gift, recipient) {
  if (shouldSendToday(gift, recipient)) {
    const todayIndex = getNoteIndex(gift, recipient, 0);
    const { data: note } = await sb
      .from('notes')
      .select('id')
      .eq('gift_id', gift.id)
      .eq('order_index', todayIndex)
      .maybeSingle();

    if (!note) await sendNoteShortageAlert(gift, todayIndex, false);
  }

  await checkUpcomingNoteShortage(gift, recipient);
}

// ── Note supply status for one gift — 'out' / 'low' / 'ok' ──────────
// Used by sendReengagementEmail so it can tell a dormant buyer something
// actually true about their gift instead of assuming everything's fine.
// 'out'  — today's required slot has no note at all (matches the "today"
//          half of checkNoteShortage above).
// 'low'  — today's slot is covered, but fewer than NOTE_BUFFER_SIZE of
//          the upcoming slots after it are written yet.
// 'ok'   — comfortably ahead.
const NOTE_BUFFER_SIZE = 5;
async function getGiftNoteStatus(gift) {
  const todayIndex = getNoteIndex(gift, null, 0);

  const { data: notes } = await sb
    .from('notes')
    .select('order_index')
    .eq('gift_id', gift.id)
    .gte('order_index', todayIndex)
    .lt('order_index', todayIndex + NOTE_BUFFER_SIZE);

  const indices = new Set((notes || []).map((n) => n.order_index));
  if (!indices.has(todayIndex)) return 'out';
  if (indices.size < NOTE_BUFFER_SIZE) return 'low';
  return 'ok';
}

// ── Core send function ───────────────────────────────────────────

// ── Fair term start (anchored to the start_date the buyer chose) ───
// See the long comment in schema.sql next to profiles.term_start_date/
// access_term_end for the full rationale. The buyer's 12-month "access
// term" is anchored to whatever start_date they picked for their
// included gift in the dashboard — known the moment that gift is
// created, not something that has to wait to be observed. Setting it is
// handled by a Postgres trigger on gifts (anchor_term_from_gift_start in
// schema.sql), not here — that fires atomically on the INSERT itself
// regardless of whether the row came from account.html's direct client
// insert or any server-side path, which a Node-side hook couldn't
// guarantee as reliably. send-daily.js's scheduled sweep is the only
// remaining fallback, for the rare case of a buyer who paid but never
// actually finished creating their included gift at all (30 days after
// signup, same cap as before).
//
// Kept here (and exported) for send-daily.js's grace-period sweep to
// call for that fallback case — the normal, expected path no longer
// calls this from _shared.js itself; it's applied directly by the
// schema.sql trigger instead.
async function applyTermStart(userId, termStart, termEnd) {
  await sb.from('profiles').update({
    term_start_date: termStart.toISOString(),
    access_term_end: termEnd.toISOString(),
    // New term, so any reminder already sent for the previous one no
    // longer applies — see the renewal_reminder_sent_at comment in
    // schema.sql.
    renewal_reminder_sent_at: null,
  }).eq('id', userId);

  await sb.from('gifts')
    .update({ term_end_date: termEnd.toISOString() })
    .eq('user_id', userId)
    .in('gift_type', ['included', 'addon']);
}

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

  // Alerting on a missing note is handled entirely by send-daily.js's
  // sweepNoteShortageChecks now (via checkNoteShortage) — decoupled from
  // this function so it still fires even when there's no recipient/
  // channels configured yet, or on an off-day for a non-daily cadence.
  // This still has to bail out of an actual send attempt, though.
  if (!note) {
    return { skipped: true, reason: `No note at index ${noteIndex}` };
  }

  const noteNum = noteIndex + 1;
  const giftUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/${gift.slug}`;
  const results = {};

  // Push
  if (recipient.channels.includes('push') && recipient.push_subscription) {
    try {
      await sendPush(recipient.push_subscription, noteNum, gift.sender_name, giftUrl);
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

  // Email — note 1 gets the richer "first gift message" (welcome content
  // plus the note itself, all in one email); every later note gets the
  // plain "a new note is waiting" template.
  if (recipient.channels.includes('email') && recipient.email) {
    try {
      const isFirstNote = noteNum === 1;
      await resend.emails.send({
        from:    buildFrom(`A Note For You From ${gift.sender_name || 'Your Favorite'}`),
        to:      recipient.email,
        subject: isFirstNote
          ? `💚 ${gift.sender_name || 'Your Favorite'} set up something special for you`
          : `💚 Note ${noteNum} from ${gift.sender_name || 'Your Favorite'} is waiting for you`,
        html: isFirstNote
          ? buildFirstNoteEmailHtml(gift, note, recipient, giftUrl)
          : buildEmailHtml(gift, note, noteNum, giftUrl)
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
      await sendSms(recipient.phone, body, note.photo_url || null);
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

// ── Note-reply notifications ────────────────────────────────────
// Two directions for the same thread (see the RECIPIENT REPLIES block in
// schema.sql, submit-note-reply.js and send-note-reply.js). The recipient
// has no account to check channel preferences on, so a recipient reply
// always notifies the buyer by email (they're already signed in and
// checking account.html). A buyer reply notifies the recipient on
// whichever channels they already get notes on (push/email/sms), same
// gating as sendGiftNotifications above. Both are called fire-and-forget
// from their respective functions — the reply is already saved in
// note_replies by the time either of these runs, so a notification hiccup
// here must never bubble up as a failed send. Every branch is caught
// internally for that reason — callers do not (and should not) wrap
// these in their own try/catch.

async function sendRecipientReplyEmail(gift, note, msgBody) {
  try {
    const { data: userData, error: userErr } = await sb.auth.admin.getUserById(gift.user_id);
    const buyerEmail = userData && userData.user && userData.user.email;
    if (userErr || !buyerEmail) {
      console.error(`Could not find buyer email for reply notification, gift ${gift.id}:`, userErr && userErr.message);
      return;
    }

    const accountUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/account`;
    const preview = msgBody.length > 200 ? msgBody.substring(0, 197) + '…' : msgBody;

    await resend.emails.send({
      from:    buildFrom('A Note For You'),
      to:      buyerEmail,
      subject: `💬 New reply on "${gift.display_name}"`,
      html: `<div style="font-family:'DM Sans',Arial,sans-serif;color:#2c3a2e;max-width:520px;margin:0 auto;padding:24px;">
        <p style="font-size:16px;">Your recipient replied to a note on <strong>${gift.display_name}</strong>:</p>
        <div style="background:#f4f7f2;border-radius:10px;padding:16px;margin:16px 0;font-size:15px;font-style:italic;">"${preview}"</div>
        <p><a href="${accountUrl}" style="display:inline-block;background:#7a9e7e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;">Reply from your dashboard →</a></p>
      </div>`,
    });
  } catch (err) {
    console.error(`Failed to send recipient-reply email for gift ${gift.id}:`, err.message);
  }
}

async function sendBuyerReplyNotification(gift, recipient, note, msgBody) {
  if (!recipient || !recipient.channels || recipient.channels.length === 0) return;

  const giftUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/${gift.slug}`;
  const preview = msgBody.length > 100 ? msgBody.substring(0, 97) + '…' : msgBody;

  if (recipient.channels.includes('push') && recipient.push_subscription) {
    try {
      const payload = JSON.stringify({
        title: `💬 ${gift.sender_name || 'Your Favorite'} replied`,
        body:  preview,
        url:   giftUrl,
      });
      await webpush.sendNotification(recipient.push_subscription, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await sb.from('recipients')
          .update({ push_subscription: null, channels: recipient.channels.filter(c => c !== 'push') })
          .eq('id', recipient.id);
      } else {
        console.error(`Failed to push buyer-reply notification for gift ${gift.id}:`, err.message);
      }
    }
  }

  if (recipient.channels.includes('email') && recipient.email) {
    try {
      await resend.emails.send({
        from:    buildFrom(`A Note For You From ${gift.sender_name || 'Your Favorite'}`),
        to:      recipient.email,
        subject: `💬 ${gift.sender_name || 'Your Favorite'} replied to your message`,
        html: `<div style="font-family:'DM Sans',Arial,sans-serif;color:#2c3a2e;max-width:520px;margin:0 auto;padding:24px;">
          <p style="font-size:16px;"><strong>${gift.sender_name || 'Your Favorite'}</strong> replied to your message:</p>
          <div style="background:#f4f7f2;border-radius:10px;padding:16px;margin:16px 0;font-size:15px;font-style:italic;">"${preview}"</div>
          <p><a href="${giftUrl}" style="display:inline-block;background:#7a9e7e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;">Read and reply →</a></p>
        </div>`,
      });
    } catch (err) {
      console.error(`Failed to email buyer-reply notification for gift ${gift.id}:`, err.message);
    }
  }

  if (recipient.channels.includes('sms') && gift.sms_addon && recipient.phone) {
    try {
      await sendSms(recipient.phone, `💚 ${gift.sender_name || 'Your Favorite'} replied: "${preview}" — ${giftUrl}`);
    } catch (err) {
      console.error(`Failed to SMS buyer-reply notification for gift ${gift.id}:`, err.message);
    }
  }
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
  resend,
  getNoteIndex,
  shouldSendToday,
  isDeliveryWindow,
  sendGiftNotifications,
  checkNoteShortage,
  getGiftNoteStatus,
  applyTermStart,
  sendRenewalReminderEmail,
  sendGiftSetupReminderEmail,
  sendReengagementEmail,
  sendRecipientReplyEmail,
  sendBuyerReplyNotification,
  buildEmailHtml,
  buildFirstNoteEmailHtml,
  buildFrom,
  ok, err, preflight
};
