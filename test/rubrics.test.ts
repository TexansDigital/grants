/**
 * Building a scoring rubric.
 *
 * WHAT IS ACTUALLY AT RISK HERE. A rubric is the instrument a funding decision
 * is made with, and the ways it goes wrong are all quiet. A weight stored as a
 * float ranks two identical applications differently. A published rubric
 * edited in place rewrites what an already-decided cycle was scored against. A
 * rubric swapped mid-cycle orphans every score already entered. None of these
 * produce an error at the time; they produce a ranking somebody acts on.
 *
 * So most of these tests are about refusals, and about integers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import {
  createRubric,
  replaceCriteria,
  publishRubric,
  newDraftFrom,
  attachRubricToCycle,
  getRubric,
  listRubrics,
  validateCriteria,
  WEIGHT_ONE_BP,
  MAX_CRITERION_SCORE,
  MAX_WEIGHT_BP,
  MAX_CRITERIA,
  type CriterionInput,
} from '../src/lib/rubrics';
import type { Session } from '../src/types';

let n = 0;
let admin: Session;

beforeEach(async () => {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
    )
    .bind(id, `rub-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);

const CRITERIA: CriterionInput[] = [
  { criterionKey: 'community_need', label: 'Critical community need', weightBp: 30000, maxScore: 10 },
  { criterionKey: 'measurable_outcomes', label: 'Measurable outcomes', weightBp: 20000, maxScore: 10 },
  { criterionKey: 'organizational_capacity', label: 'Capacity to deliver', weightBp: WEIGHT_ONE_BP, maxScore: 5 },
];

async function program() {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `rub-${++n}` });
  return { programId: p.programId, cycleId: Object.values(p.cycleIds)[0]! };
}

async function draftWithCriteria(criteria = CRITERIA) {
  const { programId, cycleId } = await program();
  const { rubricId } = await createRubric(db, ctx(), admin, {
    programId, name: 'Inspire Change scoring', rubricKey: 'inspire_change',
  });
  await replaceCriteria(db, ctx(), admin, rubricId, criteria);
  return { programId, cycleId, rubricId };
}

// ---------------------------------------------------------------------------

describe('weights are integers, and stay integers', () => {
  it('computes the ceiling as SUM(max_score * weight_bp), exactly', async () => {
    /*
     * THE BUG THIS PREVENTS. Weights of 0.3, 0.2 and 1.0 held as floats give a
     * ceiling that is not the number anyone wrote down, and the error shows up
     * as two applications that should tie being ranked. Basis points keep it
     * exact: 10*30000 + 10*20000 + 5*10000 = 550000, which is 55 points after
     * dividing by 10000 at the display edge.
     */
    const { rubricId } = await draftWithCriteria();
    const published = await publishRubric(db, ctx(), admin, rubricId);
    expect(published.maxTotalScoreBp).toBe(550_000);
    expect(Number.isInteger(published.maxTotalScoreBp)).toBe(true);

    const stored = await db
      .prepare(`SELECT max_total_score AS m FROM rubrics WHERE id = ?`)
      .bind(rubricId)
      .first<{ m: number }>();
    expect(stored?.m).toBe(550_000);
  });

  it('refuses a fractional weight rather than rounding it', async () => {
    // Rounding 0.333 to 3333 silently is how a rubric stops summing to what
    // the person who built it believes it sums to.
    const problems = validateCriteria([
      { criterionKey: 'a', label: 'A', weightBp: 3333.33, maxScore: 10 },
    ]);
    expect(problems.some((p) => p.field === 'criteria[0].weightBp')).toBe(true);
  });

  it('refuses a fractional or out-of-range max score', async () => {
    for (const bad of [0, -1, 2.5, MAX_CRITERION_SCORE + 1]) {
      const problems = validateCriteria([
        { criterionKey: 'a', label: 'A', weightBp: WEIGHT_ONE_BP, maxScore: bad },
      ]);
      expect(problems.some((p) => p.field === 'criteria[0].maxScore'), `maxScore ${bad}`).toBe(true);
    }
  });

  it('refuses a weight above the ceiling, not just a negative one', async () => {
    /*
     * THE BUG THIS PREVENTS. The floor was checked and the ceiling was not, so
     * a weight of Number.MAX_SAFE_INTEGER validated cleanly. Every weighted
     * total in the system is SUM(score * weight_bp) computed in SQLite, and a
     * product past safe-integer range stops being exact -- which is the whole
     * reason weights are integers rather than floats. The bound is generous:
     * 40 criteria at max score 100 and weight 100 apiece tops out four orders
     * of magnitude inside the safe range.
     */
    for (const bad of [MAX_WEIGHT_BP + 1, Number.MAX_SAFE_INTEGER]) {
      const problems = validateCriteria([
        { criterionKey: 'a', label: 'A', weightBp: bad, maxScore: 10 },
      ]);
      expect(problems.some((p) => p.field === 'criteria[0].weightBp'), `weight ${bad}`).toBe(true);
    }
    // And the ceiling itself is allowed, so the bound is not off by one.
    expect(
      validateCriteria([{ criterionKey: 'a', label: 'A', weightBp: MAX_WEIGHT_BP, maxScore: 10 }]),
    ).toEqual([]);
  });

  it('keeps the worst legal rubric inside safe-integer range', async () => {
    // The point of the ceiling, stated as arithmetic rather than as a promise.
    const worst = MAX_CRITERIA * MAX_CRITERION_SCORE * MAX_WEIGHT_BP;
    expect(Number.isSafeInteger(worst)).toBe(true);
  });

  it('refuses a rubric where every weight is zero', async () => {
    // Every total zero, every application tied, and it looks fine on screen.
    const problems = validateCriteria([
      { criterionKey: 'a', label: 'A', weightBp: 0, maxScore: 10 },
      { criterionKey: 'b', label: 'B', weightBp: 0, maxScore: 10 },
    ]);
    expect(problems.some((p) => p.field === 'criteria')).toBe(true);
  });

  it('allows ONE weight of zero, which is a criterion that is scored but not counted', async () => {
    const problems = validateCriteria([
      { criterionKey: 'a', label: 'A', weightBp: 0, maxScore: 10 },
      { criterionKey: 'b', label: 'B', weightBp: WEIGHT_ONE_BP, maxScore: 10 },
    ]);
    expect(problems).toEqual([]);
  });
});

