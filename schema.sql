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
  terms_accepted_at TIMESTAMPTZ,                    -- audit trail: when this recipient ticked the "I agree to the
                                                     -- Terms/Privacy/Code of Conduct" checkbox during first-time
                                                     -- setup on gift.html (see submitOnboarding())
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
  stripe_status          TEXT,        -- active | past_due | canceled (legacy rows may say trialing)
  plan                   TEXT,        -- gift_pack | annual (legacy rows may say installment/monthly)
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
DROP POLICY IF EXISTS "profile_owner_read" ON profiles;
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

DROP TRIGGER IF EXISTS gifts_updated_at ON gifts;
CREATE TRIGGER gifts_updated_at
  BEFORE UPDATE ON gifts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS recipients_updated_at ON recipients;
CREATE TRIGGER recipients_updated_at
  BEFORE UPDATE ON recipients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS notes_updated_at ON notes;
CREATE TRIGGER notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── ROW LEVEL SECURITY ────────────────────────────────────────

ALTER TABLE gifts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipients ENABLE ROW LEVEL SECURITY;

-- GIFTS
-- Buyers can fully manage their own gifts
DROP POLICY IF EXISTS "gift_owner_all" ON gifts;
CREATE POLICY "gift_owner_all" ON gifts
  FOR ALL TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Public (anon) can read active gifts — needed for slug lookup on recipient page.
-- (Superseded further down by the PRICING OVERHAUL block's version of this
-- same policy, which also allows 'cancelled' — left here, still guarded,
-- since dropping/recreating it twice in one run is harmless and this keeps
-- the file readable in its original build order.)
DROP POLICY IF EXISTS "gift_public_read" ON gifts;
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
DROP POLICY IF EXISTS "note_owner_all" ON notes;
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

-- Public can read notes for active gifts (superseded further down, same
-- reasoning as gift_public_read above)
DROP POLICY IF EXISTS "note_public_read" ON notes;
CREATE POLICY "note_public_read" ON notes
  FOR SELECT TO anon
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = notes.gift_id
            AND   gifts.status = 'active')
  );

-- RECIPIENTS
-- Public can insert/update the recipient record for an active gift
-- (the giftee sets their own notification preferences on first visit) —
-- superseded further down, same reasoning as gift_public_read above
DROP POLICY IF EXISTS "recipient_public_upsert" ON recipients;
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
DROP POLICY IF EXISTS "recipient_owner_read" ON recipients;
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
DROP POLICY IF EXISTS "recipient_owner_write" ON recipients;
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

DROP TRIGGER IF EXISTS gift_limit_check ON gifts;
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
DROP POLICY IF EXISTS "buyers_upload_photos" ON storage.objects;
CREATE POLICY "buyers_upload_photos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'photos');

-- Allow public to read photos (recipient page needs them)
DROP POLICY IF EXISTS "public_read_photos" ON storage.objects;
CREATE POLICY "public_read_photos" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'photos');

-- Allow buyers to delete their own photos
DROP POLICY IF EXISTS "buyers_delete_photos" ON storage.objects;
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

-- Same idea — safe to re-run if recipients already existed before the
-- terms-acceptance audit trail (terms_accepted_at) was added.
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

ALTER TABLE abuse_reports ENABLE ROW LEVEL SECURITY;

-- No policies for anon or authenticated — this table is only ever
-- written to or read from by report-abuse.js using the service role
-- key, which bypasses RLS entirely. That's intentional: reports may
-- contain sensitive details, so nothing here should be reachable by
-- a logged-in buyer or the public, only by whoever has server access.

