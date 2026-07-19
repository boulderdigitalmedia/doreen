// POST /api/touch-activity
// Header: Authorization: Bearer <supabase_access_token>
//
// Fire-and-forget "the buyer is actually using the app" beacon — called
// from account.html's boot(), once per page load, right after a signed-in
// buyer's profile finishes loading. Stamps profiles.last_active_at = now()
// and clears reengagement_email_sent_at, so send-daily.js's
// sweepReengagement() correctly treats them as no-longer-dormant and
// becomes eligible to nudge them again if they go quiet a second time.
//
// Writes through the service-role client rather than a client-side RLS
// policy, matching how every other write to profiles in this app works —
// there's deliberately no client-writable policy on that table.
//
// Body is unused; the JWT alone identifies which profile to touch. Never
// throws past this handler — account.html doesn't (and shouldn't) block
// on or surface a failure here, so errors are just logged server-side.

const { sb, ok, err, preflight } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return err('Unauthorized', 401);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return err('Unauthorized', 401);

  try {
    await sb.from('profiles').update({
      last_active_at: new Date().toISOString(),
      reengagement_email_sent_at: null,
    }).eq('id', user.id);
  } catch (e) {
    console.error('Failed to record activity for profile', user.id, e.message);
    // Still return ok — this is a best-effort beacon, not something the
    // buyer's session should ever be interrupted over.
  }

  return ok({ ok: true });
};
