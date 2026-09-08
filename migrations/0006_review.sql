-- 0006_review.sql
--
-- Rubrics, criteria, review assignments and scores.
--
-- Written ahead of the review UI for one reason: getApplicationForStaff already
-- has a reviewer branch that fails closed because review_assignments does not
-- exist (src/lib/scope.ts). A reviewer session currently 404s on every
-- application in the system. This is the table that turns that branch on.
--
-- Deliberately NOT in this migration: awards, amendments, payments, report
-- periods, report submissions, metric definitions, metric values. Four of the
-- design decisions those tables encode are on CLAUDE.md's open list and are
-- unanswered, and a migration cannot be edited once applied. They land in 0007
-- and 0008, immediately before the phases that build against them.
--
-- Conventions are 0002's: TEXT ids, UTC ISO-8601 timestamps, integer scores
-- guarded by typeof(), soft-delete, partial unique indexes over live rows.

-- =============================================================================
-- rubrics
--
-- Versioned per cycle. `source_file_r2_key` points at the CSV or XLSX an admin
-- uploaded, kept so a score can always be traced back to the document a human
-- actually approved -- the parse is a convenience, the upload is the record.
--
-- max_total_score is stored rather than derived. A rubric whose criteria are
-- edited after scoring has begun would otherwise silently restate every score
-- that was already recorded against it. The trigger below makes a published
-- rubric immutable instead, and this column is the cross-check.
-- =============================================================================
CREATE TABLE rubrics (
  id                    TEXT PRIMARY KEY,
  program_id            TEXT NOT NULL REFERENCES programs(id),
  name                  TEXT NOT NULL,
  rubric_key            TEXT NOT NULL,
  version               INTEGER NOT NULL
                          CHECK (typeof(version) = 'integer' AND version >= 1),
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','published','retired')),
  -- Sum of criterion max_score * weight, computed at publish and frozen.
  max_total_score       INTEGER
                          CHECK (max_total_score IS NULL OR
                                 (typeof(max_total_score) = 'integer' AND max_total_score > 0)),
  source_file_r2_key    TEXT,
  source_filename       TEXT,
  published_at          TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,

  CHECK ((status = 'published') <= (published_at IS NOT NULL)),
  CHECK ((status = 'published') <= (max_total_score IS NOT NULL))
);

CREATE UNIQUE INDEX rubrics_version_uniq
  ON rubrics (program_id, rubric_key, version) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX rubrics_published_uniq
  ON rubrics (program_id, rubric_key)
  WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX rubrics_program_idx ON rubrics (program_id, status);

-- Publication is one way, matching form_definitions. A published rubric that
-- could return to draft is a rubric whose criteria can be edited under scores
-- already recorded against it.
CREATE TRIGGER rubrics_publication_is_one_way
BEFORE UPDATE OF status ON rubrics
WHEN OLD.status IN ('published','retired') AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'a published or retired rubric cannot return to draft');
END;

CREATE TRIGGER rubrics_retired_stays_retired
BEFORE UPDATE OF status ON rubrics
WHEN OLD.status = 'retired' AND NEW.status <> 'retired'
BEGIN
  SELECT RAISE(ABORT, 'a retired rubric cannot be un-retired');
END;