-- ── SUBSCRIPTION EVENTS ───────────────────────────────────────
-- Append-only log of subscription lifecycle events, written by
-- stripe-webhook.js (service role key) as they happen. profiles only
-- ever holds *current* status, so this is what powers the internal
-- admin dashboard's trend charts (enrollments/renewals/cancellations
-- over time) — it can't be reconstructed after the fact from profiles
-- alone. History only starts accumulating from whenever this ships;
-- the backfill below seeds one row per already-existing profile so
-- the dashboard isn't empty on day one, but backfilled dates are
-- approximate (profiles doesn't record exact enrollment/cancel dates).

CREATE TABLE IF NOT EXISTS subscription_events (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id        UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  stripe_customer_id TEXT,
  event_type        TEXT        NOT NULL
                                CHECK (event_type IN ('enrollment','renewal','cancellation','payment_failed')),
  plan              TEXT,        -- gift_pack | annual, at time of event (legacy rows may say installment/monthly)
  amount            NUMERIC,     -- dollars, where known (e.g. renewal invoice amount)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_events_type_created ON subscription_events(event_type, created_at);

ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;

-- No policies for anon or authenticated — written by stripe-webhook.js
-- and read by admin-metrics.js, both using the service role key, which
-- bypasses RLS. This is internal business data (enrollment/cancellation
-- history), not something any buyer or recipient should ever query.

-- One-time backfill — safe to run once schema is up to date. Seeds an
-- 'enrollment' row per existing profile (dated at profiles.created_at)
-- and a 'cancellation' row per already-canceled profile (dated at
-- current_period_end, the closest date we have on hand — the true
-- cancellation date wasn't recorded). Skips profiles that already have
-- a matching event so it's safe to re-run.
INSERT INTO subscription_events (profile_id, stripe_customer_id, event_type, plan, created_at)
SELECT p.id, p.stripe_customer_id, 'enrollment', p.plan, COALESCE(p.created_at, NOW())
FROM profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM subscription_events e
  WHERE e.profile_id = p.id AND e.event_type = 'enrollment'
);

INSERT INTO subscription_events (profile_id, stripe_customer_id, event_type, plan, created_at)
SELECT p.id, p.stripe_customer_id, 'cancellation', p.plan, COALESCE(p.current_period_end, NOW())
FROM profiles p
WHERE p.stripe_status = 'canceled'
AND NOT EXISTS (
  SELECT 1 FROM subscription_events e
  WHERE e.profile_id = p.id AND e.event_type = 'cancellation'
);

-- ══════════════════════════════════════════════════════════════
-- PRICING OVERHAUL — 12-month term + tiered add-on gifts
-- Replaces the old cancel-anytime $9/mo-$90/yr + $2/mo-$20/yr-per-slot
-- model. New model: base plan is a 12-month committed term (paid
-- upfront at $45/yr, or in $4.50/mo installments — NOT cancel-anytime),
-- includes exactly 1 gift. Additional gifts are bought individually,
-- one-time, tiered by how much of the current term is left at purchase
-- (create-addon-checkout.js) — no rollover into a new term, but an
-- active add-on carries over automatically on renewal at a flat $20.
-- Safe to re-run.
-- ══════════════════════════════════════════════════════════════

-- Distinguishes the one gift bundled with the base plan from gifts
-- bought separately as add-ons. Only 'addon' gifts get their own
-- term_end_date/addon_tier_price — an 'included' gift's term always
-- just tracks its buyer's profiles.current_period_end, kept in sync by
-- stripe-webhook.js.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS gift_type TEXT NOT NULL DEFAULT 'included'
  CHECK (gift_type IN ('included','addon'));

-- When this gift's current term ends and it stops receiving new notes
-- (existing notes stay visible either way — see the RLS policy below).
-- For 'included' gifts this mirrors profiles.current_period_end. For
-- 'addon' gifts it's set at purchase time to the base term's end date
-- at that moment, and refreshed only if a renewal rebill succeeds.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS term_end_date TIMESTAMPTZ;

-- What was actually charged for this gift's current term — informational/
-- audit only (shown in account.html, not used in any billing logic
-- itself). Add-ons always rebill at the flat $20 tier on renewal
-- regardless of the discounted tier they originally purchased at.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS addon_tier_price NUMERIC;

CREATE INDEX IF NOT EXISTS idx_gifts_term_end ON gifts(term_end_date);

-- profiles.extra_gift_slots (below, in the original PROFILES block) is
-- superseded by the gift_type/term_end_date columns above and no longer
-- read by any current code — left in place only so historical data
-- isn't lost, not because anything still uses it.

-- New event types for the tiered add-on system + early-cancellation fee.
-- CHECK constraints can't be altered in place — drop and recreate it.
ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;
ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_event_type_check
  CHECK (event_type IN ('enrollment','renewal','cancellation','payment_failed',
                         'addon_purchase','addon_renewal','early_cancellation'));

-- A gift whose term has ended (status='cancelled') should still be
-- viewable by its recipient — "you can't get new notes, but you can
-- still see what you were already sent" — so public read access now
-- covers 'cancelled' as well as 'active'. ('paused' is a separate,
-- buyer-initiated state not part of this flow — left as buyer-only.)
-- Policies have no CREATE OR REPLACE, so drop + recreate under the same
-- name.
DROP POLICY IF EXISTS "gift_public_read" ON gifts;
CREATE POLICY "gift_public_read" ON gifts
  FOR SELECT TO anon
  USING (status IN ('active','cancelled'));

DROP POLICY IF EXISTS "note_public_read" ON notes;
CREATE POLICY "note_public_read" ON notes
  FOR SELECT TO anon
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = notes.gift_id
            AND   gifts.status IN ('active','cancelled'))
  );

-- Recipients can still favorite/adjust prefs while browsing a lapsed
-- gift's past notes, so this stays open for 'cancelled' too.
DROP POLICY IF EXISTS "recipient_public_upsert" ON recipients;
CREATE POLICY "recipient_public_upsert" ON recipients
  FOR ALL TO anon
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = recipients.gift_id
            AND   gifts.status IN ('active','cancelled'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = recipients.gift_id
            AND   gifts.status IN ('active','cancelled'))
  );

-- Supersedes the original enforce_gift_limit() (in the ENFORCE GIFT
-- LIMIT block above): the base plan now includes exactly 1 gift, and
-- every additional gift is bought individually through
-- create-addon-checkout.js — only that flow's webhook handler (service
-- role key, after payment succeeds) ever inserts a gift_type='addon'
-- row, so there's no slot/quantity count left to enforce here. This
-- CREATE OR REPLACE swaps the trigger's behavior in place; the trigger
-- itself (gift_limit_check) doesn't need to change since it already
-- calls this function by name.
CREATE OR REPLACE FUNCTION enforce_gift_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.gift_type = 'included' THEN
    IF (SELECT COUNT(*) FROM gifts WHERE user_id = NEW.user_id AND gift_type = 'included') >= 1 THEN
      RAISE EXCEPTION 'Only one included gift per account — additional gifts are purchased separately.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── FAIR TERM START (first-send anchored, not payment-date anchored) ──
-- The buyer's 12-month "access term" — what actually gates gift
-- delivery, add-on tier pricing, and the early-cancellation fee — is
-- anchored to when their first note actually goes out, not the moment
-- they paid. Someone who takes two weeks to finish setting up their
-- gift shouldn't already be two weeks into their 12 months before their
-- recipient has gotten anything. Capped at 30 days after signup so an
-- abandoned setup doesn't leave the term open-ended forever (see
-- send-daily.js's scheduled sweep for that cap, and _shared.js's
-- ensureTermStarted for the first-send trigger).
--
-- This is DELIBERATELY separate from profiles.current_period_end, which
-- stays exactly what Stripe reports for real billing (charge dates,
-- cancel_at enforcement) — the two can legitimately differ by however
-- long the buyer took to get their first note out. On renewal,
-- access_term_end advances by 365 days from wherever it last ended,
-- independent of Stripe's own new billing period — see
-- handleNewTermStarted in stripe-webhook.js.
--
-- term_start_date is set once, ever, per account — it's the historical
-- anchor, not something that moves. Add-on gifts do NOT get their own
-- first-send-anchored term; they stay pinned to the base gift's
-- access_term_end throughout (gifts.term_end_date already mirrors
-- whichever of these applies).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS term_start_date TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS access_term_end TIMESTAMPTZ;

