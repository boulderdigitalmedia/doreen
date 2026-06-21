// Netlify Scheduled Function — fires daily at 19:30 UTC (≈ 8am NZT)
// Loops every active gift and sends notifications to recipients whose
// frequency puts them on a send day today.
const { schedule } = require('@netlify/functions');
const { sb, shouldSendToday, sendGiftNotifications } = require('./_shared');

exports.handler = schedule('30 19 * * *', async () => {
  console.log('send-daily fired:', new Date().toISOString());

  const { data: gifts, error } = await sb
    .from('gifts')
    .select('*')
    .eq('status', 'active');

  if (error) {
    console.error('Failed to fetch gifts:', error.message);
    return { statusCode: 500 };
  }

  console.log(`Processing ${gifts.length} active gift(s)`);

  const results = await Promise.allSettled(
    gifts
      .filter(g => shouldSendToday(g))
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
