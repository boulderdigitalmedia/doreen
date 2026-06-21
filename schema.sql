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
  sms_addon       BOOLEAN     NOT NULL DEFAULT FALSE,
  stripe_subscription_id TEXT,
  stripe_customer_id     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── NOTES ─────────────────────────────────────────────────────
-- Ordered list of notes for each gift.

CREATE TABLE IF NOT EXISTS notes (
  id          UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  gift_id     UUID    NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  photo_url   TEXT,                              -- Supabase Storage public URL
  created_at  TIMESTAMPTZ DEFAULT NOW(),
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
  onboarded_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (gift_id)
);

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

-- ── ENFORCE 4-GIFT LIMIT ──────────────────────────────────────
-- Prevent buyers from creating a 5th gift at the DB level.

CREATE OR REPLACE FUNCTION enforce_gift_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM gifts WHERE user_id = NEW.user_id) >= 4 THEN
    RAISE EXCEPTION 'Gift limit reached: a subscription allows up to 4 gifts.';
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
