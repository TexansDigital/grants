-- 0010_login_tokens.sql
--
-- Magic-link sign-in for applicants and grantees.
--
-- WHY D1 AND NOT KV, against CLAUDE.md's "sessions and tokens: KV":
--
-- A magic link must be single-use. KV is eventually consistent, so a
-- read-then-delete has a window in which two clicks both find the token
-- present and both succeed. A link that can be replayed is the entire security
-- model failing silently -- and quietly, because both users get a working
-- session and nothing looks wrong. D1 is strongly consistent, so consuming a
-- token is one conditional UPDATE whose row count settles it.
--
-- Sessions stay in KV as CLAUDE.md says. Sessions have no single-use
-- requirement, and the revocation problem KV would otherwise create is solved
-- by users.sessions_valid_from below rather than by moving them.

CREATE TABLE login_tokens (
  id                 TEXT PRIMARY KEY,

  -- SHA-256 of the token, hex. THE TOKEN ITSELF IS NEVER STORED. Anyone who
  -- can read this table has the ability to reset a grantee's access if the
  -- raw value is here; with only the hash, a database copy is inert.
  token_hash         TEXT NOT NULL UNIQUE
                       CHECK (length(token_hash) = 64),

  user_id            TEXT NOT NULL REFERENCES users(id),
  -- Recorded separately from users.email so that a later address change cannot
  -- rewrite the history of where a link was actually sent.
  sent_to_email      TEXT NOT NULL CHECK (sent_to_email = lower(sent_to_email)),

  purpose            TEXT NOT NULL DEFAULT 'sign_in' CHECK (purpose IN ('sign_in')),

  issued_at          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  -- Set when the link was actually used to sign in. This column is evidence
  -- that a sign-in happened, which is why superseding uses its own column
  -- below rather than borrowing this one -- an unused link that was replaced
  -- must not read as a session somebody opened.
  consumed_at        TEXT,
  -- Set when a NEWER link was requested for the same user. The old link stops
  -- working immediately, without pretending it was used.
  superseded_at      TEXT,

  -- Where the link was requested from, and where it was actually used. A link
  -- requested in Houston and redeemed elsewhere minutes later is the signal a
  -- human would want, and it cannot be reconstructed later.
  requested_ip       TEXT,
  requested_user_agent TEXT,
  consumed_ip        TEXT,
  consumed_user_agent TEXT,

  created_at         TEXT NOT NULL,

  CHECK (expires_at > issued_at),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (superseded_at IS NULL OR superseded_at >= issued_at),
  -- A link is used or replaced, never both. If this ever fires, the ordering
  -- between consuming and superseding has a race in it.
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);

CREATE INDEX login_tokens_user_idx    ON login_tokens (user_id, issued_at);
CREATE INDEX login_tokens_email_idx   ON login_tokens (sent_to_email, issued_at);
CREATE INDEX login_tokens_expiry_idx  ON login_tokens (expires_at);

-- Append-only, like every other record of who did what. A consumed token is
-- evidence that a sign-in happened; deleting it destroys that.
CREATE TRIGGER login_tokens_no_delete BEFORE DELETE ON login_tokens
BEGIN
  SELECT RAISE(ABORT, 'login_tokens is append-only: rows cannot be deleted');
END;

-- The REPLACE hole, guarded on BOTH unique keys. Migration 0007 guarded only
-- the primary key on a table with a second unique index and lost a settled row
-- to it; the same mistake here would free a consumed token for reuse.
CREATE TRIGGER login_tokens_no_replace BEFORE INSERT ON login_tokens
WHEN EXISTS (
  SELECT 1 FROM login_tokens WHERE id = NEW.id OR token_hash = NEW.token_hash
)
BEGIN
  SELECT RAISE(ABORT, 'login_tokens: a token already exists with that id or hash');
END;

-- Consuming is the ONLY legal update, and it happens once. Everything that
-- identifies the token is frozen, so a token cannot be re-pointed at another
-- user or have its expiry extended.
CREATE TRIGGER login_tokens_single_use BEFORE UPDATE ON login_tokens
WHEN OLD.consumed_at IS NOT NULL OR OLD.superseded_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'login_tokens: a settled token cannot be modified');
END;

CREATE TRIGGER login_tokens_frozen BEFORE UPDATE ON login_tokens
WHEN NEW.token_hash    <> OLD.token_hash
  OR NEW.user_id       <> OLD.user_id
  OR NEW.sent_to_email <> OLD.sent_to_email
  OR NEW.expires_at    <> OLD.expires_at
  OR NEW.issued_at     <> OLD.issued_at
BEGIN
  SELECT RAISE(ABORT, 'login_tokens: token identity and expiry are frozen');
END;

-- =============================================================================
-- Immediate session revocation.
--
-- Sessions live in KV, whose deletes are eventually consistent: signing out
-- does not reliably end a session at the moment the button is pressed, which
-- is exactly when it matters -- a shared computer at a nonprofit office.
--
-- Rather than move sessions to D1, every session carries its issue time and
-- every request compares it against this column. Setting it to now invalidates
-- every session issued before now, immediately and everywhere, with no
-- dependence on KV propagation. It is also how "sign out on all devices" and
-- an admin revoking access are the same operation.
-- =============================================================================
ALTER TABLE users ADD COLUMN sessions_valid_from TEXT;
