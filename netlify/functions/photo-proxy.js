// GET /api/photo-proxy?path=<storage-path-within-photos-bucket>
//
// Streams a note photo from the (public) Supabase "photos" bucket back
// through our own domain instead of the browser hitting Supabase's storage
// host directly. Plain <img> tags never need this — browsers will always
// display a cross-origin image fine. But gift.html's share feature needs
// the actual image bytes client-side (to composite the branded share image
// on a canvas, and to build a File for navigator.share / a downloadable
// blob), and both canvas pixel access and fetch() are subject to CORS —
// unlike <img> display. If the storage host doesn't send the right
// Access-Control-Allow-Origin header, those attempts silently fail and
// sharing falls back to text-only, with no image ever offered.
//
// Routing the bytes through this same-origin endpoint sidesteps that
// entirely: the server-to-server fetch below isn't subject to browser CORS
// at all, and the response back to the browser is same-origin, so nothing
// downstream (canvas, fetch, File/Blob) can ever be CORS-blocked.
//
// `path` is the bit after `/storage/v1/object/public/photos/` in a
// photo_url, e.g. "userId/giftId/1699999999999.jpg" — see uploadPhoto() in
// account.html for how that path is built on upload.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const path = ((event.queryStringParameters && event.queryStringParameters.path) || '').trim();

  // Only allow path shapes that look like what uploadPhoto() actually
  // creates — no traversal, no absolute paths, no sneaking a different host
  // in here to turn this into an open proxy.
  if (!path || path.includes('..') || path.startsWith('/') || path.includes('://')) {
    return { statusCode: 400, body: 'Invalid path' };
  }

  const sourceUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/photos/${path}`;

  let upstream;
  try {
    upstream = await fetch(sourceUrl);
  } catch (e) {
    return { statusCode: 502, body: 'Could not fetch photo' };
  }

  if (!upstream.ok) {
    return { statusCode: upstream.status, body: 'Photo not found' };
  }

  const arrayBuffer = await upstream.arrayBuffer();
  const contentType = upstream.headers.get('content-type') || 'image/jpeg';

  return {
    statusCode: 200,
    headers: {
      'Content-Type':  contentType,
      // Photos can be replaced (same path, upsert: true) or deleted, so
      // don't cache too aggressively — a day is enough to help repeat
      // shares without risking a stale image sticking around after an edit.
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
    body: Buffer.from(arrayBuffer).toString('base64'),
    isBase64Encoded: true,
  };
};
