-- 0020_award_acceptance.sql
--
-- A grantee saying yes.
--
-- THE DEAD END THIS FIXES. `awards.status` has admitted 'active' -- "accepted,
-- term running, reports expected" -- since 0012, and nothing could ever put an
-- award into it. `award.accepted` has been a declared audit action since Phase
-- 0 and nothing has ever written that row. Data health checks active awards
-- for a missing W-9, agreement and media release, and those checks could never
-- fire on anything because no award could become active.
--
-- The award letter built last week tells a grantee to sign in and see "what we
-- need from you before funds are released". They sign in and there is nothing
-- to do.
--
-- WHY A SEPARATE accepted_at RATHER THAN READING status = 'active'. Status is
-- a state and this is an event: "when did they accept" is the question asked
-- when a payment is queried, and a status column cannot answer it. The three
-- document columns already work this way for the same reason.
--
-- A GRANTEE CAN SAY NO. Not every award survives acceptance -- the terms may
-- not work, the project may have lost its other funding, the organization may
-- have folded. Recording that as a cancellation with the grantee's own reason
-- is the difference between a portfolio that says what happened and one where
-- fifty awards sit 'pending' forever because nobody had a way to close them.

ALTER TABLE awards ADD COLUMN accepted_at TEXT;
-- The grantee user who clicked, not the admin. An acceptance recorded by staff
-- on a grantee's behalf is a different fact and is recorded by its note.
ALTER TABLE awards ADD COLUMN accepted_by_user_id TEXT REFERENCES users(id);

-- Their answer in their words, whichever way it went. Required on a refusal,
-- optional on an acceptance -- "yes" needs no explanation and "no" always does.
ALTER TABLE awards ADD COLUMN grantee_response_note TEXT;
ALTER TABLE awards ADD COLUMN declined_by_grantee_at TEXT;

-- An acceptance records who and when, together or not at all. A timestamp with
-- no actor cannot answer the question it exists for.
CREATE TRIGGER awards_acceptance_is_complete_insert
BEFORE INSERT ON awards
WHEN (NEW.accepted_at IS NOT NULL) <> (NEW.accepted_by_user_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'an acceptance records who accepted and when');
END;

CREATE TRIGGER awards_acceptance_is_complete_update
BEFORE UPDATE OF accepted_at, accepted_by_user_id ON awards
WHEN (NEW.accepted_at IS NOT NULL) <> (NEW.accepted_by_user_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'an acceptance records who accepted and when');
END;

-- A refusal always carries a reason. "Declined" with nothing behind it is a
-- gap exactly where the next person asks what happened.
CREATE TRIGGER awards_grantee_refusal_needs_a_reason_insert
BEFORE INSERT ON awards
WHEN NEW.declined_by_grantee_at IS NOT NULL
 AND (NEW.grantee_response_note IS NULL OR TRIM(NEW.grantee_response_note) = '')
BEGIN
  SELECT RAISE(ABORT, 'a grantee refusal must record a reason');
END;

CREATE TRIGGER awards_grantee_refusal_needs_a_reason_update
BEFORE UPDATE OF declined_by_grantee_at, grantee_response_note ON awards
WHEN NEW.declined_by_grantee_at IS NOT NULL
 AND (NEW.grantee_response_note IS NULL OR TRIM(NEW.grantee_response_note) = '')
BEGIN
  SELECT RAISE(ABORT, 'a grantee refusal must record a reason');
END;

-- Accepted and refused are not both true. Reached only by a hand-written
-- update, which is exactly the case a CHECK cannot be added for after the fact
-- and a trigger can.
CREATE TRIGGER awards_cannot_be_both_insert
BEFORE INSERT ON awards
WHEN NEW.accepted_at IS NOT NULL AND NEW.declined_by_grantee_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an award cannot be both accepted and refused');
END;

CREATE TRIGGER awards_cannot_be_both_update
BEFORE UPDATE OF accepted_at, declined_by_grantee_at ON awards
WHEN NEW.accepted_at IS NOT NULL AND NEW.declined_by_grantee_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an award cannot be both accepted and refused');
END;

-- "What is waiting on a grantee." Partial, because after a cycle settles
-- almost nothing is pending and that is the only thing this asks about.
CREATE INDEX awards_awaiting_acceptance_idx
  ON awards (organization_id)
  WHERE status = 'pending' AND accepted_at IS NULL AND deleted_at IS NULL;
