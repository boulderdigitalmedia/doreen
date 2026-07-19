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
  plan              TEXT,        -- monthly | annual, at time of event
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
