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

// ── Settings storage ─────────────────────────────────────────────
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULT_SETTINGS = {
  startDate:     process.env.START_DATE || '2025-06-01',
  frequency:     'daily',   // daily | weekly | biweekly | monthly
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme'
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// ── Date helpers ─────────────────────────────────────────────────
function getNZDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
}

function getDaysElapsed(startDate) {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const nzNow = getNZDate();
  nzNow.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((nzNow - start) / 86400000));
}

// Which note number to show/push today
function getNoteIndex() {
  const { startDate, frequency } = loadSettings();
  const days = getDaysElapsed(startDate);
  if (frequency === 'weekly')   return Math.floor(days / 7);
  if (frequency === 'biweekly') return Math.floor(days / 14);
  if (frequency === 'monthly') {
    const start = new Date(startDate);
    const now   = getNZDate();
    return Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()));
  }
  return days; // daily
}

// Should we send a push today given the current frequency?
function shouldSendToday() {
  const { startDate, frequency } = loadSettings();
  const days = getDaysElapsed(startDate);
  if (days === 0) return true; // always send on launch day
  if (frequency === 'daily')    return true;
  if (frequency === 'weekly')   return days % 7 === 0;
  if (frequency === 'biweekly') return days % 14 === 0;
  if (frequency === 'monthly') {
    const start = new Date(startDate);
    const now   = getNZDate();
    return now.getDate() === start.getDate();
  }
  return true;
}

// ── Routes ───────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  const { frequency } = loadSettings();
  res.json({ status: 'ok', noteIndex: getNoteIndex(), frequency });
});

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

// Get current settings (public — needed by frontend)
app.get('/settings', (req, res) => {
  const { startDate, frequency } = loadSettings();
  res.json({ startDate, frequency });
});

// Update settings (password-protected)
app.post('/settings', (req, res) => {
  const current = loadSettings();
  if (req.body.adminPassword !== current.adminPassword) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const updated = { ...current };
  if (req.body.frequency  && ['daily','weekly','biweekly','monthly'].includes(req.body.frequency)) {
    updated.frequency = req.body.frequency;
  }
  if (req.body.startDate)   updated.startDate   = req.body.startDate;
  if (req.body.newPassword) updated.adminPassword = req.body.newPassword;
  saveSettings(updated);
  res.json({ ok: true, frequency: updated.frequency });
});

// Dashboard stats
app.get('/stats', (req, res) => {
  const subs = loadSubs();
  res.json({ subscribers: subs.length, noteIndex: getNoteIndex(), shouldSendToday: shouldSendToday() });
});

// Manual trigger (for testing / dashboard)
app.post('/send-now', (req, res) => {
  sendDailyPush(true);
  res.json({ ok: true, noteIndex: getNoteIndex() });
});

// ── Push logic ───────────────────────────────────────────────────
async function sendDailyPush(force = false) {
  if (!force && !shouldSendToday()) {
    console.log(`Frequency is "${loadSettings().frequency}" — not a send day, skipping`);
    return;
  }

  const subs = loadSubs();
  if (subs.length === 0) {
    console.log('No subscriptions yet, skipping push');
    return;
  }

  const noteNum = getNoteIndex() + 1;
  console.log(`Sending push for Note ${noteNum} to ${subs.length} subscriber(s)`);

  const payload = JSON.stringify({
    title: '💚 A note from Jake',
    body: `Note ${noteNum} — open the app to read today's reason`,
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

// ── Cron: runs daily at 19:30 UTC (≈8am NZT) ────────────────────
// shouldSendToday() inside sendDailyPush handles frequency skipping
cron.schedule('30 19 * * *', () => {
  console.log('Cron fired — checking frequency before sending');
  sendDailyPush();
}, {
  timezone: 'UTC'
});

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const { frequency, startDate } = loadSettings();
  console.log(`Push server running on port ${PORT}`);
  console.log(`Frequency: ${frequency} | Start date: ${startDate}`);
  console.log(`Cron runs daily at 19:30 UTC (≈8am NZT) — skips non-send days automatically`);
});
