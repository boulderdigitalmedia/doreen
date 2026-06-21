// Manual trigger — called from the dashboard to test a specific gift.
// POST body: { slug: 'jake-and-doreen', adminPassword: '...' }
const { sb, sendGiftNotifications, ok, err, preflight } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body); } catch { return err('Invalid JSON'); }

  const { slug, adminPassword } = body;

  if (!slug) return err('slug required');

  // Verify admin password against env var (simple global secret for now)
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return err('Unauthorized', 401);
  }

  const { data: gift, error } = await sb
    .from('gifts')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'active')
    .single();

  if (error || !gift) return err('Gift not found', 404);

  const result = await sendGiftNotifications(gift, true); // force = true
  return ok({ ok: true, slug, ...result });
};
