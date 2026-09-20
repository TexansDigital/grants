-- 0015_review_blinding.sql
--
-- Three columns that are cheap now and near-impossible to retrofit once
-- reviewers have started scoring.
--
-- WHERE THESE COME FROM. A survey of how established grantmaking platforms
-- handle review found two conventions this schema could not express, and one
-- tension it could not record a decision about. All three are additive; nothing
-- below changes an existing row's meaning.
--
--
-- 1. coi_attested_at — CONFLICT OF INTEREST IS TWO EVENTS, NOT ONE.
--
-- 0006 records a declaration at assignment: conflict_note, conflict_declared_at,
-- recused_at, recused_reason. That is the right half of the pattern and it is
-- the half everyone builds.
--
-- The other half is an attestation when the score is SUBMITTED, that no
-- conflict arose during the review. Funders that take this seriously run both —
-- a pre-review declaration and a post-review certification the reviewer signs
-- afterwards. Without it there is a gap exactly where an auditor looks: a
-- reviewer who joined a grantee's board in the six weeks between assignment and
-- scoring has declared nothing, and the record cannot tell the difference
-- between "no conflict" and "never asked again".
--
-- Nullable, because assignments made before this migration were never asked.
-- A NULL means unasked, not "attested nothing" — those must not look alike.
--
--
-- 2. conceal_in_review — BLINDING IS PER FIELD, NOT PER RECORD.
--
-- Anonymised review, where platforms offer it, marks individual questions as
-- concealed and renders them blank or as a placeholder to reviewers. Not a
-- whole-application toggle: the organization's name, its budget and its
-- leadership biographies are the identifying answers, and the narrative that
-- the rubric actually scores is not.
--
-- On form_fields rather than on a separate table because it is a property of
-- the question — "this question identifies the applicant" is decided once when
-- the form is written, by the person writing it, not per cycle by whoever runs
-- the review.
--
-- DEFAULT 0. Nothing becomes concealed by this migration; a form has to say so.
--
--
-- 3. cycles.blind_review — THE TENSION, RECORDED RATHER THAN RESOLVED.
--
-- CLAUDE.md asks for two things that are in direct conflict:
--
--   "Applicant history at the point of review. When a reviewer opens an
--    application, show that this org has applied three times, was funded once
--    for $25,000, filed both reports on time"
--
--   "Consider anonymized narrative review as a program option."
--
-- You cannot show a reviewer an organization's funding history and call the
-- review blind. The evidence on blinding is also mixed: it does advance
-- proposals from less prestigious institutions more often, and a field study
-- still found the same directional bias under double-blind conditions, while
-- the named cost for grantmaking specifically is losing the link between an
-- applicant's track record and their ability to deliver.
--
-- So this is a per-cycle choice a human makes with the tradeoff in front of
-- them, not a default either way. 0 is the current behaviour: history shown,
-- nothing concealed.
--
-- One column, not two: when blind_review is on, concealed fields are hidden AND
-- the history panel is withheld. Two switches would let somebody turn on
-- "blind" and still show the history, which is the failure this is meant to
-- prevent.

ALTER TABLE review_assignments ADD COLUMN coi_attested_at TEXT;

ALTER TABLE form_fields
  ADD COLUMN conceal_in_review INTEGER NOT NULL DEFAULT 0
  CHECK (conceal_in_review IN (0, 1));

ALTER TABLE cycles
  ADD COLUMN blind_review INTEGER NOT NULL DEFAULT 0
  CHECK (blind_review IN (0, 1));

-- The reviewer worklist reads "my assignments, not recused, in this cycle" on
-- every page load. Partial so it indexes only rows that are actually in play.
CREATE INDEX review_assignments_reviewer_open_idx
  ON review_assignments (reviewer_user_id, application_id)
  WHERE recused_at IS NULL AND deleted_at IS NULL;

-- The admin coverage grid asks the same question from the other side: how many
-- live reviewers does each application have.
CREATE INDEX review_assignments_application_open_idx
  ON review_assignments (application_id)
  WHERE recused_at IS NULL AND deleted_at IS NULL;