-- =============================================================================
-- rubric_criteria
--
-- weight is INTEGER BASIS POINTS, not a float. Same reasoning as money: a
-- rubric with weights 0.15 / 0.35 / 0.5 stored as REAL does not sum to 1
-- exactly, and "why does this application total 87.99999" is not a conversation
-- to have with a review committee. 1500 + 3500 + 5000 = 10000, exactly.
--
-- Weights are NOT required to sum to 10000. Some rubrics are unweighted (every
-- criterion 10000/n is silly) and some are deliberately over- or under-
-- weighted. The parser reports the sum; an admin confirms it. Enforcing it here
-- would reject real uploaded rubrics.
-- =============================================================================
CREATE TABLE rubric_criteria (
  id            TEXT PRIMARY KEY,
  rubric_id     TEXT NOT NULL REFERENCES rubrics(id),
  criterion_key TEXT NOT NULL,
  label         TEXT NOT NULL,
  description   TEXT,
  weight_bp     INTEGER NOT NULL DEFAULT 10000
                  CHECK (typeof(weight_bp) = 'integer' AND weight_bp >= 0),
  max_score     INTEGER NOT NULL
                  CHECK (typeof(max_score) = 'integer' AND max_score > 0),
  sort_order    INTEGER NOT NULL DEFAULT 0
                  CHECK (typeof(sort_order) = 'integer'),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE UNIQUE INDEX rubric_criteria_key_uniq
  ON rubric_criteria (rubric_id, criterion_key) WHERE deleted_at IS NULL;
CREATE INDEX rubric_criteria_rubric_idx ON rubric_criteria (rubric_id, sort_order);

-- A published rubric's criteria are frozen. Checked on BOTH sides, because a
-- criterion moved OUT of a published rubric is the same defect as one moved in
-- -- the form-engine immutability triggers learned this the hard way.
CREATE TRIGGER rubric_criteria_no_insert_into_published
BEFORE INSERT ON rubric_criteria
WHEN (SELECT status FROM rubrics WHERE id = NEW.rubric_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'cannot add a criterion to a rubric that is not draft');
END;

CREATE TRIGGER rubric_criteria_no_update_in_published
BEFORE UPDATE ON rubric_criteria
WHEN (SELECT status FROM rubrics WHERE id = OLD.rubric_id) <> 'draft'
   OR (SELECT status FROM rubrics WHERE id = NEW.rubric_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'cannot change a criterion of a rubric that is not draft');
END;

CREATE TRIGGER rubric_criteria_no_delete_from_published
BEFORE DELETE ON rubric_criteria
WHEN (SELECT status FROM rubrics WHERE id = OLD.rubric_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'cannot remove a criterion from a rubric that is not draft');
END;

-- =============================================================================
-- cycles.rubric_id — the dangling column from 0002, now given integrity.
--
-- Enforced by trigger rather than by a foreign key. SQLite cannot add a
-- constraint to an existing table, and the alternative -- rebuilding `cycles` --
-- means dropping a table that `applications` already references. A trigger pair
-- is the same guarantee at this scale and does not put a live foreign key at
-- risk to gain a declarative one.
-- =============================================================================
CREATE TRIGGER cycles_rubric_exists_insert
BEFORE INSERT ON cycles
WHEN NEW.rubric_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM rubrics WHERE id = NEW.rubric_id AND deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'cycle rubric_id does not reference a live rubric');
END;

CREATE TRIGGER cycles_rubric_exists_update
BEFORE UPDATE OF rubric_id ON cycles
WHEN NEW.rubric_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM rubrics WHERE id = NEW.rubric_id AND deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'cycle rubric_id does not reference a live rubric');
END;

-- A cycle's rubric must belong to the cycle's own program. Without this, a
-- copy-pasted id scores one program's applications against another's criteria.
CREATE TRIGGER cycles_rubric_same_program_insert
BEFORE INSERT ON cycles
WHEN NEW.rubric_id IS NOT NULL
 AND (SELECT program_id FROM rubrics WHERE id = NEW.rubric_id) <> NEW.program_id
BEGIN
  SELECT RAISE(ABORT, 'cycle rubric must belong to the same program as the cycle');
END;

CREATE TRIGGER cycles_rubric_same_program_update
BEFORE UPDATE OF rubric_id, program_id ON cycles
WHEN NEW.rubric_id IS NOT NULL
 AND (SELECT program_id FROM rubrics WHERE id = NEW.rubric_id) <> NEW.program_id
BEGIN
  SELECT RAISE(ABORT, 'cycle rubric must belong to the same program as the cycle');
END;

-- =============================================================================
-- review_assignments
--
-- The access-control row. scope.ts reads this and nothing else to decide what a
-- reviewer may see, so its shape is a security boundary, not bookkeeping.
--
-- Conflict of interest is declared HERE, at assignment, not on the score. That
-- is CLAUDE.md's rule and it is the right one: a conflict discovered while
-- scoring has already contaminated the score. `recused_at` is what scope.ts
-- filters on -- a recusal removes access immediately, without deleting the
-- record of who was assigned and why they stepped back.
--
-- There is no `conflict_declared` boolean. A note with no flag and a flag with
-- no note are both states the data should not be able to represent; the note's
-- presence IS the declaration.
-- =============================================================================
CREATE TABLE review_assignments (
  id                TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id),
  reviewer_user_id  TEXT NOT NULL REFERENCES users(id),
  assigned_at       TEXT NOT NULL,
  assigned_by       TEXT REFERENCES users(id),
  conflict_note     TEXT,
  conflict_declared_at TEXT,
  recused_at        TEXT,
  recused_reason    TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,

  -- A declaration is a note plus a time, or neither.
  CHECK ((conflict_note IS NOT NULL) = (conflict_declared_at IS NOT NULL)),
  -- A recusal always carries a reason. "Recused" with no reason is a gap in the
  -- audit trail exactly where an auditor will look.
  CHECK ((recused_at IS NOT NULL) <= (recused_reason IS NOT NULL))
);

-- One live assignment per reviewer per application. A second one would make
-- "this reviewer's score" ambiguous.
CREATE UNIQUE INDEX review_assignments_uniq
  ON review_assignments (application_id, reviewer_user_id) WHERE deleted_at IS NULL;
