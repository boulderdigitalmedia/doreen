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

  const { slug, password } = body;
  if (!slug) return err('Missing slug');

  const { data: gift, error } = await sb
    .from('gifts')
    .select('access_password')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !gift) return err('Gift not found', 404);

  const requiresPassword = !!(gift.access_password && gift.access_password.length > 0);

  if (!requiresPassword) {
    return ok({ requiresPassword: false, valid: true });
  }

  const valid = typeof password === 'string' && password.length > 0 && password === gift.access_password;

  return ok({ requiresPassword: true, valid });
};
