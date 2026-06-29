// Manual trigger — called from the dashboard to send/test a specific gift.
// POST body: { slug: 'jake-and-doreen' }
// Header: Authorization: Bearer <supabase_access_token>
const { createClient } = require('@supabase/supabase-js');
const { sb, sendGiftNotifications, ok, err, preflight } = require('./_shared');

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  // Verify the caller is a logged-in user
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
    .single();

  if (error || !gift) return err('Gift not found', 404);

  const result = await sendGiftNotifications(gift, true); // force = true
  return ok({ ok: true, slug, ...result });
};
