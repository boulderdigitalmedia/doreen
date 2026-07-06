// Netlify Scheduled Function — fires every 15 minutes.
// Delivery time is the recipient's own choice (set during onboarding on
// gift.html), falling back to the gift's default until they pick one. So
// instead of one fixed daily fire time, this runs frequently and only
// actually sends a gift's notification when "now" falls in that
// recipient's (or gift's default) local delivery window — see
// isDeliveryWindow in _shared.js, accurate to the nearest 15-minute
// bucket, e.g. picking 8:07am sends around 8:00-8:15am local time.
const { schedule } = require('@netlify/functions');
const { sb, shouldSendToday, isDeliveryWindow, sendGiftNotifications } = require('./_shared');

exports.handler = schedule('*/15 * * * *', async () => {
  console.log('send-daily fired:', new Date().toISOString());

  const { data: gifts, error } = await sb
    .from('gifts')
    .select('*')
    .eq('status', 'active');

  if (error) {
    console.error('Failed to fetch gifts:', error.message);
    return { statusCode: 500 };
  }

  console.log(`Checking ${gifts.length} active gift(s)`);

  const giftIds = gifts.map(g => g.id);
  const { data: recipients } = await sb
    .from('recipients')
    .select('*')
    .in('gift_id', giftIds);

  const recipientByGiftId = new Map((recipients || []).map(r => [r.gift_id, r]));

  const results = await Promise.allSettled(
    gifts
      .filter(g => shouldSendToday(g) && isDeliveryWindow(g, recipientByGiftId.get(g.id)))
      .map(g => sendGiftNotifications(g))
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`Gift ${i} failed:`, r.reason);
  });

  const sent    = results.filter(r => r.status === 'fulfilled' && r.value?.sent).length;
  const skipped = results.filter(r => r.status === 'fulfilled' && r.value?.skipped).length;

  console.log(`Done — sent: ${sent}, skipped: ${skipped}`);
  return { statusCode: 200 };
});
