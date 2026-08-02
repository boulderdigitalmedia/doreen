// POST /api/cancel-subscription
// Body: { action: 'preview' | 'confirm' }
// Header: Authorization: Bearer <supabase_access_token>
//
// Both plans — the $14 30-Day Gift Pack and the $59 annual plan — are
// now paid in full, one-time, up front (see create-checkout.js). Neither
// has a Stripe subscription behind it, so there's nothing left to
// "cancel" in the billing sense: no future charge to stop, and no early-
// cancellation fee (that fee only ever applied to the old $4.50/mo
// installment plan, which no longer exists — see the PRICING UPDATE
// block in schema.sql). This endpoint is purely informational now: it
// tells the buyer their term is paid through, with no charge either way.
//
// Kept as a POST endpoint (rather than removed outright) so account.html's
// existing "cancel" link keeps working without a client-side rewrite —
// it always returns fee: 0 and never changes any state.

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function ok(body)  { return { statusCode: 200, headers: cors(), body: JSON.stringify(body) }; }
function err(msg, code = 400) { return { statusCode: code, headers: cors(), body: JSON.stringify({ error: msg }) }; }
function preflight() { return { statusCode: 204, headers: cors() }; }
function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

const PLAN_LABEL = { annual: 'annual plan', gift_pack: '30-Day Gift Pack' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return err('Unauthorized', 401);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return err('Unauthorized', 401);

  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('plan, access_term_end')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || !profile?.plan) {
    return err('No active plan found', 409);
  }

  const label = PLAN_LABEL[profile.plan] || profile.plan;
  const termEnd = profile.access_term_end;

  return ok({
    plan: profile.plan,
    fee: 0,
    message: termEnd
      ? `Your ${label} is paid in full and doesn't auto-renew — there's nothing to cancel. You keep access through ${new Date(termEnd).toLocaleDateString()}.`
      : `Your ${label} is paid in full and doesn't auto-renew — there's nothing to cancel.`,
  });
};