describe('what a key has to be', () => {
  it('refuses a key that would break an export', async () => {
    // The key travels into offline scorecards and CSV column headers.
    for (const bad of ['Community Need', 'community-need', 'need!', '']) {
      const problems = validateCriteria([
        { criterionKey: bad, label: 'A', weightBp: WEIGHT_ONE_BP, maxScore: 10 },
      ]);
      expect(problems.some((p) => p.field === 'criteria[0].criterionKey'), bad).toBe(true);
    }
  });

  it('refuses two criteria with the same key', async () => {
    const problems = validateCriteria([
      { criterionKey: 'need', label: 'A', weightBp: WEIGHT_ONE_BP, maxScore: 10 },
      { criterionKey: 'need', label: 'B', weightBp: WEIGHT_ONE_BP, maxScore: 10 },
    ]);
    expect(problems.some((p) => p.field === 'criteria[1].criterionKey')).toBe(true);
  });
});

describe('saving the list', () => {
  it('adds, updates, reorders and removes in one act', async () => {
    const { rubricId } = await draftWithCriteria();
    await replaceCriteria(db, ctx(), admin, rubricId, [
      // reordered, retitled, reweighted
      { criterionKey: 'organizational_capacity', label: 'Capacity', weightBp: 15000, maxScore: 5 },
      { criterionKey: 'community_need', label: 'Critical community need', weightBp: 30000, maxScore: 10 },
      // new
      { criterionKey: 'volunteer_fit', label: 'Volunteer engagement', weightBp: 5000, maxScore: 5 },
      // measurable_outcomes dropped
    ]);

    const detail = await getRubric(db, rubricId);
    expect(detail.criteria.map((c) => c.criterion_key)).toEqual([
      'organizational_capacity', 'community_need', 'volunteer_fit',
    ]);
    expect(detail.criteria[0]!.label).toBe('Capacity');
    expect(detail.criteria[0]!.weight_bp).toBe(15000);
  });

  it('soft-deletes what was removed, and lets the same key come back', async () => {
    /*
     * A hard delete would be the one place in this schema that destroys a row,
     * and the unique index is partial on deleted_at IS NULL precisely so a key
     * removed by mistake can be typed again.
     */
    const { rubricId } = await draftWithCriteria();
    await replaceCriteria(db, ctx(), admin, rubricId, [CRITERIA[0]!]);

    /*
     * COUNT FIRST, then the stamp.
     *
     * This assertion used to read `expect(gone?.deleted_at).not.toBeNull()`
     * against a `.first()` that returns null when the row is gone -- so
     * `gone?.deleted_at` was `undefined`, and `undefined` is not null. A
     * mutant that replaced the soft delete with `DELETE FROM` passed it. The
     * test said "nothing is hard-deleted" and proved nothing at all.
     */
    const still = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM rubric_criteria
          WHERE rubric_id = ? AND criterion_key = 'measurable_outcomes'`,
      )
      .bind(rubricId)
      .first<{ n: number }>();
    expect(still?.n).toBe(1);

    const gone = await db
      .prepare(
        `SELECT deleted_at FROM rubric_criteria
          WHERE rubric_id = ? AND criterion_key = 'measurable_outcomes'`,
      )
      .bind(rubricId)
      .first<{ deleted_at: string | null }>();
    expect(typeof gone?.deleted_at).toBe('string');

    await replaceCriteria(db, ctx(), admin, rubricId, [CRITERIA[0]!, CRITERIA[1]!]);
    const back = await getRubric(db, rubricId);
    expect(back.criteria.map((c) => c.criterion_key)).toContain('measurable_outcomes');
  });

  it('writes one audit row carrying both sides', async () => {
    const { rubricId } = await draftWithCriteria();
    const row = await db
      .prepare(
        `SELECT before_json, after_json FROM audit_log
          WHERE action = 'rubric.criterion_changed' AND entity_id = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(rubricId)
      .first<{ before_json: string; after_json: string }>();
    const after = JSON.parse(row!.after_json) as { max_total_score_bp: number };
    expect(after.max_total_score_bp).toBe(550_000);
  });

  it('refuses an empty rubric', async () => {
    const { rubricId } = await draftWithCriteria();
    const err = await appErrorFrom(replaceCriteria(db, ctx(), admin, rubricId, []));
    expect(err.code).toBe('VALIDATION_FAILED');
  });
});

