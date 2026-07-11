// One-off maintenance script — re-encodes every photo already sitting in
// the "photos" Supabase Storage bucket down to the same treatment new
// uploads get automatically as of this session (see uploadPhoto() in
// account.html): max 1600px on the longest edge, JPEG at 82% quality.
// Skips anything already under 300KB or in a format not worth
// re-encoding (gif/svg), matching the app's own upload-time thresholds.
//
// Each file is overwritten IN PLACE at its existing storage path, so
// every notes.photo_url already saved in the database keeps working
// unchanged — there is no need to touch the database at all.
//
// This is a destructive operation: the original, full-resolution upload
// is gone once a file is overwritten. Two safety nets are built in:
//   1. Defaults to DRY RUN — logs what it would do without changing
//      anything, until you explicitly pass --live.
//   2. Before overwriting anything for real, saves a local copy of the
//      original file under ./photo-backups/<same path>, so you can
//      restore any single photo by re-uploading it from there if needed.
//
// Setup (run locally — this needs the service role key, which should
// never be pasted into a chat or committed to the repo):
//
//   npm install @supabase/supabase-js sharp
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/compress-existing-photos.js
//
// That runs a dry run first. Review the output, then run again with
// --live to actually apply it:
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/compress-existing-photos.js --live
//
// Safe to stop and re-run — anything already under the size threshold
// (including files this script already compressed) gets skipped, so an
// interrupted run just picks back up where it left off.

const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET       = 'photos';
const MAX_DIM       = 1600;
const QUALITY        = 82;
const MIN_SIZE       = 300 * 1024; // skip files already smaller than this
const BACKUP_DIR     = path.join(__dirname, '..', 'photo-backups');
const LIVE            = process.argv.includes('--live');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Storage list() isn't recursive — folders come back with id/metadata set
// to null, files don't — so walk the tree ourselves. Paths look like
// <userId>/<giftId>/<filename>, two folder levels deep, but this walks
// arbitrarily deep just in case.
async function listAllFiles(prefix) {
  prefix = prefix || '';
  const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw error;

  var files = [];
  for (var i = 0; i < data.length; i++) {
    var entry = data[i];
    var entryPath = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.id === null) {
      var nested = await listAllFiles(entryPath);
      files = files.concat(nested);
    } else {
      files.push({ path: entryPath, size: (entry.metadata && entry.metadata.size) || 0 });
    }
  }
  return files;
}

async function run() {
  console.log(LIVE ? 'LIVE RUN — files will be overwritten.' : 'DRY RUN — nothing will be changed. Pass --live to actually apply it.');
  console.log('Listing files in bucket "' + BUCKET + '"...');
  var files = await listAllFiles();
  console.log('Found ' + files.length + ' file(s).\n');

  var compressed = 0, skipped = 0, failed = 0, savedBytes = 0;

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!/\.(jpe?g|png|webp)$/i.test(file.path)) { skipped++; continue; }
    if (file.size && file.size < MIN_SIZE) { skipped++; continue; }

    try {
      var dl = await sb.storage.from(BUCKET).download(file.path);
      if (dl.error) throw dl.error;
      var inputBuffer = Buffer.from(await dl.data.arrayBuffer());

      var outputBuffer = await sharp(inputBuffer)
        .rotate() // apply EXIF orientation before stripping it
        .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: QUALITY })
        .toBuffer();

      if (outputBuffer.length >= inputBuffer.length) { skipped++; continue; } // re-encoding didn't help — leave it alone

      var fromKB = (inputBuffer.length / 1024).toFixed(0);
      var toKB   = (outputBuffer.length / 1024).toFixed(0);

      if (!LIVE) {
        console.log('[dry run] ' + file.path + '  ' + fromKB + 'KB -> ' + toKB + 'KB');
        compressed++;
        savedBytes += inputBuffer.length - outputBuffer.length;
        continue;
      }

      var backupPath = path.join(BACKUP_DIR, file.path);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, inputBuffer);

      var up = await sb.storage.from(BUCKET).upload(file.path, outputBuffer, {
        upsert: true,
        contentType: 'image/jpeg',
      });
      if (up.error) throw up.error;

      compressed++;
      savedBytes += inputBuffer.length - outputBuffer.length;
      console.log('✓ ' + file.path + '  ' + fromKB + 'KB -> ' + toKB + 'KB');
    } catch (e) {
      failed++;
      console.error('✗ ' + file.path + ': ' + e.message);
    }
  }

  console.log('\nDone — compressed: ' + compressed + ', skipped: ' + skipped + ', failed: ' + failed + ', saved: ' + (savedBytes / 1024 / 1024).toFixed(1) + 'MB');
  if (LIVE && compressed > 0) {
    console.log('Originals backed up to ' + BACKUP_DIR + ' before overwriting, in case anything needs restoring.');
  }
  if (!LIVE) {
    console.log('This was a dry run — nothing was changed. Re-run with --live to apply.');
  }
}

run().catch(function(e) {
  console.error('Script failed:', e);
  process.exit(1);
});
