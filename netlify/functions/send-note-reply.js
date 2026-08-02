// POST /api/send-note-reply
// Body: { note_id, body }
// Header: Authorization: Bearer <supabase_access_token>
//
// The buyer's half of the conversation (see submit-note-reply.js for the
// recipient's half, and the RECIPIENT REPLIES block in schema.sql). The
// buyer *could* insert directly via note_reply_owner_all's RLS policy
// from account.html, but that would leave the recipient's notification
// (push/email/sms — whatever channels they already get notes on) with
// nowhere to fire from, since there's no database trigger wired up to
// call Resend/Twilio/web-push. Routing through this function instead
// keeps "save the message" and "tell the recipient" atomic to one
// request, same reasoning as submit-note-reply.js on the other side.

const { sb, err, ok, preflight, sendBuyerReplyNotification } = require('./_shared');

const MAX_BODY_LENGTH = 2000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return err('Unauthorized', 401);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return err('Unauthorized', 401);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }

  const noteId  = (body.note_id || '').trim();
  const msgBody = (body.body || '').trim();

  if (!noteId) return err('note_id is required');
  if (!msgBody) return err('Message can\'t be empty');
  if (msgBody.length > MAX_BODY_LENGTH) return err(`Message is too long (max ${MAX_BODY_LENGTH} characters)`);

  const { data: note, error: noteErr } = await sb
    .from('notes')
    .select('id, gift_id, order_index')
    .eq('id', noteId)
    .maybeSingle();

  if (noteErr || !note) return err('Note not found', 404);

  const { data: gift, error: giftErr } = await sb
    .from('gifts')
    .select('id, user_id, slug, display_name, sender_name, sms_addon')
    .eq('id', note.gift_id)
    .maybeSingle();

  if (giftErr || !gift || gift.user_id !== user.id) {
    return err('You don\'t have access to this note', 403);
  }

  const { data: reply, error: insertErr } = await sb
    .from('note_replies')
    .insert({
      note_id: note.id,
      gift_id: gift.id,
      sender:  'buyer',
      body:    msgBody,
    })
    .select()
    .single();

  if (insertErr) return err('Could not send message: ' + insertErr.message, 500);

  const { data: recipient } = await sb
    .from('recipients')
    .select('*')
    .eq('gift_id', gift.id)
    .maybeSingle();

  // Same as above — the message is already saved, a notification hiccup
  // shouldn't surface as a failed send to the buyer.
  await sendBuyerReplyNotification(gift, recipient, note, msgBody);

  return ok({ reply });
};
