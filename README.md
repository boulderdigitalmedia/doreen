# From Jake, With Love — Daily Love Notes PWA

A beautiful Progressive Web App that shows your wife a new reason you love her each day.

---

## What's included

| File | Purpose |
|------|---------|
| `index.html` | The entire app — edit the `notes` array to personalise |
| `manifest.json` | Makes it installable as a home screen app |
| `sw.js` | Service worker — makes it work offline |

---

## How to deploy (free, 5 minutes)

### Option A — Netlify Drop (easiest)
1. Go to **netlify.com/drop**
2. Drag the entire `love-notes/` folder onto the page
3. Netlify gives you a free URL like `https://happy-flamingo-123.netlify.app`
4. Send that URL to your wife's phone

### Option B — GitHub Pages
1. Create a free GitHub account
2. New repo → upload these 3 files
3. Settings → Pages → Deploy from main branch
4. Get a URL like `https://yourusername.github.io/love-notes`

### Option C — Vercel
1. Go to vercel.com → New Project → drag folder
2. Free hosting, instant URL

---

## How she installs it to her home screen

### iPhone (Safari)
1. Open the URL in Safari (must be Safari, not Chrome)
2. Tap the **Share** button (box with arrow)
3. Tap **"Add to Home Screen"**
4. Done — it appears like a real app, no App Store needed

### Android (Chrome)
1. Open the URL in Chrome
2. A banner will appear automatically: "Add to Home Screen"
3. Or: tap the three-dot menu → "Install app"

---

## Personalising the notes

Open `index.html` in any text editor and find this section:

```javascript
const notes = [
  "The way you laugh at your own jokes...",
  "You make ordinary Tuesday evenings...",
  // Add as many as you like!
];
```

Replace or add lines — one string per reason. The app automatically shows
the note for the current day (cycling through the list). With 30+ notes,
she'll get a fresh one every day of the month.

---

## Features
- ♥ One new note per day, cycling automatically
- ← → Swipe or tap to browse all notes
- 📱 Installs to home screen like a native app
- ✈️ Works fully offline after first load
- 🌹 Dark, warm, intimate aesthetic

---

*Built with love, for love.*
