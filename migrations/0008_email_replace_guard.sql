-- 0008_email_replace_guard.sql
--
-- Fixes a real hole in 0007, found by adversarial review before anything had
-- been sent.
--
-- 0007's email_messages_no_replace guarded the PRIMARY KEY conflict path only:
--
--     WHEN EXISTS (SELECT 1 FROM email_messages WHERE id = NEW.id)
--
-- But idempotency_key is a SECOND unique index. An INSERT OR REPLACE colliding
-- on that index resolves by DELETING the owning row, and SQLite does not fire
-- BEFORE DELETE triggers for a REPLACE-driven delete (recursive_triggers is off
-- on D1). The row's id never equals NEW.id, so the no_replace guard did not
-- match either. One statement therefore hard-deleted a settled send record,
-- freed its idempotency key for reuse, and raised no error -- against a table
-- whose entire purpose is to be the durable answer to "did we email them".
--
-- That is CLAUDE.md non-negotiable #7 (nothing is hard-deleted), and the
-- comment in 0007 shows the hole was known and then guarded halfway.
--
-- Fixed here rather than by editing 0007 because this session cannot verify
-- whether 0007 has already been applied to preview, and editing an applied
-- migration is forbidden. DROP + CREATE is correct either way.

DROP TRIGGER email_messages_no_replace;

-- Split into two triggers with DISTINCT messages, because they are caught
-- differently. A BEFORE INSERT trigger fires before SQLite resolves any
-- conflict, so an idempotency_key guard here also pre-empts
-- `ON CONFLICT (idempotency_key) DO NOTHING`. That is not a defect to work
-- around: it makes the trigger the single point at which "this key is taken"
-- is decided, for REPLACE and for a plain INSERT alike. lib/email.ts catches
-- the second message by name and treats it as a deduplicated send.

CREATE TRIGGER email_messages_no_replace BEFORE INSERT ON email_messages
WHEN EXISTS (SELECT 1 FROM email_messages WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'email_messages is append-only: an existing row cannot be replaced');
END;

CREATE TRIGGER email_messages_key_claimed BEFORE INSERT ON email_messages
WHEN EXISTS (SELECT 1 FROM email_messages WHERE idempotency_key = NEW.idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'email_messages: idempotency_key is already claimed');
END;

-- While a message is still 'queued' its identity fields were freely mutable:
-- the terminal-status trigger only engages once status <> 'queued'. "Who was
-- this addressed to" and "who released it" are exactly the facts an audit
-- record must not be able to lose, so freeze them from the moment the row
-- exists rather than from the moment it settles.
--
-- settle() only ever writes status, provider_message_id, error_code,
-- error_message, sent_at and updated_at, so it is unaffected.
CREATE TRIGGER email_messages_identity_frozen BEFORE UPDATE ON email_messages
WHEN NEW.to_email            <> OLD.to_email
  OR NEW.template_key        <> OLD.template_key
  OR NEW.subject             <> OLD.subject
  OR COALESCE(NEW.released_by_user_id, '') <> COALESCE(OLD.released_by_user_id, '')
BEGIN
  SELECT RAISE(ABORT, 'email_messages: recipient, template, subject and releaser are frozen');
END;
