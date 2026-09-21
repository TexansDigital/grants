/**
 * A reviewer scoring an application.
 *
 * WHAT IS AT RISK. These are the least-privileged accounts in the system --
 * outside consultants hired for one cycle among them -- writing the input to a
 * funding decision. The failures that matter are not crashes:
 *
 *   - a reviewer reaching an assignment that is not theirs,
 *   - a reviewer seeing another reviewer's scores,
 *   - an unscored criterion counting as a zero,
 *   - a half-finished sheet dragging an application's average down,
 *   - a score entered after a conflict was disclosed.
 *
 * None of those throws. Each produces a number somebody acts on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { createRubric, replaceCriteria, publishRubric, attachRubricToCycle } from '../src/lib/rubrics';
import {
  loadScoringSheet, saveScores, completeReview, reopenReview, scoreSummary, formatScore,
} from '../src/lib/scoring';
import { assignReviewer, declareConflict, recuse } from '../src/lib/reviewAssign';
import { decideApplication } from '../src/lib/decisions';
import { assertNoInternalFields } from '../src/lib/scope';
import type { Session } from '../src/types';

let n = 0;
let admin: Session;

beforeEach(async () => {
  admin = adminSession(await user('admin'));
});

async function user(role: 'admin' | 'reviewer'): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?,?, NULL, 1, ?, ?)`,
    )
    .bind(id, `${role}-${crypto.randomUUID().slice(0, 8)}@example.org`, role, now, now)
    .run();
  return id;
}

const ctx = () => ctxFor(admin);

/** Three criteria: 10 at weight 3, 10 at weight 2, 5 at weight 1. Out of 55. */
const CRITERIA = [
  { criterionKey: 'community_need', label: 'Critical community need', weightBp: 30000, maxScore: 10 },
  { criterionKey: 'measurable_outcomes', label: 'Measurable outcomes', weightBp: 20000, maxScore: 10 },
  { criterionKey: 'capacity', label: 'Capacity to deliver', weightBp: 10000, maxScore: 5 },
];

async function scored() {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `sc-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;

  const { rubricId } = await createRubric(db, ctx(), admin, {
    programId: p.programId, name: 'Scoring', rubricKey: 'scoring',
  });
  await replaceCriteria(db, ctx(), admin, rubricId, CRITERIA);
  await publishRubric(db, ctx(), admin, rubricId);
  await attachRubricToCycle(db, ctx(), admin, cycleId, rubricId);

  const orgId = newId();
  const applicationId = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Collective ${n}`, String(950000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(applicationId, cycleId, orgId, now, now, now, p.formDefinitionIds.application!)
    .run();

  const reviewerId = await user('reviewer');
  // assignReviewer returns the ROW, so the id is `id`, not `assignmentId`.
  const assignment = await assignReviewer(db, ctx(), admin, applicationId, reviewerId);
  return {
    programId: p.programId, cycleId, applicationId, orgId, rubricId,
    reviewer: reviewerSession(reviewerId), assignmentId: assignment.id,
  };
}

const idsOf = async (assignmentId: string, session: Session) =>
  (await loadScoringSheet(db, session, assignmentId)).criteria.map((c) => c.id);

// ---------------------------------------------------------------------------

describe('who can reach a scoring sheet', () => {
  it('lets the assigned reviewer open it', async () => {
    const s = await scored();
    const sheet = await loadScoringSheet(db, s.reviewer, s.assignmentId);
    expect(sheet.criteria.length).toBe(3);
    expect(sheet.rubric.maxTotalScoreBp).toBe(550_000);
    expect(sheet.editable).toBe(true);
  });

  it('404s for a different reviewer', async () => {
    /*
     * THE BUG THIS PREVENTS. The route says roles: ['admin','reviewer'], which
     * admits every reviewer in the system. If the handler trusted that, any
     * consultant could read and overwrite anybody's scores by walking
     * assignment ids.
     */
    const s = await scored();
    const stranger = reviewerSession(await user('reviewer'));
    expect((await appErrorFrom(loadScoringSheet(db, stranger, s.assignmentId))).code)
      .toBe('NOT_FOUND');
    expect((await appErrorFrom(saveScores(db, ctx(), stranger, s.assignmentId, []))).code)
      .toBe('NOT_FOUND');
  });

  it('404s once the reviewer is recused', async () => {
    const s = await scored();
    await recuse(db, ctx(), admin, s.assignmentId, 'board member');
    expect((await appErrorFrom(loadScoringSheet(db, s.reviewer, s.assignmentId))).code)
      .toBe('NOT_FOUND');
  });

  it('lets an admin open any sheet, because recording a phoned-in scorecard is normal', async () => {
    const s = await scored();
    const sheet = await loadScoringSheet(db, admin, s.assignmentId);
    expect(sheet.assignmentId).toBe(s.assignmentId);
  });

  it('says so plainly when the cycle has no rubric', async () => {
    const s = await scored();
    await db.prepare(`UPDATE cycles SET rubric_id = NULL WHERE id = ?`).bind(s.cycleId).run();
    const err = await appErrorFrom(loadScoringSheet(db, s.reviewer, s.assignmentId));
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/no scoring rubric/i);
  });
});

