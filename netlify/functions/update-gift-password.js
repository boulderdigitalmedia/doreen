// POST /api/update-gift-password
// Body: { slug, currentPassword, newPassword }
//
// Lets the recipient (not just the buyer) change the gift page password
// from their own Settings panel — there's no recipient login, so knowing
// the *current* password is what proves they're allowed to set a new one.
// Only ever runs server-side with the service-role key; the password is
// never exposed to the browser via a direct Supabase query (see
// schema.sql's column-level REVOKE for the anon role).
//
// BRUTE-FORCE LOCKOUT: shares gifts.password_attempts / password_
// locked_until with verify-gift-password.js — see that file's header
// for why (low-entropy, guessable slugs). A wrong currentPassword guess
// here counts against the exact same budget as a wrong guess on the
// lock screen, so switching endpoints doesn't reset the counter. Only
// applies when the gift already has a password set — setting the very
// first password (hasExistingPassword false) is unchanged: knowing the
// slug is still what establishes "this is the recipient" the first time,
// same as before.

const { sb, ok, err, preflight } = require('./_shared');

const MAX_PASSWORD_ATTEMPTS = 8;
const LOCKOUT_MS            = 15 * 60 * 1000; // 15 minutes

function lockedMessage(lockedUntil) {
  const minutesLeft = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000));
  return `Too many attempts — try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`;
}

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
    .select('id, access_password, password_attempts, password_locked_until')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !gift) return err('Gift not found', 404);

  const hasExistingPassword = !!(gift.access_password && gift.access_password.length > 0);

  if (hasExistingPassword) {
    if (gift.password_locked_until && new Date(gift.password_locked_until) > new Date()) {
      return err(lockedMessage(gift.password_locked_until), 429);
    }

    if (currentPassword !== gift.access_password) {
      const nextAttempts = (gift.password_attempts || 0) + 1;
      const updates = { password_attempts: nextAttempts };
      let responseMsg = "That current password isn't right";

      if (nextAttempts >= MAX_PASSWORD_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
        updates.password_attempts = 0; // the lockout window is the gate now, not the counter
        updates.password_locked_until = lockedUntil;
        responseMsg = lockedMessage(lockedUntil);
      }

      await sb.from('gifts').update(updates).eq('id', gift.id);
      return err(responseMsg, nextAttempts >= MAX_PASSWORD_ATTEMPTS ? 429 : 403);
    }
  }

  const nextPassword = typeof newPassword === 'string' && newPassword.length > 0 ? newPassword : null;

  const updates = { access_password: nextPassword };
  if (hasExistingPassword) {
    // Just verified correct above — clear any stale attempt counter as
    // part of the same write.
    updates.password_attempts = 0;
    updates.password_locked_until = null;
  }

  const { error: updateErr } = await sb
    .from('gifts')
    .update(updates)
    .eq('id', gift.id);

  if (updateErr) return err('Could not update password', 500);

  return ok({ success: true });
};