-- The index scope.ts's reviewer query rides on.
CREATE INDEX review_assignments_reviewer_idx
  ON review_assignments (reviewer_user_id, recused_at) WHERE deleted_at IS NULL;
CREATE INDEX review_assignments_application_idx
  ON review_assignments (application_id) WHERE deleted_at IS NULL;

-- Only a reviewer or an admin can be assigned to review. An applicant with an
-- assignment row would see another organization's application, which is the
-- worst outcome this schema can produce.
CREATE TRIGGER review_assignments_reviewer_is_staff_insert
BEFORE INSERT ON review_assignments
WHEN (SELECT role FROM users WHERE id = NEW.reviewer_user_id) NOT IN ('reviewer','admin')
BEGIN
  SELECT RAISE(ABORT, 'only a reviewer or admin can be assigned to review');
END;

CREATE TRIGGER review_assignments_reviewer_is_staff_update
BEFORE UPDATE OF reviewer_user_id ON review_assignments
WHEN (SELECT role FROM users WHERE id = NEW.reviewer_user_id) NOT IN ('reviewer','admin')
BEGIN
  SELECT RAISE(ABORT, 'only a reviewer or admin can be assigned to review');
END;

-- Recusal is one way. Un-recusing would restore access to an application
-- someone has already declared a conflict on.
CREATE TRIGGER review_assignments_recusal_is_one_way
BEFORE UPDATE OF recused_at ON review_assignments
WHEN OLD.recused_at IS NOT NULL AND NEW.recused_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a recusal cannot be withdrawn; assign a new reviewer instead');
END;

-- =============================================================================
-- review_scores
--
-- score is INTEGER and bounded by its criterion's max_score. Half marks are a
-- rubric design choice, expressed by giving the criterion a larger max_score
-- (0-10 rather than 0-5), not by storing a float here.
--
-- The weighted total is NOT stored. It is criterion weight times score summed,
-- and a stored copy is a number that can disagree with its inputs. At 100-400
-- applications a year, computing it on read costs nothing.
-- =============================================================================
CREATE TABLE review_scores (
  id                    TEXT PRIMARY KEY,
  review_assignment_id  TEXT NOT NULL REFERENCES review_assignments(id),
  rubric_criterion_id   TEXT NOT NULL REFERENCES rubric_criteria(id),
  score                 INTEGER NOT NULL
                          CHECK (typeof(score) = 'integer' AND score >= 0),
  comment               TEXT,
  scored_at             TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT
);

CREATE UNIQUE INDEX review_scores_uniq
  ON review_scores (review_assignment_id, rubric_criterion_id) WHERE deleted_at IS NULL;
CREATE INDEX review_scores_assignment_idx
  ON review_scores (review_assignment_id) WHERE deleted_at IS NULL;

-- A score above its criterion's ceiling is a data error that would quietly
-- distort a ranking. Checked in the database because the ranking is what the
-- funding decision is made from.
CREATE TRIGGER review_scores_within_max_insert
BEFORE INSERT ON review_scores
WHEN NEW.score > (SELECT max_score FROM rubric_criteria WHERE id = NEW.rubric_criterion_id)
BEGIN
  SELECT RAISE(ABORT, 'score exceeds the maximum for this criterion');
END;

CREATE TRIGGER review_scores_within_max_update
BEFORE UPDATE OF score, rubric_criterion_id ON review_scores
WHEN NEW.score > (SELECT max_score FROM rubric_criteria WHERE id = NEW.rubric_criterion_id)
BEGIN
  SELECT RAISE(ABORT, 'score exceeds the maximum for this criterion');
END;

-- A score must be against a criterion of the rubric attached to the cycle the
-- application is in. Without this, an assignment can be scored against another
-- program's rubric entirely and the totals are meaningless.
CREATE TRIGGER review_scores_criterion_matches_cycle_rubric
BEFORE INSERT ON review_scores
WHEN (SELECT rubric_id FROM rubric_criteria WHERE id = NEW.rubric_criterion_id)
     IS NOT (
       SELECT c.rubric_id
         FROM review_assignments ra
         JOIN applications a ON a.id = ra.application_id
         JOIN cycles c ON c.id = a.cycle_id
        WHERE ra.id = NEW.review_assignment_id
     )
BEGIN
  SELECT RAISE(ABORT, 'score criterion does not belong to the rubric for this application''s cycle');
END;

-- A recused reviewer's scores stop accumulating. The scores already recorded
-- stay -- they are part of the record of what happened -- but nothing new is
-- added under a declared conflict.
CREATE TRIGGER review_scores_no_scoring_after_recusal
BEFORE INSERT ON review_scores
WHEN (SELECT recused_at FROM review_assignments WHERE id = NEW.review_assignment_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a recused assignment cannot record new scores');
END;
