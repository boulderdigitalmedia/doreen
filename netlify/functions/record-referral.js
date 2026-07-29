// POST /api/record-referral
// Body: { code: 'A1B2C3' }
// Header: Authorization: Bearer <supabase_access_token>
//
// Redeems a referral code for the CURRENTLY SIGNED-IN user (the
// referee). All the actual business logic — validating the code,
// rejecting self-referral, rejecting a buyer who's already applied one
// or is already a customer, and writing both profiles.referred_by_code
// and the referrals row atomically — lives in the redeem_referral_code
// Postgres function (schema.sql). This handler is just auth + a status
// string → HTTP response mapping.
//
// IMPORTANT: this endpoint does NOT grant the reward. It only records
// who referred this buyer, typically at signup, often well before
// they've paid anything at all. The free bonus gift for both sides only
// unlocks once this buyer's first payment actually succeeds — see
// maybeRewardReferral in stripe-webhook.js.

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

  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return err('That doesn\'t look like a valid referral code');
  }

  const { data: result, error: rpcErr } = await sb.rpc('redeem_referral_code', {
    referee_id_in: user.id,
    code_in:       code,
  });

  if (rpcErr) {
    console.error('redeem_referral_code failed:', rpcErr.message);
    return err('Could not apply referral code — please try again', 500);
  }

  switch (result) {
    case 'ok':
      return ok({ success: true });
    case 'not_found':
      return err('That referral code doesn\'t exist', 404);
    case 'self':
      return err('You can\'t refer yourself', 400);
    case 'already_applied':
      return err('You\'ve already applied a referral code', 409);
    case 'already_customer':
      return err('Referral codes are only for new members', 409);
    default:
      console.error('Unexpected redeem_referral_code result:', result);
      return err('Unexpected error applying referral code', 500);
  }
};