-- ── ANNUAL PLAN → ONE-TIME PAYMENT ──────────────────────────────────
-- The annual plan is now a genuine one-time $45 charge (mode 'payment'
-- in create-checkout.js) instead of a recurring Stripe subscription —
-- there's nothing left to auto-renew by accident. The installment plan
-- is unchanged (still a real recurring subscription with cancel_at).
--
-- Because annual buyers have no subscription, the SMS add-on can't ride
-- along as a recurring subscription item for them the way it still does
-- for installment buyers — it's billed as a flat one-time charge per
-- gift instead (see stripe-webhook.js's chargeSmsAddonCarryoverOneTime
-- and update-sms-addon.js's annual branch). These two event types record
-- that: 'sms_purchase' when a buyer first enables SMS on a gift,
-- 'sms_renewal' when it's carried over and rebilled at each annual
-- one-time renewal.
ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;
ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_event_type_check
  CHECK (event_type IN ('enrollment','renewal','cancellation','payment_failed',
                         'addon_purchase','addon_renewal','early_cancellation',
                         'sms_purchase','sms_renewal'));

-- ── RENEWAL REMINDER EMAIL ───────────────────────────────────────────
-- Neither plan auto-renews past its 12-month term anymore (annual is a
-- one-time payment now; installment's cancel_at forcibly ends it) — so
-- without a heads-up, a buyer who doesn't happen to check their account
-- page only finds out their gift stopped once it already had. send-daily.
-- js's sweepRenewalReminders sends one email ~30 days before
-- access_term_end. This column marks that it's already gone out for the
-- CURRENT term, so the 15-minute sweep doesn't resend it every cycle for
-- a month straight — it's reset to NULL whenever a new term starts
-- (applyTermStart in _shared.js, and handleNewTermStarted in
-- stripe-webhook.js), so the next term gets its own reminder in due course.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS renewal_reminder_sent_at TIMESTAMPTZ;

-- ── TERM START ANCHORED TO THE CHOSEN start_date ─────────────────────
-- Originally, the buyer's 12-month "access term" was anchored to the
-- moment their included gift's first note actually SENT (a Node-side
-- hook, ensureTermStarted in _shared.js, fired at send time), falling
-- back to 30 days after signup for anyone who never got a first note out
-- at all. That had a real problem for any account whose first note had
-- already gone out before this code existed — legacy accounts — since
-- that send-time hook had already come and gone with nothing to catch
-- it, permanently. Their ONLY path forward was the 30-day fallback,
-- which used created_at + 30 days as a guess — wildly wrong for an
-- account that's been active and paying for a year or more, since the
-- resulting term_end would already be in the past the instant it was
-- written.
--
-- The fix: anchor from the start_date the buyer actually chose for
-- their included gift in the dashboard instead — known immediately at
-- gift-creation time, not something that has to wait to be observed.
-- This trigger fires the moment an 'included' gift row is inserted
-- (whether from account.html's direct client insert or any other path —
-- a database trigger fires on the INSERT itself, which is more reliable
-- than a Node-side hook that has to actually get called), and is a
-- no-op if term_start_date is already set (matches the "set once, ever"
-- rule already established for this field). send-daily.js's 30-day
-- grace sweep remains as the fallback for the one case this can't cover:
-- a buyer who paid but never actually finished creating a gift at all.
CREATE OR REPLACE FUNCTION anchor_term_from_gift_start()
RETURNS TRIGGER AS $$
DECLARE
  existing_start TIMESTAMPTZ;
BEGIN
  IF NEW.gift_type = 'included' THEN
    SELECT term_start_date INTO existing_start FROM profiles WHERE id = NEW.user_id;

    IF existing_start IS NULL THEN
      UPDATE profiles
      SET term_start_date = NEW.start_date::timestamptz,
          access_term_end = NEW.start_date::timestamptz + INTERVAL '365 days',
          renewal_reminder_sent_at = NULL
      WHERE id = NEW.user_id;
    END IF;

    -- Whatever the profile's access_term_end now is (just set above, or
    -- already set from an earlier included gift on this account), mirror
    -- it onto this row so gifts.term_end_date is never left null for an
    -- included gift.
    SELECT access_term_end INTO NEW.term_end_date FROM profiles WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_anchor_term_from_gift_start ON gifts;
CREATE TRIGGER trg_anchor_term_from_gift_start
  BEFORE INSERT ON gifts
  FOR EACH ROW
  EXECUTE FUNCTION anchor_term_from_gift_start();

-- One-time backfill for accounts that already exist as of this
-- migration — sets term_start_date/access_term_end from their included
-- gift's start_date, exactly like the trigger above would have done had
-- it existed when that gift was created. Only touches profiles where
-- term_start_date is still null, so it's safe to re-run (a no-op the
-- second time). Profiles with no included gift on file at all are left
-- alone for send-daily.js's 30-day sweep to handle instead.
UPDATE profiles p
SET term_start_date = g.start_date::timestamptz,
    access_term_end = g.start_date::timestamptz + INTERVAL '365 days'
FROM gifts g
WHERE g.user_id = p.id
  AND g.gift_type = 'included'
  AND p.term_start_date IS NULL;

-- Mirrors the backfilled access_term_end onto every included/add-on gift
-- that doesn't have its own term_end_date set yet — same propagation the
-- trigger and applyTermStart already do for new rows going forward.
UPDATE gifts g
SET term_end_date = p.access_term_end
FROM profiles p
WHERE g.user_id = p.id
  AND g.gift_type IN ('included', 'addon')
  AND g.term_end_date IS NULL
  AND p.access_term_end IS NOT NULL;

-- ── GIFT SETUP REMINDER EMAIL ────────────────────────────────────────
-- A buyer who pays but never actually creates their included gift still
-- gets their term auto-started 30 days after signup (send-daily.js's
-- sweepTermStartGrace) — that clock runs whether or not they ever set
-- anything up. This column tracks whether a heads-up email has already
-- gone out warning them that's about to happen (sweepGiftSetupReminders,
-- ~5 days before the 30-day cutoff), so it's only ever sent once. Unlike
-- renewal_reminder_sent_at, this never needs to reset — the "haven't
-- created a gift yet" state can only ever occur once, before
-- term_start_date is ever set for the first time on an account.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS gift_setup_reminder_sent_at TIMESTAMPTZ;

