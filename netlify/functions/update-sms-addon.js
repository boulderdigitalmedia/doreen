// POST /api/update-sms-addon
// Body: { giftId, enabled }
// Header: Authorization: Bearer <supabase_access_token>
//
// Toggles the SMS add-on for one gift. Billing mechanism depends on the
// buyer's plan, since the annual plan is now a one-time payment with no
// Stripe subscription behind it (see create-checkout.js) — there's
// nothing to attach a recurring item to for those buyers anymore:
//
//   installment — unchanged. The buyer's subscription gets ONE recurring
//     add-on line item, priced at $2/mo, whose quantity equals how many
//     of the buyer's gifts currently have SMS enabled. Toggling a gift
//     on/off just adjusts that quantity (or creates/removes the item at
//     0 → 1 / 1 → 0), billed via proration_behavior: 'always_invoice' so
//     the buyer is charged/credited immediately rather than it sitting
//     as a pending line item until whenever their next cycle happens.
//
//   annual — a flat one-time charge instead, tiered by how much of the
//     current term is left (same CLOSED_UNDER_DAYS/LOW/MID tiers
//     create-addon-checkout.js uses for add-on gifts, since there's no
//     Stripe proration to lean on for a one-time charge). Turning SMS
//     off is free (no refund, matches the site's non-refundable
//     policy) — only turning it ON charges anything. Renewals are
//     handled separately, by stripe-webhook.js's
//     chargeSmsAddonCarryoverOneTime.

const Stripe = require('stripe');
const { sb, ok, err, preflight } = require('./_shared');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SMS_ADDON_MONTHLY_PRICE_ID = process.env.STRIPE_SMS_ADDON_PRICE_ID;
const SMS_ADDON_ANNUAL_PRICE_ID  = process.env.STRIPE_SMS_ADDON_ANNUAL_PRICE_ID;

// Same day-remaining tiers create-addon-checkout.js uses for add-on
// gifts — duplicated here rather than shared, matching this codebase's
// existing per-function style. Applied to the annual plan's one-time SMS
// charge, which has no built-in Stripe proration to fall back on.
const CLOSED_UNDER_DAYS  = 45;
const LOW_TIER_MAX_DAYS  = 90;   // 45–90 days  → $10
const MID_TIER_MAX_DAYS  = 180;  // 91–180 days → $15
                                  // 181+ days   → $20
const TIER_DOLLAR_AMOUNT = { high: 20, mid: 15, low: 10 };

function tierForDaysRemaining(days) {
  if (days < CLOSED_UNDER_DAYS) return null;
  if (days <= LOW_TIER_MAX_DAYS) return 'low';
  if (days <= MID_TIER_MAX_DAYS) return 'mid';
  return 'high';
}

