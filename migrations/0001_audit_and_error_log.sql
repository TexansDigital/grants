-- 0001_audit_and_error_log.sql
--
-- Audit and error logging come FIRST, before any business table exists, so that
-- nothing can be built on top of this schema without them being available.
--
-- Both tables are append-only, enforced by triggers rather than by convention.
-- These are financial records. A row that can be quietly updated is not an
-- audit trail.

-- =============================================================================
-- audit_log — every status, score, decision, award, and payment write.
-- =============================================================================
CREATE TABLE audit_log (
  id                      TEXT PRIMARY KEY,

  -- Who. actor_user_id is NULL only for genuinely unauthenticated events
  -- (a public form submission before an account exists); actor_kind says which.
  actor_user_id           TEXT,
  actor_kind              TEXT NOT NULL DEFAULT 'user'
                            CHECK (actor_kind IN ('user','anonymous','system','import')),
  actor_role              TEXT,
  actor_organization_id   TEXT,

  -- What. action is a stable verb, e.g. 'application.submitted'.
  action                  TEXT NOT NULL,
  entity_type             TEXT NOT NULL,
  entity_id               TEXT NOT NULL,

  -- Before/after state as JSON. Both NULL is only valid for pure read events,
  -- which we do not log; a mutating action must record at least an after state.
  before_json             TEXT,
  after_json              TEXT,
  changed_fields_json     TEXT,

  -- Request correlation. request_id ties an audit row to the error_log rows
  -- and the log line produced by the same request.
  request_id              TEXT,
  ip                      TEXT,
  user_agent              TEXT,

  created_at              TEXT NOT NULL,

  CHECK (json_valid(COALESCE(before_json, 'null'))),
  CHECK (json_valid(COALESCE(after_json, 'null'))),
  CHECK (json_valid(COALESCE(changed_fields_json, 'null')))
);

CREATE INDEX audit_log_entity_idx   ON audit_log (entity_type, entity_id, created_at);
CREATE INDEX audit_log_actor_idx    ON audit_log (actor_user_id, created_at);
CREATE INDEX audit_log_action_idx   ON audit_log (action, created_at);
CREATE INDEX audit_log_request_idx  ON audit_log (request_id);

-- Append-only, enforced by the database.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: rows cannot be updated');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: rows cannot be deleted');
END;

-- INSERT OR REPLACE is the third statement form, and the one that slips past a
-- naive append-only guard: SQLite's REPLACE conflict resolution deletes the
-- conflicting row WITHOUT firing BEFORE DELETE triggers unless
-- PRAGMA recursive_triggers is on, which it is not on D1. A BEFORE INSERT
-- trigger does fire, so this is where a rewrite-by-replace is caught.
CREATE TRIGGER audit_log_no_replace BEFORE INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: an existing row cannot be replaced');
END;

-- =============================================================================
-- error_log — every handled and unhandled failure.
--
-- Written by the Worker's error boundary. Context is redacted before it lands
-- here: no secrets, no tokens, no authorization headers, no raw request bodies.
-- =============================================================================
CREATE TABLE error_log (
  id                      TEXT PRIMARY KEY,
  request_id              TEXT,

  severity                TEXT NOT NULL CHECK (severity IN ('warn','error','fatal')),
  -- Stable machine code, e.g. 'VALIDATION_FAILED', 'NOT_FOUND', 'INTERNAL'.
  code                    TEXT NOT NULL,
  -- Internal message. May be detailed. Never returned to a client for 5xx.
  message                 TEXT NOT NULL,
  -- Redacted, size-capped structured context.
  context_json            TEXT,
  stack                   TEXT,

  actor_user_id           TEXT,
  actor_role              TEXT,
  actor_organization_id   TEXT,

  route                   TEXT,
  method                  TEXT,
  http_status             INTEGER,
  ip                      TEXT,
  user_agent              TEXT,

  created_at              TEXT NOT NULL,

  CHECK (json_valid(COALESCE(context_json, 'null')))
);

CREATE INDEX error_log_created_idx  ON error_log (created_at);
CREATE INDEX error_log_code_idx     ON error_log (code, created_at);
CREATE INDEX error_log_request_idx  ON error_log (request_id);
CREATE INDEX error_log_severity_idx ON error_log (severity, created_at);

CREATE TRIGGER error_log_no_update BEFORE UPDATE ON error_log
BEGIN
  SELECT RAISE(ABORT, 'error_log is append-only: rows cannot be updated');
END;

CREATE TRIGGER error_log_no_delete BEFORE DELETE ON error_log
BEGIN
  SELECT RAISE(ABORT, 'error_log is append-only: rows cannot be deleted');
END;

-- Same REPLACE hole as audit_log. See the note above.
CREATE TRIGGER error_log_no_replace BEFORE INSERT ON error_log
WHEN EXISTS (SELECT 1 FROM error_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'error_log is append-only: an existing row cannot be replaced');
END;