-- ── RE-ENGAGEMENT TRACKING ───────────────────────────────────────────
-- Nothing in this app previously tracked whether a paying buyer actually
-- opens their account — only billing state (active/canceled/etc). This
-- gives that visibility and powers a dormancy nudge email:
--
--   last_active_at — stamped to now() every time account.html finishes
--     loading for a signed-in buyer (see touch-activity.js, called
--     fire-and-forget from account.html's boot()). NULL for anyone who
--     signed up before this column existed and hasn't logged back in
--     since — send-daily.js treats that the same as "currently dormant."
--
--   reengagement_email_sent_at — sent-once-per-dormancy-episode guard,
--     same pattern as renewal_reminder_sent_at. touch-activity.js clears
--     it back to NULL every time the buyer is actually active, so if they
--     go quiet again later they're eligible for another nudge — it's not
--     a lifetime cap like gift_setup_reminder_sent_at.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reengagement_email_sent_at TIMESTAMPTZ;

-- ══════════════════════════════════════════════════════════════
-- REFERRAL PROGRAM — every buyer gets their own shareable code. When
-- someone they referred completes their FIRST successful payment (not
-- just signs up — see maybeRewardReferral in stripe-webhook.js), BOTH
-- the referrer and the new buyer earn one free bonus gift each, active
-- for as long as their own membership stays active (mirrors the
-- included gift's term — see gift_type below, not a fixed-term
-- purchase like an add-on).
-- ══════════════════════════════════════════════════════════════

-- Each buyer's own shareable code, e.g. "7F3K9Q" — auto-assigned the
-- moment their profiles row is created (see trg_assign_referral_code
-- below), regardless of which code path creates that row.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;

-- The code THIS buyer redeemed at signup, if any (set once, ever, by
-- redeem_referral_code — see below). NULL for anyone who signed up
-- without a code, or who was already a customer before trying to apply
-- one (redeem_referral_code rejects that case — this program is for new
-- members, not existing ones backfilling a code after the fact).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referred_by_code TEXT REFERENCES profiles(referral_code);

-- How many free bonus gift_type='referral' gifts this buyer has earned
-- so far — incremented by 1 for BOTH sides the moment a referral
-- actually pays off (maybeRewardReferral in stripe-webhook.js). This is
-- the only thing gift_type='referral' creation spends against (see
-- enforce_gift_limit below) — it's a running balance, not a one-time
-- flag, so referring multiple people who each convert keeps earning
-- more free gifts.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_gift_credits INTEGER NOT NULL DEFAULT 0;

-- Auto-generates a 6-character code (no 0/O/1/I — avoids look-alike
-- characters when read aloud or typed from a screenshot) and retries on
-- the rare random collision.
CREATE OR REPLACE FUNCTION generate_referral_code()
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code TEXT;
  already_taken BOOLEAN;
BEGIN
  LOOP
    code := '';
    FOR i IN 1..6 LOOP
      code := code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    END LOOP;
    SELECT EXISTS(SELECT 1 FROM profiles WHERE referral_code = code) INTO already_taken;
    EXIT WHEN NOT already_taken;
  END LOOP;
  RETURN code;
END;
$$ LANGUAGE plpgsql;

-- Fires on every profiles insert, from whichever code path creates the
-- row first (record-referral's redeem_referral_code, create-checkout.js,
-- or stripe-webhook.js's upsertProfile) — a table-level trigger is the
-- only place guaranteed to catch all of them, rather than duplicating
-- "assign a code" logic into three separate JS files.
CREATE OR REPLACE FUNCTION assign_referral_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.referral_code IS NULL THEN
    NEW.referral_code := generate_referral_code();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_referral_code ON profiles;
CREATE TRIGGER trg_assign_referral_code
  BEFORE INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION assign_referral_code();

-- Backfill codes for any profiles rows that already existed as of this
-- migration (the trigger above only fires on new inserts going forward).
UPDATE profiles SET referral_code = generate_referral_code() WHERE referral_code IS NULL;

-- Append-only record of each referral, one row per referee (a buyer can
-- only ever be referred once — enforced by the UNIQUE on referee_id).
-- Written entirely by redeem_referral_code (status='pending', at
-- signup) and updated to 'rewarded' by stripe-webhook.js's
-- maybeRewardReferral the instant the referee's first payment actually
-- clears. Kept separate from profiles.referred_by_code so a referral's
-- outcome and timestamps survive even past a buyer's later
-- cancellation, and so the admin dashboard has real history to report
-- on (see subscription_events below for the matching event log entry).
CREATE TABLE IF NOT EXISTS referrals (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referee_id    UUID        NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  code          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rewarded_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status   ON referrals(status);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- Buyers can see referrals they made (powers the "X successful
-- referrals" stat on account.html) but not the reverse — a referee has
-- no need to see this row via this table; their own referred_by_code
-- is already readable off their own profiles row.
DROP POLICY IF EXISTS "referral_referrer_read" ON referrals;
CREATE POLICY "referral_referrer_read" ON referrals
  FOR SELECT TO authenticated
  USING (auth.uid() = referrer_id);

-- All writes come from record-referral.js and stripe-webhook.js using
-- the service role key, which bypasses RLS — no write policy needed.

-- New gift_type: a free bonus gift earned through the referral program.
-- Term-wise it behaves exactly like an 'included' gift — mirrors its
-- owner's own profiles.access_term_end (see anchor_term_from_gift_start
-- and handleNewTermStarted, both extended below) — but it's never
-- itself charged for, and a buyer can hold more than one (one per
-- earned credit, gated by enforce_gift_limit below).
ALTER TABLE gifts DROP CONSTRAINT IF EXISTS gifts_gift_type_check;
ALTER TABLE gifts ADD CONSTRAINT gifts_gift_type_check
  CHECK (gift_type IN ('included','addon','referral'));

-- Extends enforce_gift_limit (originally defined in the PRICING
-- OVERHAUL block above) rather than replacing its 'included' branch —
-- CREATE OR REPLACE swaps the function body in place, the trigger
-- itself doesn't need to change since it already calls this function by
-- name.
--
-- The referral branch requires the buyer to currently be an
-- active/trialing member themselves (not just holding an unspent
-- credit) — "another gift, free for the duration of THEIR membership"
-- only means something if they have one right now. In practice this is
-- already guaranteed by the time a credit exists (credits are only
-- granted post-payment — see maybeRewardReferral), but this makes it a
-- real database-level guarantee rather than something that just
-- happens to be true today, including for a referrer whose membership
-- has since lapsed.
CREATE OR REPLACE FUNCTION enforce_gift_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.gift_type = 'included' THEN
    IF (SELECT COUNT(*) FROM gifts WHERE user_id = NEW.user_id AND gift_type = 'included') >= 1 THEN
      RAISE EXCEPTION 'Only one included gift per account — additional gifts are purchased separately.';
    END IF;
  ELSIF NEW.gift_type = 'referral' THEN
    IF COALESCE((SELECT stripe_status FROM profiles WHERE id = NEW.user_id), '') NOT IN ('active', 'trialing') THEN
      RAISE EXCEPTION 'Referral gifts are only available to active members.';
    END IF;
    IF (SELECT COUNT(*) FROM gifts WHERE user_id = NEW.user_id AND gift_type = 'referral')
       >= (SELECT COALESCE(referral_gift_credits, 0) FROM profiles WHERE id = NEW.user_id) THEN
      RAISE EXCEPTION 'No unused referral credit — refer another member to earn another free gift.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Extends anchor_term_from_gift_start (PRICING OVERHAUL block above) so
-- a 'referral' gift anchors/mirrors the buyer's access_term_end exactly
-- like an 'included' gift does — same CREATE OR REPLACE-in-place
-- pattern as enforce_gift_limit above.
CREATE OR REPLACE FUNCTION anchor_term_from_gift_start()
RETURNS TRIGGER AS $$
DECLARE
  existing_start TIMESTAMPTZ;
BEGIN
  IF NEW.gift_type IN ('included', 'referral') THEN
    SELECT term_start_date INTO existing_start FROM profiles WHERE id = NEW.user_id;

    IF existing_start IS NULL THEN
      UPDATE profiles
      SET term_start_date = NEW.start_date::timestamptz,
          access_term_end = NEW.start_date::timestamptz + INTERVAL '365 days',
          renewal_reminder_sent_at = NULL
      WHERE id = NEW.user_id;
    END IF;

    SELECT access_term_end INTO NEW.term_end_date FROM profiles WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- New event type, logged once per side (referrer + referee) by
-- maybeRewardReferral the moment a referral is rewarded — feeds the
-- same admin dashboard history subscription_events already powers for
-- enrollments/renewals/cancellations.
ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;
ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_event_type_check
  CHECK (event_type IN ('enrollment','renewal','cancellation','payment_failed',
                         'addon_purchase','addon_renewal','early_cancellation',
                         'sms_purchase','sms_renewal','referral_reward'));

-- Atomic credit increment, called twice by maybeRewardReferral (once
-- for the referrer, once for the referee) — a real SQL function rather
-- than a Node read-then-write so two referrals for the same referrer
-- being rewarded around the same moment can't race and silently lose
-- one of the increments.
CREATE OR REPLACE FUNCTION increment_referral_credits(target_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles SET referral_gift_credits = referral_gift_credits + 1 WHERE id = target_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Does all the work of applying a referral code for one referee, in a
-- single atomic statement rather than several round trips from
-- record-referral.js (which would otherwise race against itself on a
-- double-submit, or leave a half-applied state on a failure partway
-- through). Handles both "this buyer has no profiles row yet at all"
-- (the common case — most buyers haven't checked out the first time
-- they'd plausibly enter a code) and "row already exists" in the same
-- INSERT ... ON CONFLICT.
--
-- Returns a short status string rather than raising, since "code
-- doesn't exist" / "already applied" / "already a customer" are
-- expected, common outcomes that record-referral.js needs to turn into
-- a specific user-facing message — not exceptional failures.
--
-- Deliberately does NOT grant anything here — redeeming a code just
-- records who referred whom (status='pending'). The actual reward (one
-- free bonus gift each) only happens once this referee's first payment
-- succeeds — see maybeRewardReferral in stripe-webhook.js. Someone who
-- redeems a code and never pays never triggers a reward for either
-- side.
CREATE OR REPLACE FUNCTION redeem_referral_code(referee_id_in UUID, code_in TEXT)
RETURNS TEXT AS $$
DECLARE
  referrer_id_found    UUID;
  existing_referred_by TEXT;
  existing_customer_id TEXT;
BEGIN
  SELECT id INTO referrer_id_found FROM profiles WHERE referral_code = code_in;
  IF referrer_id_found IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF referrer_id_found = referee_id_in THEN
    RETURN 'self';
  END IF;

  SELECT referred_by_code, stripe_customer_id INTO existing_referred_by, existing_customer_id
  FROM profiles WHERE id = referee_id_in;

  IF existing_referred_by IS NOT NULL THEN
    RETURN 'already_applied';
  END IF;
  -- A non-null stripe_customer_id means this buyer has already been
  -- through checkout at least once before (even if they later
  -- cancelled) — referral codes are for new members, not existing ones
  -- retroactively crediting a friend.
  IF existing_customer_id IS NOT NULL THEN
    RETURN 'already_customer';
  END IF;

  INSERT INTO profiles (id, referred_by_code) VALUES (referee_id_in, code_in)
  ON CONFLICT (id) DO UPDATE
    SET referred_by_code = EXCLUDED.referred_by_code
    WHERE profiles.referred_by_code IS NULL;

  -- referee_id's UNIQUE constraint turns a double-submit race into a
  -- harmless no-op here rather than an error.
  INSERT INTO referrals (referrer_id, referee_id, code)
  VALUES (referrer_id_found, referee_id_in, code_in)
  ON CONFLICT (referee_id) DO NOTHING;

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ══════════════════════════════════════════════════════════════
-- 7-DAY FREE TRIAL — both plans are now real Stripe subscriptions
-- (annual switched from a one-time payment back to a recurring yearly
-- subscription specifically so it can carry a trial too — see
-- create-checkout.js). A first-time buyer's card isn't charged until
-- the trial converts; stripe-webhook.js's invoice.payment_succeeded
-- handler is what actually logs 'enrollment' for that buyer at that
-- point, not checkout.session.completed (which now only fires with the
-- subscription still in 'trialing' status for anyone who gets a trial).
-- ══════════════════════════════════════════════════════════════

-- Which Stripe subscription a subscription_events row belongs to, if any
-- (add-on/SMS/referral events have no subscription behind them, hence
-- nullable). stripe-webhook.js's invoice.payment_succeeded handler uses
-- this to tell "this subscription's first successful charge" (the
-- trial converting, or a legacy no-trial subscription's very first
-- cycle) apart from a routine mid-term cycle already accounted for —
-- checking "does ANY event already exist for this exact subscription
-- id" is a simpler and more robust signal than trying to infer it from
-- Stripe's billing_reason/trial_end fields alone, which don't
-- distinguish those cases on their own.
ALTER TABLE subscription_events ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sub_events_subscription ON subscription_events(stripe_subscription_id);

-- ── ANNUAL'S TRIAL IS SELF-MANAGED, NOT A STRIPE SUBSCRIPTION TRIAL ──
-- The annual Price in Stripe is a genuine one-time price, not recurring —
-- Stripe's native trial_period_days only works on a subscription, which
-- requires a recurring price. Rather than force a new recurring Price
-- into existence just for this, annual's trial is tracked here instead:
-- stripe-webhook.js's handleAnnualTrialSetup sets trial_ends_at (7 days
-- out) and stripe_status='trialing' the moment a trial-eligible buyer's
-- card is saved (via a Stripe Checkout 'setup' session — see
-- create-checkout.js), with NO stripe_subscription_id at all. A
-- dedicated scheduled function (process-annual-trials.js) is what
-- actually charges the saved card once trial_ends_at arrives — nothing
-- on Stripe's side does this automatically for a one-time price the way
-- it would for a real subscription. Installment is unaffected by any of
-- this — its Price is already recurring, so it keeps using Stripe's
-- native subscription trial exactly as before.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- How many times process-annual-trials.js has attempted to charge the
-- saved card for this trial. Retry policy: charge once when trial_ends_at
-- first arrives; if that fails (card declined, etc.), retry once a day,
-- emailing the buyer each time, up to a fixed attempt cap — after which
-- the trial is treated as expired (access cut off, gifts deactivated)
-- rather than retried forever. Reset to 0 automatically has no need here
-- since a profile only ever goes through this once (trial eligibility —
-- see create-checkout.js — is a one-time thing per buyer).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_charge_attempts INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- SECURITY HARDENING (round 1) — closes every finding from the
-- Supabase security advisor without changing any existing app
-- behavior. Every real caller of the functions below already uses
-- the service-role key (record-referral.js, stripe-webhook.js,
-- process-annual-trials.js), and trigger functions don't need an
-- EXECUTE grant to fire as triggers — so revoking client access to
-- all of them is purely a hardening step, not a functional one.
-- ============================================================

-- Referral RPCs + internal trigger/helper functions: no legitimate
-- caller is anon/authenticated — revoke direct client access so the
-- anon key alone can no longer be used to mint free referral credits
-- or redeem codes on someone else's behalf.
REVOKE EXECUTE ON FUNCTION increment_referral_credits(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION redeem_referral_code(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION create_profile_on_signup()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION enforce_gift_limit()               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION anchor_term_from_gift_start()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION generate_referral_code()           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION assign_referral_code()              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION touch_updated_at()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_updated_at()                FROM PUBLIC, anon, authenticated;

-- Pin search_path on the same functions so none of them can be tricked
-- into resolving an object from an attacker-controlled schema earlier
-- on the path. Every reference inside them is already an unqualified
-- public-schema name, so this is purely additive.
ALTER FUNCTION increment_referral_credits(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION redeem_referral_code(uuid, text) SET search_path = public, pg_temp;
ALTER FUNCTION create_profile_on_signup()        SET search_path = public, pg_temp;
ALTER FUNCTION enforce_gift_limit()               SET search_path = public, pg_temp;
ALTER FUNCTION anchor_term_from_gift_start()      SET search_path = public, pg_temp;
ALTER FUNCTION generate_referral_code()           SET search_path = public, pg_temp;
ALTER FUNCTION assign_referral_code()             SET search_path = public, pg_temp;
ALTER FUNCTION touch_updated_at()                 SET search_path = public, pg_temp;
ALTER FUNCTION update_updated_at()                SET search_path = public, pg_temp;

-- recipients: drop the two legacy, totally unscoped policies. Both are
-- fully superseded by policies already in place ("recipients: public
-- update active", "recipients: public upsert active",
-- "recipient_public_upsert", "recipient_owner_write"), which already
-- cover every real path: an anonymous recipient onboarding/updating
-- prefs on an active (or, for the anon-specific policy, cancelled)
-- gift, and the signed-in buyer managing their own gift's recipient
-- row. Postgres OR's permissive policies together, so these unscoped
-- "true" policies were silently overriding the scoped ones — dropping
-- them just restores the scoping, with no loss of function.
DROP POLICY IF EXISTS "recipients: public update" ON recipients;
DROP POLICY IF EXISTS "recipients: public upsert" ON recipients;

-- storage.objects: drop the broad SELECT policies that let any
-- anon/authenticated caller LIST every file in these public buckets.
-- This does not affect viewing a photo or voice note — photos/voice-
-- notes/voicenotes are all public buckets, so a GET on a known
-- /object/public/... URL (all account.html's getPublicUrl() and
-- gift.html's <img>/<audio> tags ever produce) is served straight off
-- the bucket's public flag and never consults these RLS policies at
-- all. The one caller that does call .list() on these buckets
-- (scripts/compress-existing-photos.js) explicitly runs on the
-- service-role key, which bypasses RLS entirely, so it's unaffected.
DROP POLICY IF EXISTS "photos: public read"            ON storage.objects;
DROP POLICY IF EXISTS "public_read_photos"             ON storage.objects;
DROP POLICY IF EXISTS "authenticated_read_voice_notes"  ON storage.objects;
DROP POLICY IF EXISTS "public_read_voice_notes"         ON storage.objects;
DROP POLICY IF EXISTS "authenticated_read_voicenotes"   ON storage.objects;
DROP POLICY IF EXISTS "public_read_voicenotes"          ON storage.objects;

-- Not covered above — needs a dashboard toggle, not SQL: "Leaked
-- Password Protection" under Supabase Dashboard > Authentication >
-- Attack Protection > "Prevent use of leaked passwords" > Configure in
-- email provider. Checks new passwords against HaveIBeenPwned; doesn't
-- touch this schema at all.

-- ============================================================
-- SECURITY HARDENING (round 2) — BRUTE-FORCE PROTECTION for the two
-- password gates found in the app-level follow-up review: gift page
-- passwords (gifts.access_password, checked by verify-gift-
-- password.js / update-gift-password.js) and the admin dashboard
-- password (admin-metrics.js). Both had zero rate limiting — gift
-- slugs are low-entropy (auto-generated from the recipient's name,
-- e.g. "mom" — see autoSlug() in account.html), so an unthrottled
-- guessing script was a real risk. Purely additive: new nullable/
-- defaulted columns and a new table, so nothing changes behavior on
-- its own — see the Netlify functions for the actual lockout logic.
-- ============================================================

-- gifts: per-gift guess counter + lockout timestamp, same shape as
-- the existing trial_charge_attempts pattern on profiles. Shared by
-- verify-gift-password.js and update-gift-password.js so a burst of
-- wrong guesses through either endpoint counts against one budget.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS password_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS password_locked_until TIMESTAMPTZ;

-- admin dashboard: a single shared password with no per-row owner to
-- attach a counter to, so this is a deliberately single-row table
-- (id is always `true`, enforced by the CHECK constraint below). RLS
-- is enabled with NO policies — same pattern as subscription_events /
-- abuse_reports — so only the service-role key admin-metrics.js
-- already uses can ever touch it; anon/authenticated get nothing.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  CONSTRAINT admin_login_attempts_single_row CHECK (id)
);
INSERT INTO admin_login_attempts (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
ALTER TABLE admin_login_attempts ENABLE ROW LEVEL SECURITY;

-- ── LOCK A NOTE TO A SPECIFIC DATE ──
-- Every note's send date has always been purely a function of its
-- position in the sequence (order_index) — insert, delete, or drag-
-- reorder anything before it, and its date shifts. Lets a buyer pin a
-- specific note (an anniversary, a birthday) to an exact calendar date
-- so it stops moving: account.html's resequenceUnsentNotes() keeps a
-- locked note fixed at the order_index that date resolves to (via
-- dateToSlotIndex), and reflows every floating note around it instead.
-- NULL (the default) means "floating," exactly as every note has always
-- behaved.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS locked_send_date DATE;

-- Only one note per gift can claim a given pinned date — there's only
-- one send slot per date, so two locked notes targeting the same one
-- would be an unresolvable conflict. Partial index (only enforced when
-- locked_send_date IS NOT NULL) so floating notes (the overwhelming
-- majority) aren't affected at all.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_locked_send_date_unique
  ON notes(gift_id, locked_send_date) WHERE locked_send_date IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- PRICING UPDATE — 30-Day Gift Pack replaces the $4.50/mo installment
-- plan; annual moves from $45 to $59; new $45 upgrade path from gift
-- pack to annual. Safe to re-run.
--
--   gift_pack — $14, one-time payment, 30-day term. Replaces the old
--     'installment' plan value (there were no active installment
--     subscribers at the time of this migration, so no data migration
--     was needed for existing rows).
--   annual    — unchanged mechanically, just $59 instead of $45 (a new
--     Stripe Price object, since Stripe prices are immutable — the
--     STRIPE_ANNUAL_PRICE_ID env var just points at the new one now).
--   upgrade   — a new one-time $45 charge, only offered to a buyer
--     currently on an active, unexpired 'gift_pack' term (see
--     create-checkout.js's plan: 'upgrade'), converting them straight to
--     a fresh 365-day annual term.
--
-- Neither plan has a free trial any more either — both are charged
-- immediately at checkout (see create-checkout.js) — so
-- profiles.trial_ends_at / trial_charge_attempts and the
-- process-annual-trials.js scheduled function they powered are no
-- longer used by any live code path. Left in place rather than dropped,
-- matching this file's existing "don't lose historical data" pattern
-- for retired columns (see profiles.extra_gift_slots above).
-- ══════════════════════════════════════════════════════════════

-- New 'upgrade' event type, logged once by stripe-webhook.js's
-- handleUpgradeToAnnual when a gift_pack buyer pays the discounted $45
-- to move to annual.
ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;
ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_event_type_check
  CHECK (event_type IN ('enrollment','renewal','cancellation','payment_failed',
                         'addon_purchase','addon_renewal','early_cancellation',
                         'sms_purchase','sms_renewal','referral_reward','upgrade'));

-- Supersedes anchor_term_from_gift_start (originally defined in the
-- PRICING OVERHAUL block, extended in the REFERRAL PROGRAM block above)
-- so a fresh term's length depends on which plan the buyer is actually
-- on: 30 days for gift_pack, 365 days for everyone else (annual, and any
-- legacy profile whose plan value predates this migration). Same
-- CREATE OR REPLACE-in-place pattern as those earlier versions — the
-- trigger itself doesn't need to change since it already calls this
-- function by name.
CREATE OR REPLACE FUNCTION anchor_term_from_gift_start()
RETURNS TRIGGER AS $$
DECLARE
  existing_start TIMESTAMPTZ;
  buyer_plan     TEXT;
  term_days      INTEGER;
BEGIN
  IF NEW.gift_type IN ('included', 'referral') THEN
    SELECT term_start_date, plan INTO existing_start, buyer_plan FROM profiles WHERE id = NEW.user_id;

    IF existing_start IS NULL THEN
      term_days := CASE WHEN buyer_plan = 'gift_pack' THEN 30 ELSE 365 END;
      UPDATE profiles
      SET term_start_date = NEW.start_date::timestamptz,
          access_term_end = NEW.start_date::timestamptz + make_interval(days => term_days),
          renewal_reminder_sent_at = NULL
      WHERE id = NEW.user_id;
    END IF;

    SELECT access_term_end INTO NEW.term_end_date FROM profiles WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION anchor_term_from_gift_start() SET search_path = public, pg_temp;

-- ══════════════════════════════════════════════════════════════
-- RECIPIENT REPLIES — two-way conversation, threaded per note
-- Run this block against an existing database to add support for the
-- recipient responding to a specific note, and the buyer replying back,
-- right in the app (account.html / gift.html). Each note gets its own
-- thread — this is not one big gift-wide chat.
--
-- Reads are open to both sides via RLS, same trust boundary as notes
-- themselves (note_public_read/note_owner_all): the buyer reads/writes
-- directly as an authenticated user; the recipient (anon, no login)
-- can read directly too. WRITES from the recipient side deliberately do
-- NOT get an anon RLS policy, unlike recipients_public_upsert — they go
-- through submit-note-reply.js instead (service-role key), so the
-- buyer's email notification fires in the same request as the insert.
-- Buyer-side sends also go through a function (send-note-reply.js)
-- rather than a direct client insert, for the same reason: the
-- recipient's notification (push/email/sms, matching however they
-- already receive notes) needs to fire somewhere, and there's no
-- database trigger wired up to call out to Resend/Twilio/web-push.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS note_replies (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  note_id    UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  gift_id    UUID        NOT NULL REFERENCES gifts(id) ON DELETE CASCADE, -- denormalized off notes.gift_id at insert time, purely so RLS/queries don't need a join through notes
  sender     TEXT        NOT NULL CHECK (sender IN ('buyer', 'recipient')),
  body       TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_replies_note ON note_replies(note_id, created_at);
CREATE INDEX IF NOT EXISTS idx_note_replies_gift ON note_replies(gift_id);

ALTER TABLE note_replies ENABLE ROW LEVEL SECURITY;

-- Buyers can read (and, in principle, directly delete/edit) every reply
-- on their own gifts — mirrors note_owner_all. In practice account.html
-- only ever reads through this policy; sending a new buyer message goes
-- through send-note-reply.js instead (see header comment above).
DROP POLICY IF EXISTS "note_reply_owner_all" ON note_replies;
CREATE POLICY "note_reply_owner_all" ON note_replies
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM gifts WHERE gifts.id = note_replies.gift_id AND gifts.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM gifts WHERE gifts.id = note_replies.gift_id AND gifts.user_id = auth.uid())
  );

-- Recipients (anon) can read the thread on any note belonging to a gift
-- that's still active/cancelled — same status gate as note_public_read.
-- No anon INSERT policy on purpose (see header comment).
DROP POLICY IF EXISTS "note_reply_public_read" ON note_replies;
CREATE POLICY "note_reply_public_read" ON note_replies
  FOR SELECT TO anon
  USING (
    EXISTS (SELECT 1 FROM gifts
            WHERE gifts.id = note_replies.gift_id
            AND   gifts.status IN ('active', 'cancelled'))
  );

-- ── DAILY ACTIVITY DIGEST ────────────────────────────────────────
-- One row per calendar date (in the digest's own Pacific/Auckland clock)
-- that's already had its digest email sent — see daily-digest.js. Netlify
-- Scheduled Functions run on plain UTC cron with no timezone awareness of
-- their own, so daily-digest.js runs every 15 minutes (same cadence as
-- send-daily.js/process-annual-trials.js) and checks the *actual* local
-- time in Auckland on every tick, same pattern isDeliveryWindow already
-- uses for recipient delivery windows. This table is what stops that
-- from sending the same day's digest twice if more than one tick lands
-- inside the send hour.
CREATE TABLE IF NOT EXISTS daily_digest_runs (
  digest_date DATE        PRIMARY KEY,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE daily_digest_runs ENABLE ROW LEVEL SECURITY;
-- No policies — service-role key only (daily-digest.js is the only thing
-- that ever touches this table), same as admin_login_attempts above.

-- ── WHO IS THIS GIFT FOR? ─────────────────────────────────────────────
-- Captured once, at gift-creation time, from the "New gift" modal in
-- account.html (fixed dropdown + free-text "Other"). Purely a marketing/
-- demographic signal for admin-metrics.js's aggregate breakdown — never
-- shown to the recipient, never used in any delivery/billing logic.
-- recipient_relationship holds one of the fixed dropdown keys so
-- admin-metrics.js can group cleanly; recipient_relationship_other holds
-- the buyer's own free-text wording when they pick "Other" (kept
-- separate rather than crammed into the same column so the aggregate
-- doesn't fragment into a long tail of one-off strings).
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS recipient_relationship TEXT
  CHECK (recipient_relationship IN
    ('partner','parent','grandparent','child','sibling','friend','coworker','other'));
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS recipient_relationship_other TEXT;

-- ── EMAIL UNSUBSCRIBES (self-hosted, mirrored to Resend) ─────────────
-- Our own permanent record of every unsubscribe, written by
-- netlify/functions/unsubscribe.js the moment someone clicks an
-- unsubscribe link (see unsubscribeUrl in _shared.js). This table is the
-- source of truth — Resend's own contact.unsubscribed flag and account-
-- wide suppression list are kept in sync as a mirror, best-effort, but a
-- failed Resend API call at click time never blocks this row from being
-- written first, so an unsubscribe is honored immediately regardless of
-- Resend's availability at that moment.
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  email           TEXT        NOT NULL UNIQUE,
  source          TEXT,                              -- free-text label for which list/campaign this came from
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resend_synced   BOOLEAN     NOT NULL DEFAULT FALSE  -- true once BOTH the contact-update and suppression-add calls to Resend succeeded
);
CREATE INDEX IF NOT EXISTS idx_email_unsubscribes_email ON email_unsubscribes(email);

ALTER TABLE email_unsubscribes ENABLE ROW LEVEL SECURITY;
-- No policies — service-role key only (unsubscribe.js is the only thing
-- that ever touches this table), same pattern as daily_digest_runs above.

-- ── GIFT PACK → ANNUAL UPGRADE NUDGE (fires ~halfway through the 30-day
-- term) ────────────────────────────────────────────────────────────────
-- Separate from renewal_reminder_sent_at (which fires once, ~5 days
-- before a term ends, for EITHER plan) — this is a second, earlier,
-- gift_pack-only email that actively pitches the standing $45 upgrade-to-
-- annual offer (see startUpgradeCheckout in account.html / the 'upgrade'
-- plan in create-checkout.js) while there's still time left to act on it,
-- rather than only mentioning it in passing in the final reminder. See
-- send-daily.js's sweepUpgradeNudges. Reset to NULL alongside
-- renewal_reminder_sent_at whenever a new term starts (stripe-webhook.js)
-- so a buyer who buys another gift pack later is eligible for the nudge
-- again on their new term.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS upgrade_nudge_sent_at TIMESTAMPTZ;