describe('a reviewer never sees other reviewers scores', () => {
  it('returns only their own, even on the same application', async () => {
    /*
     * CLAUDE.md's access table is explicit. The enforcement is that no
     * reviewer-reachable query SELECTS another assignment's rows -- not a
     * filter in the UI, not a column dropped at serialization. A second
     * reviewer's scores are never fetched into this function's memory.
     */
    const s = await scored();
    const other = reviewerSession(await user('reviewer'));
    const second = await assignReviewer(db, ctx(), admin, s.applicationId, other.userId);

    const ids = await idsOf(s.assignmentId, s.reviewer);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [
      { criterionId: ids[0]!, score: 9, comment: 'strong' },
    ]);
    await saveScores(db, ctx(), other, second.id, [
      { criterionId: ids[0]!, score: 2, comment: 'weak' },
    ]);

    const mine = await loadScoringSheet(db, s.reviewer, s.assignmentId);
    expect(mine.criteria[0]!.score).toBe(9);
    expect(mine.criteria[0]!.comment).toBe('strong');
    expect(JSON.stringify(mine)).not.toContain('weak');

    const theirs = await loadScoringSheet(db, other, second.id);
    expect(theirs.criteria[0]!.score).toBe(2);
    expect(JSON.stringify(theirs)).not.toContain('strong');
  });

  it('refuses the side-by-side summary to a reviewer', async () => {
    const s = await scored();
    expect((await appErrorFrom(scoreSummary(db, s.reviewer, s.applicationId))).code)
      .toBe('NOT_FOUND');
  });
});

