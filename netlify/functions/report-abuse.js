// POST /api/report-abuse
// Body: { giftSlug, pageUrl, reason, details, reporterEmail }
// No auth required — reporters may not have (or want) an account, and may
// be reporting a gift page precisely because something there feels unsafe.
//
// Saves the report to the abuse_reports table (see schema.sql for the
// migration) and immediately emails the team so it actually gets seen —
// a report that just sits in a database nobody checks isn't a real
// reporting mechanism. Reports flagged "minor" get an urgent subject line,
// since content involving a minor carries its own legal reporting
// obligations independent of anything this function does automatically.

const { sb, resend, buildFrom, ok, err, preflight } = require('./_shared');

const VALID_REASONS = ['nudity', 'minor', 'harassment', 'impersonation', 'spam', 'other'];
const REASON_LABELS = {
  nudity:        'Nude or sexually explicit content',
  minor:         'Content involving a minor',
  harassment:    'Harassment or threats',
  impersonation: 'Impersonation',
  spam:          'Spam or scam',
  other:         'Something else',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }

  const giftSlug      = (body.giftSlug || '').trim().slice(0, 200) || null;
  const pageUrl       = (body.pageUrl || '').trim().slice(0, 500) || null;
  const reason        = body.reason;
  const details       = (body.details || '').trim().slice(0, 4000) || null;
  const reporterEmail = (body.reporterEmail || '').trim().slice(0, 320) || null;

  if (!VALID_REASONS.includes(reason)) {
    return err('A valid reason is required');
  }

  const { data: report, error } = await sb
    .from('abuse_reports')
    .insert({
      gift_slug:      giftSlug,
      page_url:       pageUrl,
      reason,
      details,
      reporter_email: reporterEmail,
    })
    .select()
    .single();

  if (error) {
    return err('Could not submit report: ' + error.message, 500);
  }

  // Email is the primary way this actually gets seen day-to-day — the DB
  // row is the durable record, but nobody's watching a table by default.
  try {
    const isUrgent = reason === 'minor';
    const subject = (isUrgent ? '🚨 URGENT — ' : '⚠ ') + 'Abuse report: ' + REASON_LABELS[reason] +
      (giftSlug ? ' — /' + giftSlug : '');

    await resend.emails.send({
      from:    buildFrom('A Note For You — Abuse Reports'),
      to:      process.env.ABUSE_REPORT_EMAIL || 'support@anoteforyou.app',
      subject,
      html: `<div style="font-family:Arial,sans-serif;color:#2c3a2e;max-width:560px;margin:0 auto;padding:24px;">
        ${isUrgent ? '<p style="background:#fbeae8;border:1px solid #edc4be;border-radius:8px;padding:12px 16px;color:#c0392b;font-weight:bold;">This report involves a minor. Review immediately — see the Code of Conduct commitment to report such content to NCMEC and/or law enforcement.</p>' : ''}
        <p><strong>Reason:</strong> ${REASON_LABELS[reason] || reason}</p>
        <p><strong>Gift:</strong> ${giftSlug ? `/${giftSlug}` : '(not specified)'}</p>
        <p><strong>Page URL:</strong> ${pageUrl ? `<a href="${pageUrl}">${pageUrl}</a>` : '(not captured)'}</p>
        <p><strong>Reporter email:</strong> ${reporterEmail || '(not provided)'}</p>
        <p><strong>Details:</strong><br>${(details || '(none provided)').replace(/\n/g, '<br>')}</p>
        <p style="color:#8fa391;font-size:12px;">Report ID: ${report.id}<br>Submitted: ${report.created_at}</p>
      </div>`,
    });
  } catch (e) {
    // The report is already saved either way — don't fail the request
    // just because the notification email had a problem.
    console.error('Failed to send abuse report notification email:', e.message);
  }

  return ok({ ok: true });
};
