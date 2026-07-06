// POST /api/update-gift-password
// Body: { slug, currentPassword, newPassword }
//
// Lets the recipient (not just the buyer) change the gift page password
// from their own Settings panel — there's no recipient login, so knowing
// the *current* password is what proves they're allowed to set a new one.
// Only ever runs server-side with the service-role key; the password is
// never exposed to the browser via a direct Supabase query (see
// schema.sql's column-level REVOKE for the anon role).

const { sb, ok, err, preflight } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return err('Invalid request body');
  }

  const { slug, currentPassword, newPassword } = body;
  if (!slug) return err('Missing slug');

  const { data: gift, error } = await sb
    .from('gifts')
    .select('id, access_password')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !gift) return err('Gift not found', 404);

  const hasExistingPassword = !!(gift.access_password && gift.access_password.length > 0);

  if (hasExistingPassword) {
    if (currentPassword !== gift.access_password) {
      return err("That current password isn't right", 403);
    }
  }

  const nextPassword = typeof newPassword === 'string' && newPassword.length > 0 ? newPassword : null;

  const { error: updateErr } = await sb
    .from('gifts')
    .update({ access_password: nextPassword })
    .eq('id', gift.id);

  if (updateErr) return err('Could not update password', 500);

  return ok({ success: true });
};
