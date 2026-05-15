const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ── CORS — allow your Netlify site ──────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── VAPID keys (set as environment variables on Render) ──────────
webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'you@example.com'}`,
  process.env.VAPID_PUBLIC_KEY  || 'BFJ82UKXOvphp1uCUkCck0U_vCkUZte1GLifyRHei241MNaD71dUrDpPDtz0B34l3Ou3Ln51xIUKTwlvJfWmZkg',
  process.env.VAPID_PRIVATE_KEY || 'llUTuugY94qON-Sy6BkeOXfgkinKKzNcwB1868QC-Lk'
);

// ── Subscription storage (persisted to disk) ─────────────────────
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

function loadSubs() {
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

// ── Start date — must match what's in index.html ─────────────────
const START_DATE = process.env.START_DATE || '2025-06-01';

function getDayIndex() {
  const start = new Date(START_DATE);
  start.setHours(0, 0, 0, 0);
  const now = new Date();
  // Convert now to NZ time for day calculation
  const nzNow = new Date(now.toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
  nzNow.setHours(0, 0, 0, 0);
  const diff = Math.floor((nzNow - start) / 86400000);
  return Math.max(0, diff);
}

// ── Routes ───────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', day: getDayIndex() + 1 }));

// Register a push subscription
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  const subs = loadSubs();
  const exists = subs.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subs.push(subscription);
    saveSubs(subs);
    console.log(`New subscription registered. Total: ${subs.length}`);
  }
  res.json({ ok: true });
});

// Manual trigger (for testing)
app.post('/send-now', (req, res) => {
  sendDailyPush();
  res.json({ ok: true, day: getDayIndex() + 1 });
});

// ── Push logic ───────────────────────────────────────────────────
async function sendDailyPush() {
  const subs = loadSubs();
  if (subs.length === 0) {
    console.log('No subscriptions yet, skipping push');
    return;
  }

  const dayIndex = getDayIndex();
  const dayNum = dayIndex + 1;
  console.log(`Sending push for Day ${dayNum} to ${subs.length} subscriber(s)`);

  const payload = JSON.stringify({
    title: '💚 A note from Jake',
    body: `Day ${dayNum} — open the app to read today\'s reason`,
    url: '/'
  });

  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        console.log('Removing expired subscription');
        dead.push(sub.endpoint);
      } else {
        console.error('Push error:', err.message);
      }
    }
  }

  if (dead.length > 0) {
    const cleaned = subs.filter(s => !dead.includes(s.endpoint));
    saveSubs(cleaned);
  }
}

// ── Cron: 8am NZ time daily ──────────────────────────────────────
// NZ is UTC+12 (NZST) or UTC+13 (NZDT, daylight saving)
// "0 20 * * *" = 8pm UTC = 8am NZST (UTC+12)
// Render servers run UTC, so we schedule for 20:00 UTC
// During NZ daylight saving (Oct-Apr) NZ is UTC+13, so 8am NZ = 19:00 UTC
// We use 19:30 UTC as a reasonable middle ground year-round
cron.schedule('30 19 * * *', () => {
  console.log('Cron fired — sending daily push');
  sendDailyPush();
}, {
  timezone: 'UTC'
});

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Push server running on port ${PORT}`);
  console.log(`Subscriptions file: ${SUBS_FILE}`);
  console.log(`Daily push scheduled for 19:30 UTC (≈8am NZT)`);
});
