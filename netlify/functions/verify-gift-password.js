// POST /api/verify-gift-password
// Body: { slug, password? }
//
// The gift page can be locked behind a simple password set by the buyer
// (gifts.access_password). That column is never sent to the browser —
// anon/public clients only ever get a yes/no answer from this function,
// which uses the service-role key to do the actual comparison server-side.
//
// Call with just { slug } to check whether a password is required at all
// (e.g. on page load, before showing a lock screen). Call again with
// { slug, password } once the recipient has typed one in.
//
// BRUTE-FORCE LOCKOUT: gift slugs are low-entropy (auto-generated from
// the recipient's name — see autoSlug() in account.html), so they're
// guessable by design, not secret. Without a limit here, an unthrottled
// script could grind through a gift's password with no cost. After
// MAX_PASSWORD_ATTEMPTS wrong guesses, the gift locks for LOCKOUT_MS —
// tracked on the gift row itself (gifts.password_attempts /
// password_locked_until), so it's shared with update-gift-password.js:
// a burst of wrong guesses through either endpoint counts against the
// same budget. The metadata-only check (no password supplied, e.g. on
// page load) never counts as an attempt — only an actual guess does.

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

  const { slug, password } = body;
  if (!slug) return err('Missing slug');

  const { data: gift, error } = await sb
    .from('gifts')
    .select('id, access_password, password_attempts, password_locked_until')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !gift) return err('Gift not found', 404);

  const requiresPassword = !!(gift.access_password && gift.access_password.length > 0);

  if (!requiresPassword) {
    return ok({ requiresPassword: false, valid: true });
  }

  // Metadata-only check (page load, before the recipient has typed
  // anything) — never counts as a guess, so it can't burn down the
  // attempt budget on its own.
  if (typeof password !== 'string' || password.length === 0) {
    return ok({ requiresPassword: true, valid: false });
  }

  if (gift.password_locked_until && new Date(gift.password_locked_until) > new Date()) {
    return ok({ requiresPassword: true, valid: false, locked: true, message: lockedMessage(gift.password_locked_until) });
  }

  const valid = password === gift.access_password;

  if (valid) {
    // Clear any stale counter from earlier wrong guesses now that the
    // right password's been entered.
    if (gift.password_attempts > 0 || gift.password_locked_until) {
      await sb.from('gifts').update({ password_attempts: 0, password_locked_until: null }).eq('id', gift.id);
    }
    return ok({ requiresPassword: true, valid: true });
  }

  const nextAttempts = (gift.password_attempts || 0) + 1;
  const updates = { password_attempts: nextAttempts };
  let locked = false;
  let lockedUntil = null;

  if (nextAttempts >= MAX_PASSWORD_ATTEMPTS) {
    lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
    updates.password_attempts = 0; // the lockout window is the gate now, not the counter
    updates.password_locked_until = lockedUntil;
    locked = true;
  }

  await sb.from('gifts').update(updates).eq('id', gift.id);

  return ok({
    requiresPassword: true,
    valid: false,
    ...(locked ? { locked: true, message: lockedMessage(lockedUntil) } : {}),
  });
};
