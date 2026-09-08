import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession } from './helpers';
import { getApplicationForStaff, listApplicationsForReviewer } from '../src/lib/scope';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * Migration 0006: rubrics, criteria, assignments, scores — and the reviewer
 * scope path they turn on.
 *
 * The authorization tests here are definition-of-done #2 for this phase. A
 * failure means an outside consultant can read an application nobody assigned
 * to them, including another nonprofit's audited financials.
 */

interface Scene {
  programId: string;
  cycleId: string;
  stageId: string;
  formId: string;
  appA: string;
  appB: string;
  reviewer: string;
  otherReviewer: string;
  rubricId: string;
  criterionIds: string[];
}

async function makeUser(role: string, email = `${role}-${newId()}@example.org`): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, display_name, is_active, created_at, updated_at)
       VALUES (?,?,?,NULL,?,1,?,?)`,
    )
    .bind(id, email, role, email, now, now)
    .run();
  return id;
}

/** A published rubric with three criteria, attached to the cycle. */
async function makeRubric(programId: string, cycleId: string): Promise<{ rubricId: string; criterionIds: string[] }> {
  const now = nowIso();
  const rubricId = newId();
  await db
    .prepare(
      `INSERT INTO rubrics (id, program_id, name, rubric_key, version, status, created_at, updated_at)
       VALUES (?,?,?,?,1,'draft',?,?)`,
    )
    .bind(rubricId, programId, 'Inspire Change 2026', 'default', now, now)
    .run();

  const criteria = [
    { key: 'need', label: 'Community need', weight: 3500, max: 5 },
    { key: 'impact', label: 'Measurable impact', weight: 4000, max: 5 },
    { key: 'capacity', label: 'Organizational capacity', weight: 2500, max: 10 },
  ];
  const criterionIds: string[] = [];
  for (const [i, c] of criteria.entries()) {
    const id = newId();
    criterionIds.push(id);
    await db
      .prepare(
        `INSERT INTO rubric_criteria (id, rubric_id, criterion_key, label, weight_bp, max_score, sort_order, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(id, rubricId, c.key, c.label, c.weight, c.max, i, now, now)
      .run();
  }

  // Publish, then attach to the cycle.
  await db
    .prepare(`UPDATE rubrics SET status='published', published_at=?, max_total_score=? WHERE id=?`)
    .bind(now, 20, rubricId)
    .run();
  await db.prepare(`UPDATE cycles SET rubric_id=? WHERE id=?`).bind(rubricId, cycleId).run();

  return { rubricId, criterionIds };
}

async function scene(): Promise<Scene> {
  const ctx = ctxFor(adminSession());
  const program = await seedProgram(db, ctx, INSPIRE_CHANGE);
  const orgA = await seedOrganization(db, ctx, ORG_FIXTURES[0]!);
  const orgB = await seedOrganization(db, ctx, ORG_FIXTURES[1]!);

  const cycleId = Object.values(program.cycleIds)[0]!;
  const stageId = program.stageIds.application!;
  const formId = program.formDefinitionIds.application!;
  const now = nowIso();

  async function makeApp(organizationId: string, title: string): Promise<string> {
    const id = newId();
    await db
      .prepare(
        `INSERT INTO applications (
           id, cycle_id, stage_id, organization_id, form_definition_id, status,
           project_title, internal_notes, submitted_at, created_at, updated_at
         ) VALUES (?,?,?,?,?,'submitted',?,?,?,?,?)`,
      )
      .bind(id, cycleId, stageId, organizationId, formId, title, 'INTERNAL: thin budget', now, now, now)
      .run();
    return id;
  }

  const { rubricId, criterionIds } = await makeRubric(program.programId, cycleId);

  return {
    programId: program.programId,
    cycleId,
    stageId,
    formId,
    appA: await makeApp(orgA.organizationId, 'Reading support'),
    appB: await makeApp(orgB.organizationId, 'Youth mental health'),
    reviewer: await makeUser('reviewer'),
    otherReviewer: await makeUser('reviewer'),
    rubricId,
    criterionIds,
  };
}

