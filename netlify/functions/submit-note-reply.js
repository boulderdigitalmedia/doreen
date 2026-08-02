// POST /api/submit-note-reply
// Body: { slug, note_id, body }
// No auth required — the recipient has no Supabase account, only the
// gift's slug (see gift.html / verify-gift-password.js), same as every
// other recipient-initiated write in this app. Unlike recipients_public_
// upsert though, this does NOT have a matching anon RLS insert policy
// (see the RECIPIENT REPLIES block in schema.sql) — it goes through this
// function instead, using the service-role key, so the buyer's email
// notification fires in the same request as the write rather than
// depending on a database trigger that doesn't exist.
//
// Doesn't re-check gifts.access_password — gift.html already gates the
// whole page behind that password before the recipient can see a note
// to reply to in the first place (client-side, via localStorage's
// unlock flag), the same trust level every other recipient write in
// this app (recipients table prefs/favorites) already relies on.

const { sb, err, ok, preflight, sendRecipientReplyEmail } = require('./_shared');

const MAX_BODY_LENGTH = 2000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }

  const slug     = (body.slug || '').trim();
  const noteId   = (body.note_id || '').trim();
  const msgBody  = (body.body || '').trim();

  if (!slug || !noteId) return err('slug and note_id are required');
  if (!msgBody) return err('Message can\'t be empty');
  if (msgBody.length > MAX_BODY_LENGTH) return err(`Message is too long (max ${MAX_BODY_LENGTH} characters)`);

  const { data: gift, error: giftErr } = await sb
    .from('gifts')
    .select('id, user_id, slug, display_name, sender_name, status')
    .eq('slug', slug)
    .maybeSingle();

  if (giftErr || !gift) return err('Gift not found', 404);
  if (gift.status !== 'active') {
    return err('This gift is no longer active — messages can\'t be sent right now', 409);
  }

  const { data: note, error: noteErr } = await sb
    .from('notes')
    .select('id, gift_id, order_index')
    .eq('id', noteId)
    .maybeSingle();

  if (noteErr || !note || note.gift_id !== gift.id) {
    return err('Note not found on this gift', 404);
  }

  const { data: reply, error: insertErr } = await sb
    .from('note_replies')
    .insert({
      note_id: note.id,
      gift_id: gift.id,
      sender:  'recipient',
      body:    msgBody,
    })
    .select()
    .single();

  if (insertErr) return err('Could not send message: ' + insertErr.message, 500);

  // The reply is already saved either way by this point — a notification
  // hiccup shouldn't turn into a failed send from the recipient's POV.
  await sendRecipientReplyEmail(gift, note, msgBody);

  return ok({ reply });
};