describe('saving', () => {
  it('totals SUM(score * weight_bp), exactly', async () => {
    // 9*30000 + 8*20000 + 4*10000 = 470000, i.e. 47 points out of 55.
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    const result = await saveScores(db, ctx(), s.reviewer, s.assignmentId, [
      { criterionId: ids[0]!, score: 9 },
      { criterionId: ids[1]!, score: 8 },
      { criterionId: ids[2]!, score: 4 },
    ]);
    expect(result.totalSoFarBp).toBe(470_000);
    expect(Number.isInteger(result.totalSoFarBp)).toBe(true);
    expect(formatScore(470_000)).toBe('47');
  });

  it('saves part of a sheet and keeps the rest unscored', async () => {
    // A reviewer reads a forty-field application over an hour. Requiring the
    // whole sheet at once means losing that hour to a closed laptop.
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[1]!, score: 7 }]);
    const sheet = await loadScoringSheet(db, s.reviewer, s.assignmentId);
    expect(sheet.criteria.map((c) => c.score)).toEqual([null, 7, null]);
    expect(sheet.totalSoFarBp).toBe(140_000);
  });

  it('treats null as CLEARED and not as zero', async () => {
    /*
     * THE BUG THIS PREVENTS. Zero is a judgement -- "this does nothing on this
     * criterion". Unscored is the absence of one. Collapse them and an
     * unfinished review passes the completeness check and carries scores
     * nobody gave into a weighted total.
     */
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 6 }]);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: null }]);
    const sheet = await loadScoringSheet(db, s.reviewer, s.assignmentId);
    expect(sheet.criteria[0]!.score).toBeNull();

    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 0 }]);
    expect((await loadScoringSheet(db, s.reviewer, s.assignmentId)).criteria[0]!.score).toBe(0);
  });

  it('updates in place rather than replacing the row', async () => {
    /*
     * INSERT OR REPLACE deletes and re-inserts: a new id, a lost created_at,
     * and the DELETE triggers fired. This schema has been bitten by it before
     * -- see regressions.test.ts, "append-only survives INSERT OR REPLACE".
     */
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 3 }]);
    const first = await db
      .prepare(
        `SELECT id, created_at FROM review_scores
          WHERE review_assignment_id = ? AND rubric_criterion_id = ? AND deleted_at IS NULL`,
      )
      .bind(s.assignmentId, ids[0]!)
      .first<{ id: string; created_at: string }>();

    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 8 }]);
    const after = await db
      .prepare(
        `SELECT id, created_at, score FROM review_scores
          WHERE review_assignment_id = ? AND rubric_criterion_id = ? AND deleted_at IS NULL`,
      )
      .bind(s.assignmentId, ids[0]!)
      .first<{ id: string; created_at: string; score: number }>();
    expect(after?.id).toBe(first?.id);
    expect(after?.created_at).toBe(first?.created_at);
    expect(after?.score).toBe(8);

    const rows = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_scores
          WHERE review_assignment_id = ? AND rubric_criterion_id = ?`,
      )
      .bind(s.assignmentId, ids[0]!)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('refuses a score above the criterion ceiling', async () => {
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    const err = await appErrorFrom(
      saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[2]!, score: 6 }]),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.publicMessage).toMatch(/between 0 and 5/);
  });

  it('refuses a fractional or negative score', async () => {
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    for (const bad of [7.5, -1]) {
      expect(
        (await appErrorFrom(
          saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: bad }]),
        )).code,
      ).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a criterion from another rubric', async () => {
    // 0006 refuses this at the database too. Refusing here reaches the
    // reviewer as a message rather than as an INTERNAL error from RAISE(ABORT).
    const s = await scored();
    const other = await scored();
    const foreign = (await idsOf(other.assignmentId, other.reviewer))[0]!;
    const err = await appErrorFrom(
      saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: foreign, score: 5 }]),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('writes an audit row naming the typist AND the reviewer', async () => {
    // Not always the same person: an admin may be recording a consultant's
    // scorecard, and the log should not say the consultant typed it.
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await saveScores(db, ctx(), admin, s.assignmentId, [{ criterionId: ids[0]!, score: 5 }]);
    const row = await db
      .prepare(
        `SELECT after_json FROM audit_log
          WHERE action = 'review.score_saved' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(s.assignmentId)
      .first<{ after_json: string }>();
    const after = JSON.parse(row!.after_json) as Record<string, string>;
    expect(after.actor_user_id).toBe(admin.userId);
    expect(after.reviewer_user_id).toBe(s.reviewer.userId);
  });
});

