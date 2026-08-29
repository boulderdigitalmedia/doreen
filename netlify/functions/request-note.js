// POST /api/request-note
// Body: { slug }
//
// The recipient-initiated "nudge" from gift.html's pending state — shown
// in place of the card once today's slot comes up with nothing written
// yet (see frontNoteMissing()/updatePendingState() there). No auth
// required, same trust boundary as submit-note-reply.js: the recipient
// only has the gift's slug, not a Supabase account.
//
// Re-derives today's note index server-side (getNoteIndex, the exact math
// the page itself uses) rather than trusting anything from the client,
// and re-checks that the slot is actually empty before emailing — a
// stale tab left open past midnight, or one that raced the buyer writing
// the note moments earlier, shouldn't fire off a pointless "hurry up"
// email.
//
// Rate-limited via recipients.last_nudge_sent_at so mashing the button
// (or two open tabs/devices) can't spam the buyer's inbox — at most one
// nudge per NUDGE_COOLDOWN_MS, no matter how many times it's tapped in
// that window. gift.html's sendNudge() treats a 429 here the same as a
// successful send, since either way the buyer's already been asked
// recently.

const { sb, getNoteIndex, sendNoteRequestEmail, ok, err, preflight } = require('./_shared');

const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }

  const slug = (body.slug || '').trim();
  if (!slug) return err('slug is required');

  const { data: gift, error: giftErr } = await sb
    .from('gifts')
    .select('id, user_id, slug, display_name, sender_name, status, start_date, frequency, delivery_time, timezone')
    .eq('slug', slug)
    .maybeSingle();

  if (giftErr || !gift) return err('Gift not found', 404);
  if (gift.status !== 'active') {
    return err('This gift is no longer active', 409);
  }

  const { data: recipient } = await sb
    .from('recipients')
    .select('*')
    .eq('gift_id', gift.id)
    .maybeSingle();

  if (recipient && recipient.last_nudge_sent_at) {
    const elapsed = Date.now() - new Date(recipient.last_nudge_sent_at).getTime();
    if (elapsed < NUDGE_COOLDOWN_MS) {
      return err('Already nudged recently — give it a little time', 429);
    }
  }

  const noteIndex = getNoteIndex(gift, recipient);
  const { data: existingNote } = await sb
    .from('notes')
    .select('id')
    .eq('gift_id', gift.id)
    .eq('order_index', noteIndex)
    .maybeSingle();

  if (existingNote) {
    return err('Today’s note is already there — refresh to see it', 409);
  }

  await sendNoteRequestEmail(gift, noteIndex);

  // Best-effort — a missing recipient row (shouldn't normally happen once
  // onboarding has run) just means this particular tap goes un-rate-limited
  // rather than failing the request the recipient is waiting on.
  if (recipient) {
    await sb.from('recipients')
      .update({ last_nudge_sent_at: new Date().toISOString() })
      .eq('id', recipient.id);
  }

  return ok({ ok: true });
};
