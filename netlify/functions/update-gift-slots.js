// POST /api/update-gift-slots
// Body: { action: 'add' | 'remove' }
// Header: Authorization: Bearer <supabase_access_token>
//
// Every subscription includes 2 gifts. Additional gift slots are a
// recurring per-gift add-on, priced at whichever interval the buyer
// already subscribed at — $2/mo for monthly subscribers, $20/yr for
// annual — never a mix of the two. Kept in sync as ONE recurring line
// item on the buyer's existing subscription, whose quantity equals
// profiles.extra_gift_slots (same pattern as the SMS add-on).

const Stripe = require('stripe');
const { sb, ok, err, preflight } = require('./_shared');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const EXTRA_GIFT_MONTHLY_PRICE_ID = process.env.STRIPE_EXTRA_GIFT_MONTHLY_PRICE_ID;
const EXTRA_GIFT_ANNUAL_PRICE_ID  = process.env.STRIPE_EXTRA_GIFT_ANNUAL_PRICE_ID;
const INCLUDED_GIFTS = 2;

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
  const { action } = body;
  if (action !== 'add' && action !== 'remove') return err('action must be "add" or "remove"');

  const { data: profile, error: profErr } = await sb
    .from('profiles')
    .select('stripe_subscription_id, plan, extra_gift_slots')
    .eq('id', user.id)
    .maybeSingle();

  if (profErr || !profile?.stripe_subscription_id) {
    return err('No active subscription found for this account', 409);
  }

  const priceId = profile.plan === 'annual' ? EXTRA_GIFT_ANNUAL_PRICE_ID : EXTRA_GIFT_MONTHLY_PRICE_ID;
  if (!priceId) {
    return err(`Extra gift add-on is not configured for the ${profile.plan || 'monthly'} plan`, 500);
  }

  const currentSlots = profile.extra_gift_slots || 0;
  let nextSlots;

  if (action === 'add') {
    nextSlots = currentSlots + 1;
  } else {
    // Don't let them drop a slot that's actively in use by an existing gift
    const { count } = await sb
      .from('gifts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id);

    const limitAfterRemoval = INCLUDED_GIFTS + Math.max(0, currentSlots - 1);
    if ((count || 0) > limitAfterRemoval) {
      return err(`You currently have ${count} gift(s) — that's more than ${limitAfterRemoval}, so removing a slot isn't possible until you delete a gift first`, 409);
    }
    nextSlots = Math.max(0, currentSlots - 1);
  }

  // Sync the recurring add-on line item on the buyer's subscription
  try {
    const items = await stripe.subscriptionItems.list({
      subscription: profile.stripe_subscription_id,
      limit: 100,
    });
    const existing = items.data.find((i) => i.price.id === priceId);

    if (nextSlots > 0) {
      if (existing) {
        await stripe.subscriptionItems.update(existing.id, {
          quantity: nextSlots,
          proration_behavior: 'create_prorations',
        });
      } else {
        await stripe.subscriptionItems.create({
          subscription: profile.stripe_subscription_id,
          price: priceId,
          quantity: nextSlots,
          proration_behavior: 'create_prorations',
        });
      }
    } else if (existing) {
      await stripe.subscriptionItems.del(existing.id, { proration_behavior: 'create_prorations' });
    }
  } catch (stripeErr) {
    return err('Billing update failed, no changes were saved: ' + stripeErr.message, 500);
  }

  const { error: updateErr } = await sb
    .from('profiles')
    .update({ extra_gift_slots: nextSlots })
    .eq('id', user.id);

  if (updateErr) {
    return err('Billing updated, but could not save the new slot count — contact support: ' + updateErr.message, 500);
  }

  return ok({ ok: true, extraGiftSlots: nextSlots, giftLimit: INCLUDED_GIFTS + nextSlots });
};