describe('publishing freezes it', () => {
  it('refuses an edit afterwards, and says there is a way forward', async () => {
    const { rubricId } = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, rubricId);

    const err = await appErrorFrom(replaceCriteria(db, ctx(), admin, rubricId, CRITERIA));
    expect(err.code).toBe('CONFLICT');
    /*
     * The database refuses this too, with "cannot change a criterion of a
     * rubric that is not draft" -- which would reach an admin as an INTERNAL
     * error telling them nothing they can act on. What they need to know is
     * that a new version is how you do what they are trying to do.
     */
    expect(err.publicMessage).toMatch(/new version/i);
  });

  it('retires the previous version in the same act', async () => {
    // Retire-then-publish as two calls leaves a window with no published
    // rubric, and a window with none is a scoring screen with nothing on it.
    const { programId, rubricId } = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, rubricId);

    const next = await newDraftFrom(db, ctx(), admin, rubricId);
    const result = await publishRubric(db, ctx(), admin, next.rubricId);
    expect(result.retiredRubricId).toBe(rubricId);
    expect(result.version).toBe(2);

    const live = await listRubrics(db, programId);
    expect(live.filter((r) => r.status === 'published').length).toBe(1);
  });

  it('carries the keys forward into the new version', async () => {
    // What makes "how did we score community need over three years" a
    // question at all.
    const { rubricId } = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, rubricId);
    const next = await newDraftFrom(db, ctx(), admin, rubricId);
    const detail = await getRubric(db, next.rubricId);
    expect(detail.criteria.map((c) => c.criterion_key).sort()).toEqual(
      CRITERIA.map((c) => c.criterionKey).sort(),
    );
    expect(detail.rubric.status).toBe('draft');
  });

  it('will not let a criterion with scores against it be soft-deleted', async () => {
    /*
     * WHY THIS IS TESTED HERE rather than in the summary. `scoreSummary`
     * counts a reviewer's progress with COUNT(rc.id), joined to live criteria,
     * so the count and the weighted total always answer over the same set --
     * but the reason that never diverges in practice is this freeze, not the
     * SQL. Publication is one way, a published rubric's criteria cannot be
     * touched, and a cycle can only use a published rubric. Three rules, and
     * removing any one of them puts scores against a criterion that no longer
     * exists.
     */
    const { rubricId } = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, rubricId);

    const criterion = await db
      .prepare(`SELECT id FROM rubric_criteria WHERE rubric_id = ? LIMIT 1`)
      .bind(rubricId)
      .first<{ id: string }>();
    await expect(
      db
        .prepare(`UPDATE rubric_criteria SET deleted_at = ? WHERE id = ?`)
        .bind(nowIso(), criterion!.id)
        .run(),
    ).rejects.toThrow(/not draft/);

    // ...and the rubric cannot be walked back to draft to get around it.
    await expect(
      db.prepare(`UPDATE rubrics SET status = 'draft' WHERE id = ?`).bind(rubricId).run(),
    ).rejects.toThrow(/cannot return to draft/);
  });

  it('refuses to publish twice', async () => {
    const { rubricId } = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, rubricId);
    expect((await appErrorFrom(publishRubric(db, ctx(), admin, rubricId))).code).toBe('CONFLICT');
  });

  it('refuses to publish an empty rubric', async () => {
    const { programId } = await program();
    const { rubricId } = await createRubric(db, ctx(), admin, {
      programId, name: 'Empty', rubricKey: 'empty',
    });
    expect((await appErrorFrom(publishRubric(db, ctx(), admin, rubricId))).code)
      .toBe('VALIDATION_FAILED');
  });
});

