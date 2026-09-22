-- A form field may not be named after an internal-only column.
--
-- WHY THIS EXISTS. src/lib/scope.ts has carried assertNoInternalFields since
-- Phase 1: a recursive guard that refuses to send a payload containing any of
-- INTERNAL_ONLY_COLUMNS to an external user. It was thoroughly tested and
-- never once called in production. Wiring it into the dispatch for every
-- applicant-authed route is the point of the change this migration
-- accompanies.
--
-- That guard inspects KEYS, and one external payload is keyed by data rather
-- than by code: the applicant's answers, keyed by form_fields.field_key. So a
-- program whose form asked a question with field_key 'comment' or
-- 'decided_at' would make the guard fire on a legitimate payload -- and it
-- fails closed, which means a nonprofit gets a 500 in the middle of a form
-- they have spent an hour on.
--
-- The right place to refuse that collision is when an admin builds the form,
-- not when an applicant submits it. SQLite cannot ALTER a CHECK onto an
-- existing table, so this is a trigger, the same way 0003 makes published
-- definitions immutable and 0024 makes an amount change require an amendment.
--
-- The list is INTERNAL_ONLY_COLUMNS, copied deliberately rather than derived:
-- there is no way to derive it in SQL, and a test asserts the two agree so
-- they cannot drift apart silently.

CREATE TRIGGER form_fields_may_not_use_an_internal_column_name
BEFORE INSERT ON form_fields
WHEN NEW.field_key IN (
  'internal_notes','decision_notes','decided_by','decided_at',
  'decision_communicated_at','decision_communicated_by','decision_communicated_via',
  'submission_ip','submission_user_agent','score','comment','reviewer_user_id',
  'conflict_note','admin_feedback','deleted_reason'
)
BEGIN
  SELECT RAISE(ABORT, 'that field key is reserved: it names a column an applicant must never see');
END;

CREATE TRIGGER form_fields_may_not_be_renamed_to_an_internal_column_name
BEFORE UPDATE OF field_key ON form_fields
WHEN NEW.field_key IN (
  'internal_notes','decision_notes','decided_by','decided_at',
  'decision_communicated_at','decision_communicated_by','decision_communicated_via',
  'submission_ip','submission_user_agent','score','comment','reviewer_user_id',
  'conflict_note','admin_feedback','deleted_reason'
)
BEGIN
  SELECT RAISE(ABORT, 'that field key is reserved: it names a column an applicant must never see');
END;
