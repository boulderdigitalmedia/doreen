// POST /api/transcode-voice
// Header: Authorization: Bearer <supabase_access_token>
// Body: { giftId, audioBase64, mimeType }
//
// Voice notes are recorded client-side with whatever format the sender's
// own browser's MediaRecorder supports — audio/webm;codecs=opus on Chrome
// and most non-Apple browsers, audio/mp4 (Safari's unlabelled default)
// everywhere else. That's fine for the sender, but playback happens on a
// completely different device: Safari (iOS and macOS) cannot play
// webm/opus at all, so a note recorded on Chrome silently fails to play
// for a recipient on an iPhone — no error, nothing visible, just a dead
// play button (account.html's <audio>.play().catch(()=>{}) swallows the
// rejection).
//
// Fix: never store what the sender's browser happened to produce. Every
// upload runs through here first, gets transcoded server-side to a single
// universal format (AAC in an .m4a container — the one format every
// mainstream browser, Safari included, can play), and *that* file is what
// actually lands in storage. Playback is then never dependent on what
// device the note was recorded on.

const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sb, ok, err, preflight } = require('./_shared');

const execFileAsync = promisify(execFile);

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_INPUT_BYTES = 25 * 1024 * 1024; // generous ceiling — real clips (<=3min, compressed) are nowhere near this

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return err('Unauthorized', 401);

  const { data: { user }, error: authErr } = await sbAdmin.auth.getUser(token);
  if (authErr || !user) return err('Unauthorized', 401);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }

  const { giftId, audioBase64, mimeType } = body;
  if (!giftId)      return err('giftId required');
  if (!audioBase64) return err('audioBase64 required');

  // Verify the gift belongs to this user — same ownership check send-now.js
  // uses, just by id instead of slug since that's what account.html has on
  // hand while a note is being saved.
  const { data: gift, error: giftErr } = await sbAdmin
    .from('gifts')
    .select('id')
    .eq('id', giftId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (giftErr || !gift) return err('Gift not found', 404);

  let inputBuffer;
  try {
    inputBuffer = Buffer.from(audioBase64, 'base64');
  } catch {
    return err('Invalid audioBase64');
  }
  if (!inputBuffer.length) return err('Empty audio');
  if (inputBuffer.length > MAX_INPUT_BYTES) return err('Recording too large', 413);

  const inExt  = (mimeType || '').indexOf('mp4') !== -1 ? 'mp4' : 'webm';
  const workId = crypto.randomUUID();
  const inPath  = path.join(os.tmpdir(), `${workId}-in.${inExt}`);
  const outPath = path.join(os.tmpdir(), `${workId}-out.m4a`);

  try {
    await fs.writeFile(inPath, inputBuffer);

    // ffmpeg-static's binary routinely loses its executable bit when a
    // bundler zips/repackages node_modules for deploy (a well-documented
    // recurring issue on Lambda-based platforms, which is what Netlify
    // Functions run on) — re-asserting it here is cheap, idempotent, and
    // guards against that regardless of which build step actually stripped it.
    try { await fs.chmod(ffmpegPath, 0o755); } catch (chmodErr) {
      console.error('could not chmod ffmpeg binary:', chmodErr.message);
    }

    // 96kbps mono AAC — plenty for spoken voice, keeps the file small.
    // +faststart moves the moov atom to the front so it starts playing
    // without waiting on the whole file, same reason it's used for web video.
    try {
      await execFileAsync(ffmpegPath, [
        '-y',
        '-i', inPath,
        '-vn',
        '-ac', '1',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        outPath,
      ], { timeout: 25000 });
    } catch (ffmpegError) {
      // Logged in full server-side (Netlify function logs) for real
      // diagnosis — the client only ever sees the generic message below,
      // since raw ffmpeg/stderr output isn't something a recipient-facing
      // error toast should expose.
      console.error('ffmpeg transcode failed. path:', ffmpegPath,
        '| code:', ffmpegError.code,
        '| message:', ffmpegError.message,
        '| stderr:', ffmpegError.stderr);
      return err('Could not process this recording — try recording again', 500);
    }

    const outputBuffer = await fs.readFile(outPath);

    const filename = `${user.id}/${giftId}/${Date.now()}-voice.m4a`;
    const { error: uploadErr } = await sb.storage
      .from('voicenotes')
      .upload(filename, outputBuffer, { upsert: true, contentType: 'audio/mp4' });

    if (uploadErr) {
      console.error('voice note storage upload failed:', uploadErr.message);
      return err('Could not save the transcoded recording', 500);
    }

    const { data: urlData } = sb.storage.from('voicenotes').getPublicUrl(filename);
    return ok({ url: urlData.publicUrl });
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
};