describe('attaching one to a cycle', () => {
  it('attaches a published rubric', async () => {
    const { cycleId, rubricId } = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, rubricId);
    await attachRubricToCycle(db, ctx(), admin, cycleId, rubricId);
    const c = await db
      .prepare(`SELECT rubric_id AS r FROM cycles WHERE id = ?`)
      .bind(cycleId)
      .first<{ r: string }>();
    expect(c?.r).toBe(rubricId);
  });

  it('refuses a draft', async () => {
    // A cycle pointing at a draft is one whose criteria can change under the
    // reviewers scoring against them.
    const { cycleId, rubricId } = await draftWithCriteria();
    expect((await appErrorFrom(attachRubricToCycle(db, ctx(), admin, cycleId, rubricId))).code)
      .toBe('CONFLICT');
  });

  it('refuses a rubric belonging to another program', async () => {
    // Enforced by 0006's trigger, so this proves the trigger is reached rather
    // than re-implementing the rule here.
    const a = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, a.rubricId);
    const b = await program();
    await expect(attachRubricToCycle(db, ctx(), admin, b.cycleId, a.rubricId)).rejects.toThrow();
  });

  it('refuses a swap once scoring has started', async () => {
    /*
     * THE BUG THIS PREVENTS. 0006 refuses a new score against a criterion
     * outside the cycle's rubric. Swap the rubric mid-cycle and the scores
     * already entered stay in the table and stop being reachable -- a silent
     * loss of everything the reviewers have done so far. Refusing here is the
     * cheaper failure.
     */
    const { cycleId, rubricId, programId } = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, rubricId);
    await attachRubricToCycle(db, ctx(), admin, cycleId, rubricId);

    // An application in the cycle, a reviewer assigned, one score recorded.
    const orgId = newId();
    const applicationId = newId();
    const reviewerId = newId();
    const assignmentId = newId();
    const now = nowIso();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, `Invented Scorer ${n}`, String(900000000 + n), now, now).run();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'reviewer', NULL, 1, ?, ?)`,
    ).bind(reviewerId, `rv-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now).run();
    await db.prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?
         FROM form_definitions fd WHERE fd.program_id = ? LIMIT 1`,
    ).bind(applicationId, cycleId, orgId, now, now, now, programId).run();
    await db.prepare(
      `INSERT INTO review_assignments (id, application_id, reviewer_user_id, assigned_at,
         created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).bind(assignmentId, applicationId, reviewerId, now, now, now).run();
    const criterion = (await getRubric(db, rubricId)).criteria[0]!;
    await db.prepare(
      `INSERT INTO review_scores (id, review_assignment_id, rubric_criterion_id, score,
         scored_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(newId(), assignmentId, criterion.id, 7, now, now, now).run();

    const next = await newDraftFrom(db, ctx(), admin, rubricId);
    await publishRubric(db, ctx(), admin, next.rubricId);
    const err = await appErrorFrom(
      attachRubricToCycle(db, ctx(), admin, cycleId, next.rubricId),
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/already started/i);
  });

  it('is idempotent when nothing changes', async () => {
    // Re-attaching the SAME rubric is not a swap, and refusing it would make
    // an accidental double-click look like a fault.
    const { cycleId, rubricId } = await draftWithCriteria();
    await publishRubric(db, ctx(), admin, rubricId);
    await attachRubricToCycle(db, ctx(), admin, cycleId, rubricId);
    await attachRubricToCycle(db, ctx(), admin, cycleId, rubricId);
  });
});

describe('versions', () => {
  it('numbers from one, per key, not per program', async () => {
    const { programId } = await program();
    const a1 = await createRubric(db, ctx(), admin, {
      programId, name: 'Main', rubricKey: 'main',
    });
    const b1 = await createRubric(db, ctx(), admin, {
      programId, name: 'Screening', rubricKey: 'screening',
    });
    expect(a1.version).toBe(1);
    expect(b1.version).toBe(1);

    await replaceCriteria(db, ctx(), admin, a1.rubricId, CRITERIA);
    await publishRubric(db, ctx(), admin, a1.rubricId);
    const a2 = await newDraftFrom(db, ctx(), admin, a1.rubricId);
    expect(a2.version).toBe(2);
  });

  it('refuses a rubric key that would break an export', async () => {
    const { programId } = await program();
    for (const bad of ['Main Rubric', 'main-rubric', '']) {
      expect(
        (
          await appErrorFrom(
            createRubric(db, ctx(), admin, { programId, name: 'x', rubricKey: bad }),
          )
        ).code,
      ).toBe('VALIDATION_FAILED');
    }
  });

  it('404s for a program that does not exist', async () => {
    expect(
      (
        await appErrorFrom(
          createRubric(db, ctx(), admin, { programId: newId(), name: 'x', rubricKey: 'x' }),
        )
      ).code,
    ).toBe('NOT_FOUND');
  });
});
