// POST /api/send-welcome-email
// Body: { slug }
//
// Fired once, client-side, right after a recipient finishes onboarding on
// gift.html (see submitOnboarding() there) — separate from the "a new note
// is waiting" emails sent by sendGiftNotifications, which reuse the same
// template for every delivery including note 1. This is a one-time
// orientation email: who set this up, what to expect, how it'll reach them.
//
// No auth — this runs from the public gift page, same trust level as the
// recipient's own anon upsert into `recipients`. Idempotent via
// recipients.welcome_sent_at: safe to call more than once (e.g. a retried
// request), only ever sends for real the first time.

const { sb, resend, buildWelcomeEmailHtml, buildFrom, ok, err, preflight } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return err('Invalid request body');
  }

  const { slug } = body;
  if (!slug) return err('Missing slug');

  const { data: gift, error: giftErr } = await sb
    .from('gifts')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();

  if (giftErr || !gift) return err('Gift not found', 404);

  const { data: recipient, error: recErr } = await sb
    .from('recipients')
    .select('*')
    .eq('gift_id', gift.id)
    .maybeSingle();

  if (recErr || !recipient) return err('Recipient not found', 404);

  // Already sent — no-op, not an error (the client fires this fire-and-forget).
  if (recipient.welcome_sent_at) return ok({ skipped: true, reason: 'Already sent' });

  // Nothing to email if they didn't choose email as a channel, or haven't
  // given an address — still mark it sent so we don't keep checking.
  if (!recipient.channels || !recipient.channels.includes('email') || !recipient.email) {
    await sb.from('recipients').update({ welcome_sent_at: new Date().toISOString() }).eq('id', recipient.id);
    return ok({ skipped: true, reason: 'No email channel' });
  }

  const giftUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/${gift.slug}`;

  try {
    await resend.emails.send({
      from:    buildFrom(`A Note For You From ${gift.sender_name || 'Your Favorite'}`),
      to:      recipient.email,
      subject: `💚 ${gift.sender_name || 'Your Favorite'} set up something special for you`,
      html:    buildWelcomeEmailHtml(gift, recipient, giftUrl),
    });
  } catch (e) {
    return err('Could not send welcome email: ' + e.message, 500);
  }

  await sb.from('recipients').update({ welcome_sent_at: new Date().toISOString() }).eq('id', recipient.id);

  return ok({ sent: true, to: recipient.email });
};
