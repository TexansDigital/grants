-- 0011_auth_hardening.sql
--
-- Closes findings from the adversarial review of 0010. Written as a new
-- migration rather than an edit to 0010 because this session cannot verify
-- whether 0010 has been applied, and editing an applied migration is
-- forbidden. Expressed as TRIGGERS rather than CHECKs because SQLite cannot
-- add a CHECK to an existing table without rebuilding it.

-- =============================================================================
-- 1. The revocation cutoff must never move backwards.
--
-- 0010's claim is that sign-out is immediate AND irreversible because it does
-- not depend on KV propagation. That only holds if users.sessions_valid_from
-- never decreases -- and it was a bare TEXT column with nothing guarding it.
-- Clearing it, or lowering it, resurrected every session revoked in the
-- previous seven days, because isRevoked() treats a null cutoff as "nothing is
-- revoked". Any future "reactivate this account" admin action that nulled the
-- column would have silently done exactly that.
-- =============================================================================
CREATE TRIGGER users_sessions_valid_from_monotonic
BEFORE UPDATE OF sessions_valid_from ON users
WHEN OLD.sessions_valid_from IS NOT NULL
 AND (NEW.sessions_valid_from IS NULL
      OR NEW.sessions_valid_from < OLD.sessions_valid_from)
BEGIN
  SELECT RAISE(ABORT, 'users.sessions_valid_from cannot move backwards: revoked sessions stay revoked');
END;

-- =============================================================================
-- 2. A live token's redemption record cannot be forged or erased.
--
-- 0010 froze token_hash, user_id, sent_to_email, expires_at and issued_at, and
-- its comment claimed "consuming is the ONLY legal update". It was not:
--
--   * requested_ip and requested_user_agent -- the columns 0010's own comment
--     calls "the signal a human would want, and it cannot be reconstructed
--     later" -- were erasable right up until the token settled.
--   * consumed_at could be set to ANY time at or after issue, including a date
--     in the future. That kills a live link and writes permanent, immutable
--     false evidence that somebody signed in, on a table with no delete path.
-- =============================================================================
CREATE TRIGGER login_tokens_forensics_frozen
BEFORE UPDATE ON login_tokens
WHEN NEW.id                   <> OLD.id
  OR NEW.purpose              <> OLD.purpose
  OR NEW.created_at           <> OLD.created_at
  OR COALESCE(NEW.requested_ip, '')         <> COALESCE(OLD.requested_ip, '')
  OR COALESCE(NEW.requested_user_agent, '') <> COALESCE(OLD.requested_user_agent, '')
BEGIN
  SELECT RAISE(ABORT, 'login_tokens: identity and request forensics are frozen');
END;

-- A token cannot be recorded as redeemed after it expired. Combined with the
-- existing consumed_at >= issued_at CHECK, redemption is pinned inside the
-- token's actual lifetime and a future-dated forgery is refused.
CREATE TRIGGER login_tokens_consumed_within_life
BEFORE UPDATE ON login_tokens
WHEN NEW.consumed_at IS NOT NULL AND NEW.consumed_at > NEW.expires_at
BEGIN
  SELECT RAISE(ABORT, 'login_tokens: consumed_at cannot be after expires_at');
END;

-- =============================================================================
-- 3. Timestamps are compared as strings, so their format is load-bearing.
--
-- consumeLoginToken does `expires_at > ?` against an ISO string. That compare
-- is lexicographic, and nothing pinned the format: a row written with an
-- offset-form timestamp ('2026-03-01T14:00:00+02:00') was honoured for two
-- hours past its real expiry. Unreachable today because issueLoginToken is the
-- only writer and always uses toISOString(); reachable the moment an import,
-- a fixture, or a second writer appears.
-- =============================================================================
CREATE TRIGGER login_tokens_iso_timestamps
BEFORE INSERT ON login_tokens
WHEN NEW.issued_at  NOT LIKE '____-__-__T__:__:__.___Z'
  OR NEW.expires_at NOT LIKE '____-__-__T__:__:__.___Z'
BEGIN
  SELECT RAISE(ABORT, 'login_tokens: timestamps must be ISO-8601 UTC with milliseconds');
END;
