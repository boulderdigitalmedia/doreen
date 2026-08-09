// GET /api/gift-manifest?slug=<slug>
//
// Per-gift Web App Manifest — see the <script> right above the robots
// meta tag in gift.html's <head> for how this gets linked in. The static
// manifest.json at the site root still exists (sw.js precaches it as an
// asset), but nothing should link to it directly any more; every gift
// page points here instead, with its own slug baked into start_url.
//
// Two reasons this needs to be per-gift rather than one shared file:
//
//   1. Chrome's "Add to Home Screen" install-banner criteria require a
//      *linked* manifest to even offer itself — without one, Android
//      recipients only get a plain browser bookmark if they dig for it
//      in the menu, not the native install prompt. A single static
//      manifest would satisfy that criteria but...
//   2. ...start_url has to point back at THIS gift's own slug, or
//      installing it would land you back on the marketing homepage
//      every time you tapped the icon, not your notes — no static file
//      shared across every gift can do that.
//
// name/short_name are personalized off the gift's own display_name (same
// info already visible on the gift page itself, nothing new exposed) so
// two different gifts installed side by side on one phone don't show up
// as two identical, indistinguishable "A Note For You" icons.

const { sb } = require('./_shared');

const corsHeaders = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FALLBACK_MANIFEST = {
  name:             'A Note For You',
  short_name:       'A Note For You',
  description:      'Daily notes, delivered for someone you care about',
  start_url:        '/',
  display:          'standalone',
  background_color: '#f5f2ec',
  theme_color:      '#f5f2ec',
  orientation:      'portrait',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};

function manifestResponse(manifest) {
  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/manifest+json',
      // Same reasoning as netlify.toml's *.html rule — a stale start_url
      // pointing at a slug that's since changed (or a stale personalized
      // name) is hard to notice and not worth risking for a resource
      // that's only ever fetched at install time anyway.
      'Cache-Control': 'no-cache, must-revalidate',
    },
    body: JSON.stringify(manifest),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  const slug = ((event.queryStringParameters && event.queryStringParameters.slug) || '').trim();
  if (!slug) return manifestResponse(FALLBACK_MANIFEST);

  // Wrapped so any unexpected failure (DB hiccup, etc.) still returns a
  // valid, installable manifest instead of a raw 502 — this endpoint is
  // fetched automatically by the browser/PWA install flow, which has no
  // way to show or recover from an error the way a user-initiated action
  // could. Same "always return something installable" philosophy as the
  // unknown-slug case below, just extended to cover real errors too.
  try {
    // Same status gate as every other public gift read (note_public_read,
    // note_reply_public_read, etc.) — a cancelled/lapsed gift's page still
    // works read-only, so its manifest should still resolve too, not just
    // active ones.
    const { data: gift, error } = await sb
      .from('gifts')
      .select('slug, display_name')
      .eq('slug', slug)
      .in('status', ['active', 'cancelled'])
      .maybeSingle();

    if (error) console.error('gift-manifest query failed for slug', slug, ':', error.message);

    // Unknown/deleted/other-account slug (or a query error, per above) —
    // still return *something* installable rather than erroring, so a
    // stale or bad link doesn't break the install prompt outright. It
    // just won't be personalized or deep-linked to a specific gift.
    if (!gift) return manifestResponse(FALLBACK_MANIFEST);

    const recipientFirst = (gift.display_name || '').split(/[&,]/)[0].trim();
    const name      = recipientFirst ? `Notes for ${recipientFirst}` : 'A Note For You';
    const shortName = recipientFirst || 'A Note For You';

    return manifestResponse({
      name:             name,
      short_name:       shortName,
      description:      'Daily notes, delivered for someone you care about',
      start_url:        '/' + gift.slug,
      scope:            '/' + gift.slug,
      display:          'standalone',
      background_color: '#f5f2ec',
      theme_color:      '#f5f2ec',
      orientation:      'portrait',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch (e) {
    console.error('gift-manifest crashed for slug', slug, ':', e.message, e.stack);
    return manifestResponse(FALLBACK_MANIFEST);
  }
};
