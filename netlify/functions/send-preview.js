// POST /api/send-preview
// Header: Authorization: Bearer <supabase_access_token>
// Body: { slug: 'jake-and-doreen' }
//
// Emails the *buyer* (their own login email — never the recipient) a
// preview of whatever note is currently due to go out, using the exact
// same template as the real send, so they can review it before their
// recipient actually gets it. Doesn't touch the recipient's channels,
// doesn't mark anything as sent, and doesn't affect the schedule at all.
const { createClient } = require('@supabase/supabase-js');
const { sb, resend, getNoteIndex, buildEmailHtml, buildFrom, ok, err, preflight } = require('./_shared');

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return err('Unauthorized', 401);

  const { data: { user }, error: authErr } = await sbAdmin.auth.getUser(token);
  if (authErr || !user) return err('Unauthorized', 401);

  let body;
  try { body = JSON.parse(event.body); } catch { return err('Invalid JSON'); }

  const { slug } = body;
  if (!slug) return err('slug required');

  // Verify the gift belongs to this user
  const { data: gift, error } = await sbAdmin
    .from('gifts')
    .select('*')
    .eq('slug', slug)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !gift) return err('Gift not found', 404);

  const { data: recipient } = await sb
    .from('recipients')
    .select('*')
    .eq('gift_id', gift.id)
    .maybeSingle();

  const noteIndex = getNoteIndex(gift, recipient);
  const { data: note } = await sb
    .from('notes')
    .select('*')
    .eq('gift_id', gift.id)
    .eq('order_index', noteIndex)
    .maybeSingle();

  if (!note) {
    return err(`No note written yet for slot ${noteIndex + 1} — add one first`, 404);
  }

  const noteNum = noteIndex + 1;
  const giftUrl = `${process.env.SITE_URL || 'https://yoursite.com'}/${gift.slug}`;

  try {
    await resend.emails.send({
      from:    buildFrom(`A Note For You From ${gift.sender_name || 'Your Favorite'}`),
      to:      user.email,
      subject: `👀 Preview — Note ${noteNum} for "${gift.display_name}"`,
      html:    buildEmailHtml(gift, note, noteNum, giftUrl),
    });
  } catch (e) {
    return err('Could not send preview: ' + e.message, 500);
  }

  return ok({ ok: true, noteNum, sentTo: user.email });
};
