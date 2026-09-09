-- 0007_email.sql
--
-- Outbound email.
--
-- Every send this system attempts leaves a row here, whether it succeeded,
-- failed, or was deliberately suppressed. A grantee who cannot receive a login
-- link cannot file a report, and "we think we emailed them" is not an answer.
-- This table is how that question gets answered.
--
-- WHAT IS DELIBERATELY NOT STORED: the rendered body.
--
-- The first template this system sends is a sign-in link, and its body contains
-- a live credential. Storing rendered bodies would put working magic links in
-- the database, readable by anything that can read the database, for as long as
-- the row survives -- and would keep them long after the 15-minute token
-- expiry that is supposed to bound the risk. So a row records WHICH template
-- went to WHICH address and what happened, and nothing that could be replayed.
-- If a body ever needs reconstructing, the template plus a redacted context is
-- enough for a human to see what the recipient was told.

CREATE TABLE email_messages (
  id                      TEXT PRIMARY KEY,

  -- The dedupe boundary, supplied by the caller. Two attempts sharing a key are
  -- the same message: a retried request, a double-clicked button, a replayed
  -- queue item. UNIQUE is what makes "send once" a database guarantee rather
  -- than a hope about how many times a handler runs.
  idempotency_key         TEXT NOT NULL UNIQUE,

  template_key            TEXT NOT NULL,
  to_email                TEXT NOT NULL,
  -- Kept because it is the one part of the body that is safe to keep and is
  -- what a human needs to answer "what did we send them".
  subject                 TEXT NOT NULL,

  --   queued     - row written, provider not yet called
  --   sent       - provider accepted it. NOT proof of delivery
  --   failed     - provider rejected it, or the call never completed
  --   suppressed - deliberately not sent (no API key configured, i.e. any
  --                environment that must never mail a real applicant)
  status                  TEXT NOT NULL
                            CHECK (status IN ('queued','sent','failed','suppressed')),

  provider                TEXT NOT NULL DEFAULT 'resend',
  provider_message_id     TEXT,

  error_code              TEXT,
  error_message           TEXT,

  -- A retry is a NEW row pointing at the attempt it replaces, never a rewrite
  -- of the old one. An attempts counter would have required updating a settled
  -- row, which means the first failure's diagnosis is overwritten by the
  -- second -- exactly the information you need when a grantee says they never
  -- got their link. This costs one row per attempt, at a volume of hundreds of
  -- emails a year.
  retry_of_message_id     TEXT REFERENCES email_messages(id),

  -- Set only for templates that may never send automatically. CLAUDE.md is
  -- explicit that decline emails are always human-reviewed before send; this
  -- column is where that review is recorded, and lib/email.ts refuses to send
  -- such a template without it.
  released_by_user_id     TEXT,

  -- Redacted entity linkage, e.g. {"application_id":"..."}. Never the body,
  -- never a token, never an answer.
  context_json            TEXT,

  request_id              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  sent_at                 TEXT,

  CHECK (json_valid(COALESCE(context_json, 'null'))),
  -- A sent message has a send time; nothing else does.
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  -- A failure says why. Without this a failed row can be written with no
  -- diagnosis, which is the exact case this table exists to prevent.
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK (retry_of_message_id IS NULL OR retry_of_message_id <> id)
);

CREATE INDEX email_messages_to_idx       ON email_messages (to_email, created_at);
CREATE INDEX email_messages_status_idx   ON email_messages (status, created_at);
CREATE INDEX email_messages_template_idx ON email_messages (template_key, created_at);
CREATE INDEX email_messages_request_idx  ON email_messages (request_id);
CREATE INDEX email_messages_retry_idx    ON email_messages (retry_of_message_id);

-- Nothing is hard-deleted. There is no soft-delete column either: this is an
-- operational log, and a "deleted" send record is not a concept.
CREATE TRIGGER email_messages_no_delete BEFORE DELETE ON email_messages
BEGIN
  SELECT RAISE(ABORT, 'email_messages is append-only: rows cannot be deleted');
END;

-- Same INSERT OR REPLACE hole guarded in 0001: REPLACE deletes the conflicting
-- row without firing BEFORE DELETE, so the guard has to sit on INSERT.
CREATE TRIGGER email_messages_no_replace BEFORE INSERT ON email_messages
WHEN EXISTS (SELECT 1 FROM email_messages WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'email_messages is append-only: an existing row cannot be replaced');
END;

-- A message goes queued -> (sent | failed | suppressed) and stops. Rewriting a
-- terminal row would let a later bug erase the evidence that something was
-- already delivered, which is the one fact this table must never lose.
CREATE TRIGGER email_messages_terminal BEFORE UPDATE ON email_messages
WHEN OLD.status <> 'queued'
BEGIN
  SELECT RAISE(ABORT, 'email_messages: a settled message cannot change status');
END;

-- The idempotency key identifies the message. Letting it change would silently
-- detach a row from the request that owns it and allow a second send.
CREATE TRIGGER email_messages_key_frozen BEFORE UPDATE ON email_messages
WHEN NEW.idempotency_key <> OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'email_messages: idempotency_key cannot change');
END;