describe('a declared conflict stops scoring', () => {
  it('refuses a save after disclosure', async () => {
    /*
     * CLAUDE.md puts disclosure at assignment rather than at scoring because
     * "a conflict discovered while scoring has already contaminated the
     * score". The same reasoning applies afterwards: a score entered once a
     * reviewer has said there is a conflict is exactly what that rule exists
     * to prevent.
     */
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await declareConflict(db, ctx(), s.reviewer, s.assignmentId, 'I sit on their board');

    const err = await appErrorFrom(
      saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 9 }]),
    );
    expect(err.code).toBe('CONFLICT');
    const sheet = await loadScoringSheet(db, s.reviewer, s.assignmentId);
    expect(sheet.editable).toBe(false);
    expect(sheet.conflictDeclaredAt).not.toBeNull();
  });
});

describe('submitting a review', () => {
  it('refuses while any criterion is unscored, and names which', async () => {
    /*
     * THE BUG THIS PREVENTS. A review submitted with two of three criteria
     * blank produces a total lower than the reviewer meant, and it is compared
     * directly against colleagues who filled all three. It looks like a
     * judgement and it is an omission.
     */
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 9 }]);
    const err = await appErrorFrom(completeReview(db, ctx(), s.reviewer, s.assignmentId));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.fieldErrors?.map((f) => f.field).sort()).toEqual(['capacity', 'measurable_outcomes']);
  });

  it('completes a full sheet, and refuses a second time', async () => {
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [
      { criterionId: ids[0]!, score: 9 },
      { criterionId: ids[1]!, score: 8 },
      { criterionId: ids[2]!, score: 4 },
    ]);
    const done = await completeReview(db, ctx(), s.reviewer, s.assignmentId);
    expect(done.totalBp).toBe(470_000);
    expect((await appErrorFrom(completeReview(db, ctx(), s.reviewer, s.assignmentId))).code)
      .toBe('CONFLICT');
  });

  it('refuses to rewrite a submitted review without reopening it', async () => {
    /*
     * THE HOLE THIS CLOSES, found by an adversarial review and not by this
     * suite. `saveScores` checked `decidedAt` and `conflictDeclaredAt` and
     * never `completedAt`, so a reviewer -- or an admin importing a scorecard
     * -- could overwrite every score on a submitted review. The total changed,
     * `completed_at` still read as submitted, and `reopenReview` and its
     * `review.reopened` audit action were decorative.
     */
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    for (const [i, score] of [9, 8, 4].entries()) {
      await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[i]!, score }]);
    }
    await completeReview(db, ctx(), s.reviewer, s.assignmentId);

    const err = await appErrorFrom(
      saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 0 }]),
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/Reopen it/i);

    // Unchanged, and the sheet says it cannot be edited.
    const sheet = await loadScoringSheet(db, s.reviewer, s.assignmentId);
    expect(sheet.totalSoFarBp).toBe(470_000);
    expect(sheet.editable).toBe(false);

    // And reopening is the way through, which is what makes it not decorative.
    await reopenReview(db, ctx(), s.reviewer, s.assignmentId);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 0 }]);
    expect((await loadScoringSheet(db, s.reviewer, s.assignmentId)).totalSoFarBp).toBe(200_000);
  });

  it('lets a reviewer reopen their own, until a decision is made', async () => {
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    for (const [i, score] of [9, 8, 4].entries()) {
      await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[i]!, score }]);
    }
    await completeReview(db, ctx(), s.reviewer, s.assignmentId);
    await reopenReview(db, ctx(), s.reviewer, s.assignmentId);
    expect((await loadScoringSheet(db, s.reviewer, s.assignmentId)).completedAt).toBeNull();

    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 10 }]);
    await completeReview(db, ctx(), s.reviewer, s.assignmentId);
    await decideApplication(db, ctx(), admin, s.applicationId, { status: 'awarded' });

    const err = await appErrorFrom(reopenReview(db, ctx(), s.reviewer, s.assignmentId));
    expect(err.code).toBe('CONFLICT');
  });

  it('refuses a score once the application is decided', async () => {
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await decideApplication(db, ctx(), admin, s.applicationId, {
      status: 'declined', notes: 'Outside the focus area this cycle.',
    });
    const err = await appErrorFrom(
      saveScores(db, ctx(), s.reviewer, s.assignmentId, [{ criterionId: ids[0]!, score: 9 }]),
    );
    expect(err.code).toBe('CONFLICT');
  });
});