// One-time off-session charge against the customer's default payment
// method — duplicated from stripe-webhook.js's identical helper rather
// than shared, matching this codebase's existing per-function style.
// finalizeInvoice + pay (rather than create with auto_advance) attempts
// the charge synchronously, so the caller gets an accurate result back
// immediately.
async function chargeOneTimeFee(customerId, amountDollars, description) {
  await stripe.invoiceItems.create({
    customer:    customerId,
    amount:      Math.round(amountDollars * 100),
    currency:    'usd',
    description,
  });
  const invoice = await stripe.invoices.create({
    customer:          customerId,
    collection_method: 'charge_automatically',
    auto_advance:      false,
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  const paid = await stripe.invoices.pay(finalized.id);
  return paid.status === 'paid';
}

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

  const { data: profile } = await sb
    .from('profiles')
    .select('stripe_subscription_id, stripe_customer_id, stripe_status, plan, access_term_end')
    .eq('id', user.id)
    .single();

  if (!['active', 'trialing'].includes(profile?.stripe_status)) {
    return err('No active subscription found for this account', 409);
  }

  if (profile.plan === 'annual') {
    return await handleAnnualSmsToggle(profile, gift, enabled);
  }
  return await handleInstallmentSmsToggle(profile, gift, enabled, user.id);
};

// ── Installment plan — unchanged recurring subscription-item logic ──
async function handleInstallmentSmsToggle(profile, gift, enabled, userId) {
  if (!profile.stripe_subscription_id) {
    return err('No active subscription found for this account', 409);
  }

  // Update the gift's flag
  const { error: updateErr } = await sb.from('gifts').update({ sms_addon: enabled }).eq('id', gift.id);
  if (updateErr) return err('Could not save gift setting: ' + updateErr.message, 500);

  // Recompute how many of this buyer's gifts now have SMS enabled
  const { data: allGifts } = await sb
    .from('gifts')
    .select('id, sms_addon')
    .eq('user_id', userId);

  const smsCount = (allGifts || []).filter((g) => g.sms_addon).length;

  try {
    const items = await stripe.subscriptionItems.list({
      subscription: profile.stripe_subscription_id,
      limit: 100,
    });
    const existing = items.data.find((i) => i.price.id === SMS_ADDON_MONTHLY_PRICE_ID);

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
          price: SMS_ADDON_MONTHLY_PRICE_ID,
          quantity: smsCount,
          proration_behavior: 'always_invoice',
        });
      }
    } else if (existing) {
      await stripe.subscriptionItems.del(existing.id, { proration_behavior: 'always_invoice' });
    }
  } catch (stripeErr) {
    // Roll the DB flag back so it doesn't drift from what's actually billed
    await sb.from('gifts').update({ sms_addon: !enabled }).eq('id', gift.id);
    return err('Billing update failed, change was not saved: ' + stripeErr.message, 500);
  }

  return ok({ ok: true, sms_addon: enabled, smsAddonQuantity: smsCount });
}

// ── Annual plan — flat one-time charge, tiered by term remaining ──
async function handleAnnualSmsToggle(profile, gift, enabled) {
  // Turning SMS off never charges or refunds anything — just flip the
  // flag. Nothing in Stripe to touch since there's no subscription item.
  if (!enabled) {
    const { error: updateErr } = await sb.from('gifts').update({ sms_addon: false }).eq('id', gift.id);
    if (updateErr) return err('Could not save gift setting: ' + updateErr.message, 500);
    return ok({ ok: true, sms_addon: false });
  }

  if (!profile.stripe_customer_id) {
    return err('No billing account found for this account', 409);
  }
  if (!profile.access_term_end) {
    return err(
      'Your term hasn\'t started yet — it begins once your first gift\'s first note sends (or automatically within 30 days of subscribing). SMS opens up after that.',
      409
    );
  }

  const termEnd = new Date(profile.access_term_end);
  const daysRemaining = Math.ceil((termEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const tier = tierForDaysRemaining(daysRemaining);

  if (!tier) {
    return err(
      `Your current term ends in ${Math.max(daysRemaining, 0)} day(s) — too soon to add SMS. Renew your subscription first, then enable it under the new term.`,
      409
    );
  }

  const amount = TIER_DOLLAR_AMOUNT[tier];

  let paid;
  try {
    paid = await chargeOneTimeFee(profile.stripe_customer_id, amount, 'SMS add-on');
  } catch (e) {
    return err('Could not charge for the SMS add-on: ' + e.message, 402);
  }
  if (!paid) {
    return err('The SMS add-on charge could not be completed — update your payment method and try again.', 402);
  }

  const { error: updateErr } = await sb.from('gifts').update({ sms_addon: true }).eq('id', gift.id);
  if (updateErr) {
    // Already charged at this point — flag loudly rather than silently
    // leave the buyer charged with the flag never actually turned on.
    console.error('CRITICAL: SMS add-on charge succeeded but gift update failed', gift.id, updateErr.message);
    return err('Payment succeeded but saving the setting failed — contact support', 500);
  }

  try {
    await sb.from('subscription_events').insert({
      profile_id: gift.user_id,
      event_type: 'sms_purchase',
      plan:       'annual',
      amount,
    });
  } catch (e) {
    console.error('Failed to log sms_purchase event:', e.message);
  }

  return ok({ ok: true, sms_addon: true, charged: amount });
}
