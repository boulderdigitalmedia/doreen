-- ══════════════════════════════════════════════════════════════
-- "From [Name], With Love" — Supabase Schema
-- Run this in: Supabase dashboard → SQL Editor → New query
-- ══════════════════════════════════════════════════════════════

-- ── GIFTS ─────────────────────────────────────────────────────
-- One row per gift. The buyer creates up to 4 of these.

CREATE TABLE IF NOT EXISTS gifts (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug            TEXT        NOT NULL UNIQUE
                              CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  display_name    TEXT        NOT NULL,          -- e.g. "Jake & Doreen"
  sender_name     TEXT        NOT NULL DEFAULT 'Your Favorite',
  start_date      DATE        NOT NULL,
  frequency       TEXT        NOT NULL DEFAULT 'daily'
                              CHECK (frequency IN ('daily','weekly','biweekly','monthly')),
  status          TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','paused','cancelled')),
  delivery_time   TIME        NOT NULL DEFAULT '08:00:00',  -- local time of day to send, in `timezone` below
  timezone        TEXT        NOT NULL DEFAULT 'Pacific/Auckland', -- IANA tz name, e.g. 'America/Denver'
  planned_notes_count INTEGER,                     -- buyer's intended total note count (e.g. 60) — used as the
                                                     -- denominator on the recipient's progress bar; NULL falls
                                                     -- back to however many notes actually exist
  access_password TEXT,                             -- optional simple passcode gating the public gift page (see
                                                     -- verify-gift-password.js — never sent to the browser directly;
                                                     -- checked server-side with the service role key). NULL/empty = no gate.
  sms_addon       BOOLEAN     NOT NULL DEFAULT FALSE,
  stripe_subscription_id TEXT,
  stripe_customer_id     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── NOTES ─────────────────────────────────────────────────────
-- Ordered list of notes for each gift.

CREATE TABLE IF NOT EXISTS notes (
  id              UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  gift_id         UUID    NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  order_index     INTEGER NOT NULL,
  text            TEXT    NOT NULL,
  photo_url       TEXT,                              -- Supabase Storage public URL
  photo_position  TEXT    DEFAULT '50% 50%',         -- CSS object-position, e.g. "30% 70%" — lets the sender reframe a cropped photo
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (gift_id, order_index)
);

-- ── RECIPIENTS ────────────────────────────────────────────────
-- One row per gift. Stores the giftee's notification preferences.

CREATE TABLE IF NOT EXISTS recipients (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  gift_id           UUID        NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  push_subscription JSONB,                       -- web push subscription object
  email             TEXT,
  phone             TEXT,
  channels          TEXT[]      DEFAULT ARRAY[]::TEXT[],  -- ['push','email','sms']
  delivery_time     TIME,                        -- recipient's own preferred send time; NULL = use gift's default
  timezone          TEXT,                        -- recipient's own IANA tz name; NULL = use gift's default
  favorites         INTEGER[]   DEFAULT ARRAY[]::INTEGER[], -- note order_indexes the giftee has favourited — synced here so it follows them across devices
  onboarded_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (gift_id)
);

-- ── PROFILES ──────────────────────────────────────────────────
-- One row per buyer (auth user). Tracks their Stripe subscription
-- status — gates access to the dashboard (see account.html boot())
-- and is written by create-checkout.js / stripe-webhook.js.

CREATE TABLE IF NOT EXISTS profiles (
  id                     UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  stripe_status          TEXT,        -- active | trialing | past_due | canceled
  plan                   TEXT,        -- monthly | annual
  current_period_end     TIMESTAMPTZ,
  extra_gift_slots       INTEGER     NOT NULL DEFAULT 0, -- paid add-on gift slots beyond the
                                                          -- 2 included in the base subscription —
                                                          -- kept in sync with a recurring Stripe
                                                          -- subscription item by update-gift-slots.js.
                                                          -- Priced per whichever interval (monthly/
                                                          -- annual) the buyer's `plan` already is.
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Buyers can read their own profile (needed for the paywall check in account.html)
CREATE POLICY "profile_owner_read" ON profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

-- Note: all writes to profiles come from Netlify functions using the
-- service role key (create-checkout.js, stripe-webhook.js), which
-- bypasses RLS, so no write policy is needed here.

-- ── INDEXES ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_gifts_user_id  ON gifts(user_id);
CREATE INDEX IF NOT EXISTS idx_gifts_slug     ON gifts(slug);
CREATE INDEX IF NOT EXISTS idx_gifts_status   ON gifts(status);
CREATE INDEX IF NOT EXISTS idx_notes_gift     ON notes(gift_id, order_index);

-- ── UPDATED_AT TRIGGER ────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gifts_updated_at
  BEFORE UPDATE ON gifts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER recipients_updated_at
  BEFORE UPDATE ON recipients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── ROW LEVEL SECURITY ────────────────────────────────────────

ALTER TABLE gifts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipients ENABLE ROW LEVEL SECURITY;

-- GIFTS
-- Buyers can fully manage their own gifts
CREATE POLICY "gift_owner_all" ON gifts
  FOR ALL TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Public (anon) can read active gifts — needed for slug lookup on recipient page
CREATE POLICY "gift_public_read" ON gifts
  FOR SELECT TO anon
  USING (status = 'active');

-- RLS is row-level only, so on its own it can't hide just the password
-- column from a row anon is otherwise allowed to read. This column-level
-- REVOKE closes that gap: the anon role can no longer read access_password
-- at all (via gift.html's own query or a raw REST call), even for active
-- gifts. Password checks and changes always go through
-- verify-gift-password.js / update-gift-password.js, which use the
-- service-role key and bypass this restriction. Note anon has no UPDATE
-- grant on gifts at all, so recipients can't write to this column even
-- indirectly — every write to access_password happens through that function.
REVOKE SELECT (access_password) ON gifts FROM anon;

-- NOTES
-- Buyers manage notes on their own gifts
CREATE POLICY "note_owner_all" ON notes
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = notes.gift_id
            AND   gifts.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = notes.gift_id
            AND   gifts.user_id = auth.uid())
  );

-- Public can read notes for active gifts
CREATE POLICY "note_public_read" ON notes
  FOR SELECT TO anon
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = notes.gift_id
            AND   gifts.status = 'active')
  );