async function assign(applicationId: string, reviewerUserId: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO review_assignments (id, application_id, reviewer_user_id, assigned_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(id, applicationId, reviewerUserId, now, now, now)
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Authorization. Definition of done #2.
// ---------------------------------------------------------------------------

describe('reviewer scope', () => {
  it('a reviewer sees an application assigned to them', async () => {
    const s = await scene();
    await assign(s.appA, s.reviewer);
    const row = await getApplicationForStaff(db, reviewerSession(s.reviewer), s.appA);
    expect(row.id).toBe(s.appA);
  });

  it('404s an application assigned to a DIFFERENT reviewer', async () => {
    const s = await scene();
    await assign(s.appA, s.otherReviewer);
    await expect(
      getApplicationForStaff(db, reviewerSession(s.reviewer), s.appA),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404s an application with no assignment at all', async () => {
    const s = await scene();
    await expect(
      getApplicationForStaff(db, reviewerSession(s.reviewer), s.appB),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404s once the reviewer is RECUSED, without deleting the record', async () => {
    const s = await scene();
    const assignmentId = await assign(s.appA, s.reviewer);
    const session = reviewerSession(s.reviewer);
    expect((await getApplicationForStaff(db, session, s.appA)).id).toBe(s.appA);

    await db
      .prepare(`UPDATE review_assignments SET recused_at=?, recused_reason=? WHERE id=?`)
      .bind(nowIso(), 'board member of the applicant', assignmentId)
      .run();

    await expect(getApplicationForStaff(db, session, s.appA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // The row survives: who was assigned and why they stepped back is the audit
    // trail, and deleting it would erase exactly what an auditor looks for.
    const row = await db
      .prepare(`SELECT recused_reason FROM review_assignments WHERE id=?`)
      .bind(assignmentId)
      .first<{ recused_reason: string }>();
    expect(row?.recused_reason).toBe('board member of the applicant');
  });

  it('404s once the assignment is SOFT-DELETED', async () => {
    // Unassigning is a soft delete, like everything else in this schema. The
    // JOIN forgot deleted_at while the table did not exist, so removing a
    // consultant from a cycle would have left their access intact -- and
    // CLAUDE.md requires revocation in one action.
    const s = await scene();
    const assignmentId = await assign(s.appA, s.reviewer);
    const session = reviewerSession(s.reviewer);
    expect((await getApplicationForStaff(db, session, s.appA)).id).toBe(s.appA);

    await db
      .prepare(`UPDATE review_assignments SET deleted_at=? WHERE id=?`)
      .bind(nowIso(), assignmentId)
      .run();

    await expect(getApplicationForStaff(db, session, s.appA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('an admin still sees everything', async () => {
    const s = await scene();
    const session = adminSession();
    expect((await getApplicationForStaff(db, session, s.appA)).id).toBe(s.appA);
    expect((await getApplicationForStaff(db, session, s.appB)).id).toBe(s.appB);
  });

  it('an executive sees nothing, assigned or not', async () => {
    const s = await scene();
    await assign(s.appA, s.reviewer);
    const exec = { userId: s.reviewer, email: 'exec@example.org', role: 'executive' as const, organizationId: null };
    await expect(getApplicationForStaff(db, exec, s.appA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('the review queue agrees with the detail view', () => {
  it('lists only assigned, non-recused, non-deleted applications', async () => {
    const s = await scene();
    await assign(s.appA, s.reviewer);
    const recused = await assign(s.appB, s.reviewer);
    await db
      .prepare(`UPDATE review_assignments SET recused_at=?, recused_reason='conflict' WHERE id=?`)
      .bind(nowIso(), recused)
      .run();

    const rows = await listApplicationsForReviewer(db, reviewerSession(s.reviewer));
    expect(rows.map((r) => r.id)).toEqual([s.appA]);
  });

  it('never lists a row the detail view would refuse', async () => {
    // The list and the detail view drifting is how a queue leaks a title that
    // 404s when clicked. Cross-check every row.
    const s = await scene();
    await assign(s.appA, s.reviewer);
    await assign(s.appB, s.otherReviewer);

    const session = reviewerSession(s.reviewer);
    const rows = await listApplicationsForReviewer(db, session);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      await expect(getApplicationForStaff(db, session, String(row.id))).resolves.toBeTruthy();
    }
  });

  it('carries no internal-only column into the queue', async () => {
    const s = await scene();
    await assign(s.appA, s.reviewer);
    const rows = await listApplicationsForReviewer(db, reviewerSession(s.reviewer));
    const json = JSON.stringify(rows);
    expect(json).not.toContain('internal_notes');
    expect(json).not.toContain('decision_notes');
  });

  it('returns empty for an applicant rather than erroring', async () => {
    const s = await scene();
    await assign(s.appA, s.reviewer);
    const rows = await listApplicationsForReviewer(db, applicantSession(newId()));
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Schema guarantees. These are enforced in the database because a funding
// ranking is computed from them.
// ---------------------------------------------------------------------------

describe('rubric integrity', () => {
  it('refuses a second published rubric for the same program and key', async () => {
    const s = await scene();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO rubrics (id, program_id, name, rubric_key, version, status, max_total_score, published_at, created_at, updated_at)
         VALUES (?,?,?,?,2,'published',20,?,?,?)`,
      )
      .bind(newId(), s.programId, 'Duplicate', 'default', now, now, now)
      .run()
      .then(
        () => expect.unreachable('a second published rubric should collide'),
        (e: Error) => expect(String(e)).toMatch(/UNIQUE|constraint/i),
      );
  });

  it('will not let a published rubric return to draft', async () => {
    const s = await scene();
    await expect(
      db.prepare(`UPDATE rubrics SET status='draft' WHERE id=?`).bind(s.rubricId).run(),
    ).rejects.toThrow(/cannot return to draft/);
  });

  it('freezes the criteria of a published rubric, in both directions', async () => {
    const s = await scene();
    const now = nowIso();
    // Cannot add.
    await expect(
      db
        .prepare(
          `INSERT INTO rubric_criteria (id, rubric_id, criterion_key, label, weight_bp, max_score, sort_order, created_at, updated_at)
           VALUES (?,?,?,?,1000,5,9,?,?)`,
        )
        .bind(newId(), s.rubricId, 'late', 'Added after publish', now, now)
        .run(),
    ).rejects.toThrow(/not draft/);
    // Cannot change.
    await expect(
      db.prepare(`UPDATE rubric_criteria SET max_score=99 WHERE id=?`).bind(s.criterionIds[0]!).run(),
    ).rejects.toThrow(/not draft/);
    // Cannot remove.
    await expect(
      db.prepare(`DELETE FROM rubric_criteria WHERE id=?`).bind(s.criterionIds[0]!).run(),
    ).rejects.toThrow(/not draft/);
  });

  it('refuses a cycle rubric from a DIFFERENT program', async () => {
    const s = await scene();
    const now = nowIso();
    const otherProgram = newId();
    await db
      .prepare(
        `INSERT INTO programs (id, name, slug, status, compliance_policy, created_at, updated_at)
         VALUES (?,?,?,'active','warn',?,?)`,
      )
      .bind(otherProgram, 'Other Program', `other-${otherProgram}`, now, now)
      .run();
    const foreignRubric = newId();
    await db
      .prepare(
        `INSERT INTO rubrics (id, program_id, name, rubric_key, version, status, created_at, updated_at)
         VALUES (?,?,?,'default',1,'draft',?,?)`,
      )
      .bind(foreignRubric, otherProgram, 'Foreign', now, now)
      .run();

    await expect(
      db.prepare(`UPDATE cycles SET rubric_id=? WHERE id=?`).bind(foreignRubric, s.cycleId).run(),
    ).rejects.toThrow(/same program/);
  });

  it('refuses a cycle rubric that does not exist', async () => {
    const s = await scene();
    await expect(
      db.prepare(`UPDATE cycles SET rubric_id=? WHERE id=?`).bind(newId(), s.cycleId).run(),
    ).rejects.toThrow(/does not reference a live rubric/);
  });
});

describe('assignment integrity', () => {
  it('refuses to assign a non-staff user as a reviewer', async () => {
    // An applicant with an assignment row would read another organization's
    // application. This is the worst outcome the schema can produce.
    const s = await scene();
    const applicantUser = newId();
    const now = nowIso();
    const org = (await seedOrganization(db, ctxFor(adminSession()), ORG_FIXTURES[2]!)).organizationId;
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, display_name, is_active, created_at, updated_at)
         VALUES (?,?,'applicant',?,?,1,?,?)`,
      )
      .bind(applicantUser, `a-${applicantUser}@example.org`, org, 'Applicant', now, now)
      .run();

    await expect(assign(s.appA, applicantUser)).rejects.toThrow(/reviewer or admin/);
  });

  it('refuses a second live assignment for the same reviewer and application', async () => {
    const s = await scene();
    await assign(s.appA, s.reviewer);
    await expect(assign(s.appA, s.reviewer)).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('allows re-assignment after the first is soft-deleted', async () => {
    const s = await scene();
    const first = await assign(s.appA, s.reviewer);
    await db.prepare(`UPDATE review_assignments SET deleted_at=? WHERE id=?`).bind(nowIso(), first).run();
    await expect(assign(s.appA, s.reviewer)).resolves.toBeTruthy();
  });

  it('will not let a recusal be withdrawn', async () => {
    const s = await scene();
    const id = await assign(s.appA, s.reviewer);
    await db
      .prepare(`UPDATE review_assignments SET recused_at=?, recused_reason='conflict' WHERE id=?`)
      .bind(nowIso(), id)
      .run();
    await expect(
      db.prepare(`UPDATE review_assignments SET recused_at=NULL WHERE id=?`).bind(id).run(),
    ).rejects.toThrow(/cannot be withdrawn/);
  });

  it('refuses a recusal with no reason', async () => {
    const s = await scene();
    const id = await assign(s.appA, s.reviewer);
    await expect(
      db.prepare(`UPDATE review_assignments SET recused_at=? WHERE id=?`).bind(nowIso(), id).run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it('refuses a conflict note with no timestamp, and a timestamp with no note', async () => {
    const s = await scene();
    const id = await assign(s.appA, s.reviewer);
    await expect(
      db.prepare(`UPDATE review_assignments SET conflict_note='knows the ED' WHERE id=?`).bind(id).run(),
    ).rejects.toThrow(/CHECK|constraint/i);
    await expect(
      db.prepare(`UPDATE review_assignments SET conflict_declared_at=? WHERE id=?`).bind(nowIso(), id).run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });
});

describe('score integrity', () => {
  async function score(assignmentId: string, criterionId: string, value: number) {
    const now = nowIso();
    return db
      .prepare(
        `INSERT INTO review_scores (id, review_assignment_id, rubric_criterion_id, score, scored_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(newId(), assignmentId, criterionId, value, now, now, now)
      .run();
  }

  it('accepts a score inside the criterion maximum', async () => {
    const s = await scene();
    const a = await assign(s.appA, s.reviewer);
    await expect(score(a, s.criterionIds[0]!, 5)).resolves.toBeTruthy();
  });

  it('refuses a score ABOVE the criterion maximum', async () => {
    // A 6 on a 0-5 criterion silently distorts a ranking, and the ranking is
    // what the funding decision is made from.
    const s = await scene();
    const a = await assign(s.appA, s.reviewer);
    await expect(score(a, s.criterionIds[0]!, 6)).rejects.toThrow(/exceeds the maximum/);
  });

  it('refuses a negative score', async () => {
    const s = await scene();
    const a = await assign(s.appA, s.reviewer);
    await expect(score(a, s.criterionIds[0]!, -1)).rejects.toThrow(/CHECK|constraint/i);
  });

  it('refuses a FLOAT score, the way money refuses a float', async () => {
    const s = await scene();
    const a = await assign(s.appA, s.reviewer);
    await expect(score(a, s.criterionIds[0]!, 4.5)).rejects.toThrow(/CHECK|constraint/i);
  });

  it('refuses a criterion from a rubric that is not the cycle’s', async () => {
    const s = await scene();
    const a = await assign(s.appA, s.reviewer);
    const now = nowIso();
    const otherRubric = newId();
    await db
      .prepare(
        `INSERT INTO rubrics (id, program_id, name, rubric_key, version, status, created_at, updated_at)
         VALUES (?,?,?,'alternate',1,'draft',?,?)`,
      )
      .bind(otherRubric, s.programId, 'Alternate', now, now)
      .run();
    const otherCriterion = newId();
    await db
      .prepare(
        `INSERT INTO rubric_criteria (id, rubric_id, criterion_key, label, weight_bp, max_score, sort_order, created_at, updated_at)
         VALUES (?,?,'x','Foreign criterion',10000,5,0,?,?)`,
      )
      .bind(otherCriterion, otherRubric, now, now)
      .run();

    await expect(score(a, otherCriterion, 3)).rejects.toThrow(/does not belong to the rubric/);
  });

  it('refuses a new score once the reviewer is recused, keeping the earlier ones', async () => {
    const s = await scene();
    const a = await assign(s.appA, s.reviewer);
    await score(a, s.criterionIds[0]!, 4);
    await db
      .prepare(`UPDATE review_assignments SET recused_at=?, recused_reason='conflict' WHERE id=?`)
      .bind(nowIso(), a)
      .run();

    await expect(score(a, s.criterionIds[1]!, 5)).rejects.toThrow(/recused assignment/);
    const kept = await db
      .prepare(`SELECT COUNT(*) AS n FROM review_scores WHERE review_assignment_id=?`)
      .bind(a)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });

  it('refuses two live scores for the same criterion on one assignment', async () => {
    const s = await scene();
    const a = await assign(s.appA, s.reviewer);
    await score(a, s.criterionIds[0]!, 3);
    await expect(score(a, s.criterionIds[0]!, 4)).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('weights are integer basis points that sum exactly', async () => {
    // 0.35 + 0.40 + 0.25 in floating point is not 1. 3500 + 4000 + 2500 is
    // exactly 10000, and a review committee never sees a total of 87.99999.
    const s = await scene();
    const { results } = await db
      .prepare(`SELECT weight_bp FROM rubric_criteria WHERE rubric_id=? AND deleted_at IS NULL`)
      .bind(s.rubricId)
      .all<{ weight_bp: number }>();
    const total = (results ?? []).reduce((n, r) => n + r.weight_bp, 0);
    expect(total).toBe(10_000);
    expect(Number.isInteger(total)).toBe(true);
  });
});