describe('the admin comparison', () => {
  it('averages COMPLETED reviews only', async () => {
    /*
     * THE BUG THIS PREVENTS. A half-finished sheet has a low total because it
     * is half finished. Averaging it in makes an application look weak for a
     * reason that has nothing to do with the application.
     */
    const s = await scored();
    const other = reviewerSession(await user('reviewer'));
    const second = await assignReviewer(db, ctx(), admin, s.applicationId, other.userId);
    const ids = await idsOf(s.assignmentId, s.reviewer);

    // One complete: 9,8,4 = 470000.
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [
      { criterionId: ids[0]!, score: 9 },
      { criterionId: ids[1]!, score: 8 },
      { criterionId: ids[2]!, score: 4 },
    ]);
    await completeReview(db, ctx(), s.reviewer, s.assignmentId);

    // One barely started.
    await saveScores(db, ctx(), other, second.id, [{ criterionId: ids[0]!, score: 1 }]);

    const summary = await scoreSummary(db, admin, s.applicationId);
    expect(summary.meanCompletedBp).toBe(470_000);
    expect(summary.reviewers.length).toBe(2);
    expect(summary.reviewers.find((r) => r.assignmentId === second.id)?.completedAt)
      .toBeNull();
  });

  it('is null when nobody has finished', async () => {
    const s = await scored();
    expect((await scoreSummary(db, admin, s.applicationId)).meanCompletedBp).toBeNull();
  });

  it('lays the criteria out side by side', async () => {
    const s = await scored();
    const ids = await idsOf(s.assignmentId, s.reviewer);
    await saveScores(db, ctx(), s.reviewer, s.assignmentId, [
      { criterionId: ids[0]!, score: 9, comment: 'clearly evidenced' },
    ]);
    const summary = await scoreSummary(db, admin, s.applicationId);
    expect(summary.byCriterion.length).toBe(3);
    expect(summary.byCriterion[0]!.scores[0]!.score).toBe(9);
    expect(summary.byCriterion[0]!.scores[0]!.comment).toBe('clearly evidenced');
    expect(summary.byCriterion[1]!.scores[0]!.score).toBeNull();
  });

  it('leaves out a recused reviewer entirely', async () => {
    const s = await scored();
    await recuse(db, ctx(), admin, s.assignmentId, 'sponsor relationship');
    const summary = await scoreSummary(db, admin, s.applicationId);
    expect(summary.reviewers.length).toBe(0);
  });
});

describe('nothing internal leaks through the sheet', () => {
  it('carries no other reviewer, no decision notes, no ip', async () => {
    // The same defence the applicant payloads get. A scoring sheet is not an
    // external payload, but it is the one internal payload most likely to be
    // reused somewhere it should not be.
    const s = await scored();
    const sheet = await loadScoringSheet(db, s.reviewer, s.assignmentId);
    for (const key of ['decision_notes', 'internal_notes', 'submission_ip', 'reviewer_user_id']) {
      expect(JSON.stringify(sheet)).not.toContain(key);
    }

    /*
     * NOT assertNoInternalFields. That guard is for payloads leaving to an
     * APPLICANT or a GRANTEE, and it refuses `score` and `comment` outright --
     * correctly, because an applicant must never see either. A reviewer's own
     * scoring sheet is made of exactly those two fields, so running the
     * external guard over it would fail for the right reason in the wrong
     * place. What matters here is the narrower rule: this sheet carries no
     * OTHER reviewer and nothing about the decision.
     *
     * The applicant-facing check that `score` never reaches an external
     * payload lives where those payloads are built, in scope.ts. Asserted here
     * only to show the guard is not a no-op that would pass anything.
     */
    expect(() => assertNoInternalFields(sheet)).toThrow(/score/);
  });
});