-- RECIPIENTS
-- Public can insert/update the recipient record for an active gift
-- (the giftee sets their own notification preferences on first visit)
CREATE POLICY "recipient_public_upsert" ON recipients
  FOR ALL TO anon
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = recipients.gift_id
            AND   gifts.status = 'active')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = recipients.gift_id
            AND   gifts.status = 'active')
  );

-- Buyers can read the recipient record for their own gifts (dashboard stats)
CREATE POLICY "recipient_owner_read" ON recipients
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = recipients.gift_id
            AND   gifts.user_id = auth.uid())
  );

-- Buyers can also set/update the recipient record themselves for their own
-- gifts (e.g. entering the recipient's email directly from the dashboard,
-- instead of waiting for the giftee to onboard via the public link)
CREATE POLICY "recipient_owner_write" ON recipients
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = recipients.gift_id
            AND   gifts.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = recipients.gift_id
            AND   gifts.user_id = auth.uid())
  );

-- ── ENFORCE GIFT LIMIT ────────────────────────────────────────
-- Every subscription includes 2 gifts. Buyers can purchase additional
-- gift slots as a recurring add-on (see update-gift-slots.js), tracked
-- in profiles.extra_gift_slots — the real limit is 2 + that value.

CREATE OR REPLACE FUNCTION enforce_gift_limit()
RETURNS TRIGGER AS $$
DECLARE
  gift_limit INTEGER;
BEGIN
  SELECT 2 + COALESCE(extra_gift_slots, 0) INTO gift_limit
  FROM profiles WHERE id = NEW.user_id;

  gift_limit := COALESCE(gift_limit, 2); -- no profile row yet → base limit only

  IF (SELECT COUNT(*) FROM gifts WHERE user_id = NEW.user_id) >= gift_limit THEN
    RAISE EXCEPTION 'Gift limit reached: your plan currently allows % gift(s). Add another gift slot to create more.', gift_limit;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER gift_limit_check
  BEFORE INSERT ON gifts
  FOR EACH ROW EXECUTE FUNCTION enforce_gift_limit();

-- ── STORAGE BUCKET ────────────────────────────────────────────
-- Run separately in: Supabase dashboard → Storage → New bucket
-- Name: "photos"  |  Public: YES
-- Or run this SQL:

INSERT INTO storage.buckets (id, name, public)
VALUES ('photos', 'photos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated buyers to upload photos
CREATE POLICY "buyers_upload_photos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'photos');

-- Allow public to read photos (recipient page needs them)
CREATE POLICY "public_read_photos" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'photos');

-- Allow buyers to delete their own photos
CREATE POLICY "buyers_delete_photos" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'photos' AND auth.uid()::text = (storage.foldername(name))[1]);

-- ── ABUSE REPORTS ─────────────────────────────────────────────
-- Submitted via the "Report a concern" link on gift.html, written
-- by netlify/functions/report-abuse.js using the service role key.
-- No auth required to submit — reporters may not have an account.

CREATE TABLE IF NOT EXISTS abuse_reports (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  gift_slug       TEXT,                              -- the gift page being reported, if any
  page_url        TEXT,                              -- full window.location.href at time of report,
                                                       -- captured automatically (not typed by the reporter)
  reason          TEXT        NOT NULL
                              CHECK (reason IN ('nudity','minor','harassment','impersonation','spam','other')),
  details         TEXT,                              -- free-text description from the reporter
  reporter_email  TEXT,                               -- optional, for follow-up
  status          TEXT        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','reviewing','resolved','dismissed')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Safe to re-run even if abuse_reports already existed without this column
-- (e.g. if you ran the migration before page_url was added here).
ALTER TABLE abuse_reports ADD COLUMN IF NOT EXISTS page_url TEXT;

CREATE INDEX IF NOT EXISTS idx_abuse_reports_gift_slug ON abuse_reports(gift_slug);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_status    ON abuse_reports(status);

ALTER TABLE abuse_reports ENABLE ROW LEVEL SECURITY;

-- No policies for anon or authenticated — this table is only ever
-- written to or read from by report-abuse.js using the service role
-- key, which bypasses RLS entirely. That's intentional: reports may
-- contain sensitive details, so nothing here should be reachable by
-- a logged-in buyer or the public, only by whoever has server access.
