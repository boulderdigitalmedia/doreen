// POST /api/update-sms-addon
// Body: { giftId, enabled }
// Header: Authorization: Bearer <supabase_access_token>
//
// Toggles the SMS add-on for one gift and keeps Stripe billing in sync:
// the buyer's subscription gets ONE recurring add-on line item, priced at
// $2/mo or $20/yr depending on whichever interval the buyer's plan already
// uses (same pattern as the extra-gift-slot add-on), whose quantity equals
// how many of the buyer's gifts currently have SMS enabled. Toggling a gift
// on/off just adjusts that quantity (or creates/removes the item at
// 0 → 1 / 1 → 0). Uses proration_behavior: 'always_invoice' rather than the
// default 'create_prorations' — the buyer is charged (or credited) for the
// prorated amount immediately, in its own invoice, instead of it silently
// sitting as a pending line item until whatever their next renewal happens
// to be.

const Stripe = require('stripe');
const { sb, ok, err, preflight } = require('./_shared');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SMS_ADDON_MONTHLY_PRICE_ID = process.env.STRIPE_SMS_ADDON_PRICE_ID;
const SMS_ADDON_ANNUAL_PRICE_ID  = process.env.STRIPE_SMS_ADDON_ANNUAL_PRICE_ID;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  // Verify Supabase session
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return err('Unauthorized', 401);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return err('Unauthorized', 401);

  // Parse body
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }
  const { giftId, enabled } = body;
  if (!giftId || typeof enabled !== 'boolean') {
    return err('giftId and enabled (boolean) are required');
  }

  // Confirm the gift belongs to this user
  const { data: gift, error: giftErr } = await sb
    .from('gifts')
    .select('id, user_id')
    .eq('id', giftId)
    .eq('user_id', user.id)
    .single();
  if (giftErr || !gift) return err('Gift not found', 404);

  // Buyer must have an active subscription to bill an add-on against
  const { data: profile } = await sb
    .from('profiles')
    .select('stripe_subscription_id, plan')
    .eq('id', user.id)
    .single();

  if (!profile?.stripe_subscription_id) {
    return err('No active subscription found for this account', 409);
  }

  const priceId = profile.plan === 'annual' ? SMS_ADDON_ANNUAL_PRICE_ID : SMS_ADDON_MONTHLY_PRICE_ID;
  if (!priceId) {
    return err(`SMS add-on is not configured for the ${profile.plan || 'monthly'} plan`, 500);
  }

  // Update the gift's flag
  const { error: updateErr } = await sb.from('gifts').update({ sms_addon: enabled }).eq('id', giftId);
  if (updateErr) return err('Could not save gift setting: ' + updateErr.message, 500);

  // Recompute how many of this buyer's gifts now have SMS enabled
  const { data: allGifts } = await sb
    .from('gifts')
    .select('id, sms_addon')
    .eq('user_id', user.id);

  const smsCount = (allGifts || []).filter((g) => g.sms_addon).length;

  // Sync the recurring add-on line item on the buyer's subscription
  try {
    const items = await stripe.subscriptionItems.list({
      subscription: profile.stripe_subscription_id,
      limit: 100,
    });
    const existing = items.data.find((i) => i.price.id === priceId);

    if (smsCount > 0) {
      if (existing) {
        if (existing.quantity !== smsCount) {
          await stripe.subscriptionItems.update(existing.id, {
            quantity: smsCount,
            proration_behavior: 'always_invoice',
          });
        }
      } else {
        await stripe.subscriptionItems.create({
          subscription: profile.stripe_subscription_id,
          price: priceId,
          quantity: smsCount,
          proration_behavior: 'always_invoice',
        });
      }
    } else if (existing) {
      await stripe.subscriptionItems.del(existing.id, { proration_behavior: 'always_invoice' });
    }
  } catch (stripeErr) {
    // Roll the DB flag back so it doesn't drift from what's actually billed
    await sb.from('gifts').update({ sms_addon: !enabled }).eq('id', giftId);
    return err('Billing update failed, change was not saved: ' + stripeErr.message, 500);
  }

  return ok({ ok: true, sms_addon: enabled, smsAddonQuantity: smsCount });
};
