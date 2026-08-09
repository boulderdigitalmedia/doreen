// GET /api/unsubscribe?email=<email>&token=<hmac>
//
// Handles clicks on the self-hosted unsubscribe link every bulk/campaign
// email includes (see unsubscribeUrl in _shared.js) — this is deliberately
// NOT Resend's own hosted unsubscribe flow. Our own email_unsubscribes
// table (schema.sql) is the permanent source of truth for who's opted
// out; Resend is kept in sync as a mirror on a best-effort basis, so an
// unsubscribe is honored immediately even if the Resend API call below
// happens to fail or Resend is briefly unreachable.
//
// The token is an HMAC of the email address (unsubscribeToken in
// _shared.js) rather than the bare address on its own — otherwise anyone
// could unsubscribe an arbitrary email address just by guessing/knowing
// it, with no proof they're the actual recipient of that link.
//
// Two things happen in Resend on a successful unsubscribe:
//   1. contacts.update({ unsubscribed: true }) — makes the Contacts UI
//      and any future Broadcast correctly skip this address.
//   2. suppressions.add({ email }) — the harder, account-wide block: no
//      email of ANY kind (Broadcast, one-off API send, transactional)
//      goes to this address again from this Resend account until the
//      suppression is manually removed. This is the right call for a
//      permanent opt-out request — Contact.unsubscribed alone only
//      protects against Broadcast sends, not a one-off resend.emails.send()
//      call that forgets to check it.
//
// Both are plain fetch() calls against Resend's REST API directly,
// rather than the `resend` npm SDK's newer .contacts/.suppressions
// namespaces — the pinned SDK version (see package.json) predates those,
// and a raw authenticated HTTP call has no version-compatibility risk.

const { sb, unsubscribeToken } = require('./_shared');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

function htmlPage(title, message) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: 'DM Sans', Arial, sans-serif; background: #f5f2ec; color: #2c3a2e;
      display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 420px; text-align: center;
      box-shadow: 0 4px 24px rgba(80,110,85,0.10); }
    h1 { font-size: 22px; font-weight: 500; margin: 0 0 12px; }
    p { font-size: 15px; color: #5a6e5c; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`,
  };
}

async function syncToResend(email) {
  if (!RESEND_API_KEY) {
    console.error('unsubscribe: RESEND_API_KEY not set, skipping Resend sync for', email);
    return false;
  }

  let contactOk = false;
  let suppressionOk = false;

  try {
    const res = await fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ unsubscribed: true }),
    });
    // A 404 here just means this address was never imported as a Resend
    // Contact (e.g. it's not part of the 24k list) — not a real failure,
    // since the suppression add below is what actually matters for
    // blocking future sends either way.
    contactOk = res.ok || res.status === 404;
    if (!res.ok && res.status !== 404) {
      console.error('unsubscribe: Resend contact update failed for', email, res.status, await res.text());
    }
  } catch (e) {
    console.error('unsubscribe: Resend contact update threw for', email, e.message);
  }

  try {
    const res = await fetch('https://api.resend.com/suppressions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
    suppressionOk = res.ok;
    if (!res.ok) {
      console.error('unsubscribe: Resend suppression add failed for', email, res.status, await res.text());
    }
  } catch (e) {
    console.error('unsubscribe: Resend suppression add threw for', email, e.message);
  }

  return contactOk && suppressionOk;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'Method not allowed' };
  }

  const params = event.queryStringParameters || {};
  const email = (params.email || '').trim().toLowerCase();
  const token = (params.token || '').trim();

  if (!email || !token) {
    return htmlPage('Missing information', "This unsubscribe link is missing some information and can't be processed.");
  }

  // Constant-time-ish check via simple string equality is fine here — this
  // isn't a password comparison against a stored secret an attacker could
  // brute-force character-by-character over the network in a meaningful
  // number of attempts; it's a one-shot HMAC validity check.
  const expectedToken = unsubscribeToken(email);
  if (token !== expectedToken) {
    return htmlPage('Link not valid', "This unsubscribe link doesn't look right. If you're trying to unsubscribe, please use the link from the most recent email you received.");
  }

  try {
    // Written first, independent of whatever happens with Resend below —
    // this is what actually guarantees the opt-out is honored. ON
    // CONFLICT is a no-op on an already-existing row (idempotent: clicking
    // an old email's unsubscribe link twice is harmless), not an update,
    // so the original unsubscribed_at timestamp is preserved.
    const { error: insertErr } = await sb
      .from('email_unsubscribes')
      .insert({ email })
      .select()
      .single();

    // Postgres unique-violation code — already unsubscribed, not a real error.
    if (insertErr && insertErr.code !== '23505') {
      console.error('unsubscribe: failed to record unsubscribe for', email, insertErr.message);
      return htmlPage('Something went wrong', "We couldn't process your unsubscribe request just now — please try the link again in a moment.");
    }

    const synced = await syncToResend(email);
    if (synced) {
      await sb.from('email_unsubscribes').update({ resend_synced: true }).eq('email', email);
    }

    return htmlPage("You're unsubscribed", `${email} has been removed from our mailing list. You won't receive any more emails like this one.`);
  } catch (e) {
    console.error('unsubscribe crashed for', email, ':', e.message, e.stack);
    return htmlPage('Something went wrong', "We couldn't process your unsubscribe request just now — please try the link again in a moment.");
  }
};
