// DEPRECATED — DELETE THIS FILE FROM YOUR REPO.
//
// Replaced by the tiered, one-time-purchase add-on system:
//   create-addon-checkout.js — buys one add-on gift, priced by time
//     remaining in the current term ($20/$15/$10, closed under 45 days)
//   stripe-webhook.js         — creates the gift on payment, handles
//     renewal carryover at a flat $20
//
// The old model (profiles.extra_gift_slots, a single recurring
// subscription-item quantity at $2/mo or $20/yr) doesn't fit the new
// per-gift tiered/term-based pricing, so this endpoint has no
// replacement call site left in account.html — it's inert.

exports.handler = async () => {
  return { statusCode: 410, body: 'Deprecated — replaced by /api/create-addon-checkout. No longer in use.' };
};
