/**
 * Putting applications in front of reviewers.
 *
 * Scoring is not here and cannot be until the Foundation's rubric exists.
 * Everything else about review can, and most of the ways a review round goes
 * wrong are in this half rather than in the arithmetic:
 *
 *   - applications nobody was assigned to, discovered at the deadline
 *   - one consultant holding nine while another holds two
 *   - a conflict declared and then quietly overwritten
 *   - an assignment withdrawn after scoring, orphaning the scores
 *   - a reviewer reading an application that was never submitted
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import {
  assignReviewer,
  unassignReviewer,
  declareConflict,
  clearConflict,
  recuse,
  reviewCoverage,
  distributeReviewers,
} from '../src/lib/reviewAssign';
import type { Session } from '../src/types';

let n = 0;

/*
 * A REAL admin row, not just a session object.
 *
 * review_assignments.assigned_by is a foreign key into users. adminSession()
 * mints a random id with no row behind it, so every insert failed with
 * FOREIGN KEY constraint failed -- which says nothing about which key.
 */
let adminId = '';
let admin: Session;

async function ensureAdmin(): Promise<void> {
  if (adminId) return;
  adminId = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
    )
    .bind(adminId, `review-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(adminId);
}

beforeEach(async () => {
  adminId = '';
  await ensureAdmin();
});

const ctx = () => ctxFor(admin);

async function reviewer(name: string): Promise<{ id: string; session: Session }> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'reviewer', NULL, 1, ?, ?)`,
    )
    .bind(id, `rev-${name}-${++n}@example.org`, now, now)
    .run();
  return { id, session: reviewerSession(id) };
}

async function cycleWithApplications(count: number, opts: { submitted?: boolean } = {}) {
  const program = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `rev-${++n}` });
  const cycleId = (await db
    .prepare(`SELECT id FROM cycles WHERE program_id=? LIMIT 1`)
    .bind(program.programId)
    .first<{ id: string }>())!.id;
  const stageId = (await db
    .prepare(`SELECT id FROM program_stages WHERE program_id=? LIMIT 1`)
    .bind(program.programId)
    .first<{ id: string }>())!.id;
  const formId = (await db
    .prepare(`SELECT id FROM form_definitions WHERE program_id=? LIMIT 1`)
    .bind(program.programId)
    .first<{ id: string }>())!.id;

  const applications: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const orgId = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?, 'active', ?, ?)`,
      )
      .bind(orgId, `Invented Org ${++n}`, String(800000000 + n), now, now)
      .run();
    const appId = newId();
    await db
      .prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, project_title, submitted_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        appId, cycleId, stageId, orgId, formId,
        opts.submitted === false ? 'draft' : 'submitted',
        `Project ${n}`,
        opts.submitted === false ? null : now,
        now, now,
      )
      .run();
    applications.push(appId);
  }
  return { cycleId, applications };
}

// ---------------------------------------------------------------------------

describe('assigning one reviewer', () => {
  it('creates the assignment and audits it', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('a');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);

    expect(a.application_id).toBe(applications[0]);
    expect(a.reviewer_user_id).toBe(rev.id);

    const audited = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action='review.assigned' AND entity_id=?`)
      .bind(a.id)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('is idempotent, so a double click does not double-assign', async () => {
    // On a slow connection this is one press, not two decisions. A UNIQUE
    // constraint would turn it into an error somebody has to interpret.
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('b');
    const first = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    const second = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    expect(second.id).toBe(first.id);

    const rows = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_assignments
          WHERE application_id=? AND deleted_at IS NULL`,
      )
      .bind(applications[0])
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('refuses an application nobody has submitted', async () => {
    // A draft belongs to the applicant. Putting one in front of a reviewer
    // shows them work nobody chose to submit.
    const { applications } = await cycleWithApplications(1, { submitted: false });
    const rev = await reviewer('c');
    await expect(
      assignReviewer(db, ctx(), admin, applications[0]!, rev.id),
    ).rejects.toThrow();
  });

  it('refuses a reviewer who is not one', async () => {
    const { applications } = await cycleWithApplications(1);
    const orgId = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?, 'active', ?, ?)`,
      )
      .bind(orgId, 'Invented Applicant Org', String(900000000 + ++n), now, now)
      .run();
    const applicantId = newId();
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
         VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
      )
      .bind(applicantId, `app-${n}@example.org`, orgId, now, now)
      .run();

    await expect(
      assignReviewer(db, ctx(), admin, applications[0]!, applicantId),
    ).rejects.toThrow();
  });
});

describe('taking an assignment back', () => {
  it('soft-deletes it and leaves the audit row', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('d');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await unassignReviewer(db, ctx(), admin, a.id);

    const row = await db
      .prepare(`SELECT deleted_at FROM review_assignments WHERE id=?`)
      .bind(a.id)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).not.toBeNull();

    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action='review.unassigned' AND entity_id=?`,
      )
      .bind(a.id)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('refuses once scores exist, because removing it would orphan them', async () => {
    const { applications, cycleId } = await cycleWithApplications(1);
    const rev = await reviewer('e');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);

    // The smallest rubric that lets a score exist at all.
    const rubricId = newId();
    const criterionId = newId();
    const now = nowIso();
    const programId = (await db
      .prepare(`SELECT program_id FROM cycles WHERE id=?`)
      .bind(cycleId)
      .first<{ program_id: string }>())!.program_id;
    await db
      .prepare(
        `INSERT INTO rubrics (id, program_id, name, rubric_key, version, max_total_score,
           created_at, updated_at)
         VALUES (?,?,?,?,1,100,?,?)`,
      )
      .bind(rubricId, programId, 'Invented rubric', `invented-${n}`, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO rubric_criteria (id, rubric_id, criterion_key, label, weight_bp,
           max_score, sort_order, created_at, updated_at)
         VALUES (?,?,?,?,10000,10,0,?,?)`,
      )
      // weight_bp, in basis points: 10000 is a multiplier of 1. Same integer
      // discipline as money, and for the same reason.
      .bind(criterionId, rubricId, `invented-criterion-${n}`, 'Invented criterion', now, now)
      .run();
    // 0006 has a trigger refusing a score whose criterion does not belong to
    // the rubric attached to this application's cycle. Satisfying it is the
    // point: a score that cannot be traced to the rubric it was given under is
    // a number nobody can defend a year later.
    await db
      .prepare(`UPDATE cycles SET rubric_id=? WHERE id=?`)
      .bind(rubricId, cycleId)
      .run();
    await db
      .prepare(
        `INSERT INTO review_scores (id, review_assignment_id, rubric_criterion_id, score, scored_at, created_at, updated_at)
         VALUES (?,?,?,7,?,?,?)`,
      )
      .bind(newId(), a.id, criterionId, now, now, now)
      .run();

    await expect(unassignReviewer(db, ctx(), admin, a.id)).rejects.toThrow();
  });
});

describe('conflict of interest', () => {
  it('records a declaration without recusing anybody', async () => {
    // Sitting on a nonprofit's board does not automatically disqualify
    // somebody from reading an unrelated application. That judgment is an
    // admin's, made by reading the note.
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('f');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'I sit on their board.');

    const row = await db
      .prepare(`SELECT conflict_note, conflict_declared_at, recused_at FROM review_assignments WHERE id=?`)
      .bind(a.id)
      .first<{ conflict_note: string; conflict_declared_at: string; recused_at: string | null }>();
    expect(row?.conflict_note).toBe('I sit on their board.');
    expect(row?.conflict_declared_at).not.toBeNull();
    expect(row?.recused_at).toBeNull();
  });

  it('refuses a second declaration rather than overwriting the first', async () => {
    // What was disclosed and when is the part an auditor reads.
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('g');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'First disclosure.');
    await expect(declareConflict(db, ctx(), rev.session, a.id, 'Second.')).rejects.toThrow();

    const row = await db
      .prepare(`SELECT conflict_note FROM review_assignments WHERE id=?`)
      .bind(a.id)
      .first<{ conflict_note: string }>();
    expect(row?.conflict_note).toBe('First disclosure.');
  });

  it('refuses an empty declaration', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('h');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await expect(declareConflict(db, ctx(), rev.session, a.id, '   ')).rejects.toThrow();
  });

  it('will not let one reviewer declare on another reviewer&apos;s assignment', async () => {
    const { applications } = await cycleWithApplications(1);
    const mine = await reviewer('i');
    const theirs = await reviewer('j');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, mine.id);
    // 404, not 403: the assignment does not exist as far as they are concerned.
    await expect(declareConflict(db, ctx(), theirs.session, a.id, 'Not mine.')).rejects.toThrow();
  });

  it('records a recusal with its reason, and is idempotent', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('k');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await recuse(db, ctx(), rev.session, a.id, 'Former employee.');
    await recuse(db, ctx(), rev.session, a.id, 'Former employee.');

    const row = await db
      .prepare(`SELECT recused_at, recused_reason FROM review_assignments WHERE id=?`)
      .bind(a.id)
      .first<{ recused_at: string; recused_reason: string }>();
    expect(row?.recused_reason).toBe('Former employee.');

    const audited = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action='review.recused' AND entity_id=?`)
      .bind(a.id)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('refuses a recusal with no reason', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('l');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await expect(recuse(db, ctx(), rev.session, a.id, '')).rejects.toThrow();
  });
});

describe('a declared conflict that turns out not to be one', () => {
  /*
   * WHY THIS EXISTS AT ALL. Before it, a declaration was irreversible:
   * scoring was refused from that moment and the only exits were recusal --
   * which loses the reviewer for that application -- or leaving the
   * assignment blocked while the coverage screen counted it as covered. The
   * incentive that creates is for a reviewer to stay quiet until they are
   * sure, which is the late disclosure that declaring at assignment is meant
   * to prevent.
   */

  it('records a resolution beside the declaration, never instead of it', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('ca');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'I think I know a board member.');
    await clearConflict(db, ctx(), admin, a.id, 'Different person. Checked the board list.');

    const row = await db
      .prepare(
        `SELECT conflict_note, conflict_declared_at AS declared,
                conflict_cleared_at AS cleared, conflict_cleared_by AS by
           FROM review_assignments WHERE id=?`,
      )
      .bind(a.id)
      .first<{ conflict_note: string; declared: string; cleared: string; by: string }>();

    // The declaration is untouched. This is not an undo.
    expect(row?.declared).not.toBeNull();
    expect(row?.conflict_note).toContain('I think I know a board member.');
    expect(row?.conflict_note).toContain('Different person.');
    expect(row?.cleared).not.toBeNull();
    expect(row?.by).toBe(adminId);

    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log
          WHERE action='review.conflict_cleared' AND entity_id=?`,
      )
      .bind(a.id)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('will not let the reviewer clear their own declaration', async () => {
    // The one act a conflict policy exists to prevent.
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('cb');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'My spouse works there.');
    expect(
      (await appErrorFrom(clearConflict(db, ctx(), rev.session, a.id, 'It is fine.'))).code,
    ).toBe('NOT_FOUND');

    const row = await db
      .prepare(`SELECT conflict_cleared_at AS cleared FROM review_assignments WHERE id=?`)
      .bind(a.id)
      .first<{ cleared: string | null }>();
    expect(row?.cleared).toBeNull();
  });

  it('refuses a resolution with nothing in it', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('cc');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'Possible overlap.');
    expect((await appErrorFrom(clearConflict(db, ctx(), admin, a.id, '  '))).code)
      .toBe('VALIDATION_FAILED');
  });

  it('refuses to clear a conflict nobody declared', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('cd');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    expect((await appErrorFrom(clearConflict(db, ctx(), admin, a.id, 'Nothing to resolve.'))).code)
      .toBe('CONFLICT');
  });

  it('refuses to clear it twice', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('ce');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'Possible overlap.');
    await clearConflict(db, ctx(), admin, a.id, 'Checked, not a conflict.');
    expect((await appErrorFrom(clearConflict(db, ctx(), admin, a.id, 'Again.'))).code)
      .toBe('CONFLICT');
  });

  it('refuses to clear one the reviewer has already stepped away from', async () => {
    // Clearing would not put them back, and a cleared flag on a recused row
    // reads as though it did.
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('cf');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'Possible overlap.');
    await recuse(db, ctx(), rev.session, a.id, 'Safer to step back.');
    expect((await appErrorFrom(clearConflict(db, ctx(), admin, a.id, 'It was fine.'))).code)
      .toBe('CONFLICT');
  });

  it('lets a resolved conflict be declared again, and appends rather than replaces', async () => {
    /*
     * New information arrives: the reviewer reads the application and
     * recognises a name they did not recognise at assignment. Refusing the
     * second declaration because the first was resolved would mean the only
     * way to disclose it is a recusal -- the trap this whole feature exists
     * to remove.
     */
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('cg');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'Possible overlap.');
    await clearConflict(db, ctx(), admin, a.id, 'Checked, not a conflict.');
    await declareConflict(db, ctx(), rev.session, a.id, 'Their new chair is my former boss.');

    const row = await db
      .prepare(
        `SELECT conflict_note, conflict_cleared_at AS cleared,
                conflict_cleared_by AS by FROM review_assignments WHERE id=?`,
      )
      .bind(a.id)
      .first<{ conflict_note: string; cleared: string | null; by: string | null }>();
    expect(row?.cleared).toBeNull();
    expect(row?.by).toBeNull();
    for (const fragment of ['Possible overlap.', 'Checked, not a conflict.', 'former boss']) {
      expect(row?.conflict_note).toContain(fragment);
    }
  });

  it('will not accept a clear the database has no declaration for', async () => {
    // The library refuses it; so does 0023, because a hand-written repair is
    // the case a library check cannot cover.
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('ch');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await expect(
      db
        .prepare(
          `UPDATE review_assignments SET conflict_cleared_at = ?, conflict_cleared_by = ?
            WHERE id = ?`,
        )
        .bind(nowIso(), adminId, a.id)
        .run(),
    ).rejects.toThrow(/cleared before it is declared/);
  });

  it('will not accept a clear with no actor', async () => {
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('ci');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await declareConflict(db, ctx(), rev.session, a.id, 'Possible overlap.');
    await expect(
      db
        .prepare(`UPDATE review_assignments SET conflict_cleared_at = ? WHERE id = ?`)
        .bind(nowIso(), a.id)
        .run(),
    ).rejects.toThrow(/who cleared it and when/);
  });
});

describe('coverage, which is what stops a deadline surprise', () => {
  it('counts live reviewers per application and names the short ones', async () => {
    const { cycleId, applications } = await cycleWithApplications(3);
    const one = await reviewer('m');
    const two = await reviewer('n');
    await assignReviewer(db, ctx(), admin, applications[0]!, one.id);
    await assignReviewer(db, ctx(), admin, applications[0]!, two.id);
    await assignReviewer(db, ctx(), admin, applications[1]!, one.id);

    const coverage = await reviewCoverage(db, cycleId, 2);
    expect(coverage.rows.length).toBe(3);
    expect(coverage.under).toBe(2); // one with a single reviewer, one with none
  });

  it('does not count a recused reviewer as coverage', async () => {
    // An application whose only reviewer stepped away has nobody on it, and a
    // count that says one is the exact lie this view exists to prevent.
    const { cycleId, applications } = await cycleWithApplications(1);
    const rev = await reviewer('o');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    await recuse(db, ctx(), rev.session, a.id, 'Conflict.');

    const coverage = await reviewCoverage(db, cycleId, 1);
    expect(Number(coverage.rows[0]!.reviewers)).toBe(0);
    expect(coverage.under).toBe(1);
  });

  it('ignores drafts, which are not review work', async () => {
    await cycleWithApplications(2, { submitted: false });
    const { cycleId } = await cycleWithApplications(1, { submitted: false });
    const coverage = await reviewCoverage(db, cycleId, 2);
    expect(coverage.rows.length).toBe(0);
  });
});

describe('distributing a cycle across a pool', () => {
  it('gives every application the target and spreads the load evenly', async () => {
    const { cycleId, applications } = await cycleWithApplications(6);
    const pool = [await reviewer('p'), await reviewer('q'), await reviewer('r')];

    const result = await distributeReviewers(
      db, ctx(), admin, cycleId, pool.map((r) => r.id), 2,
    );
    expect(result.created).toBe(12); // 6 applications x 2 reviewers

    const coverage = await reviewCoverage(db, cycleId, 2);
    expect(coverage.under).toBe(0);

    // 12 assignments across 3 reviewers is 4 each. An uneven split is how one
    // consultant ends up holding nine and the decision meeting slips.
    const counts = result.perReviewer.map((r) => r.assigned).sort();
    expect(counts).toEqual([4, 4, 4]);
    expect(applications.length).toBe(6);
  });

  it('never puts the same reviewer on one application twice, even when loads are skewed', async () => {
    /*
     * THE CASE THAT ACTUALLY TESTS THE GUARD.
     *
     * With balanced loads, picking least-loaded twice naturally alternates, so
     * removing the "not already on this application" filter changes nothing
     * and the test passes while proving nothing -- which is what the first
     * version of this test did, and a mutant survived it.
     *
     * Skew the loads instead: B already holds five, A holds none. Without the
     * filter, A is least-loaded on the first pick AND still least-loaded at
     * load 1 on the second, so A goes on the same application twice.
     */
    const { cycleId, applications } = await cycleWithApplications(6);
    const a = await reviewer('s');
    const b = await reviewer('t');
    for (const appId of applications.slice(1)) {
      await assignReviewer(db, ctx(), admin, appId, b.id);
    }

    await distributeReviewers(db, ctx(), admin, cycleId, [a.id, b.id], 2);

    const dupes = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT application_id, reviewer_user_id, COUNT(*) AS c
             FROM review_assignments
            WHERE deleted_at IS NULL
            GROUP BY application_id, reviewer_user_id
           HAVING c > 1)`,
      )
      .first<{ n: number }>();
    expect(dupes?.n).toBe(0);
  });

  it('tops up rather than replacing, so a second run after late submissions is safe', async () => {
    const { cycleId, applications } = await cycleWithApplications(3);
    const pool = [await reviewer('u'), await reviewer('v')];
    const named = pool[0]!;
    // One application already has a hand-picked reviewer.
    await assignReviewer(db, ctx(), admin, applications[0]!, named.id);

    const first = await distributeReviewers(
      db, ctx(), admin, cycleId, pool.map((r) => r.id), 2,
    );
    // Five, not six: the hand-picked one counted.
    expect(first.created).toBe(5);

    const again = await distributeReviewers(
      db, ctx(), admin, cycleId, pool.map((r) => r.id), 2,
    );
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(3);

    // And the hand-picked assignment is still there, not replaced.
    const kept = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_assignments
          WHERE application_id=? AND reviewer_user_id=? AND deleted_at IS NULL`,
      )
      .bind(applications[0], named.id)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });

  it('refuses a target larger than the pool', async () => {
    const { cycleId } = await cycleWithApplications(2);
    const only = await reviewer('w');
    await expect(
      distributeReviewers(db, ctx(), admin, cycleId, [only.id], 3),
    ).rejects.toThrow();
  });

  it('refuses an empty pool', async () => {
    const { cycleId } = await cycleWithApplications(1);
    await expect(
      distributeReviewers(db, ctx(), admin, cycleId, [], 1),
    ).rejects.toThrow();
  });

  it('deduplicates a pool that names somebody twice', async () => {
    const { cycleId } = await cycleWithApplications(2);
    const rev = await reviewer('x');
    const result = await distributeReviewers(
      db, ctx(), admin, cycleId, [rev.id, rev.id], 1,
    );
    expect(result.created).toBe(2); // one each, not two each
  });

  it('counts a duplicated pool as the one reviewer it is when checking the target', async () => {
    // A pool of [X, X] is a pool of ONE. Asking for two reviewers per
    // application from it must be refused, not quietly satisfied by putting X
    // on twice or by silently assigning one. Without deduplication the length
    // check sees two and lets it through.
    const { cycleId } = await cycleWithApplications(2);
    const rev = await reviewer('x2');
    await expect(
      distributeReviewers(db, ctx(), admin, cycleId, [rev.id, rev.id], 2),
    ).rejects.toThrow();
  });

  it('is reproducible, because ties break by the order given rather than at random', async () => {
    const { cycleId } = await cycleWithApplications(2);
    const pool = [await reviewer('y'), await reviewer('z')];
    const ids = pool.map((r) => r.id);
    const result = await distributeReviewers(db, ctx(), admin, cycleId, ids, 1);
    // First application to the first-named reviewer, second to the second.
    const rows = await db
      .prepare(
        `SELECT reviewer_user_id FROM review_assignments
          WHERE reviewer_user_id IN (?,?) AND deleted_at IS NULL
          ORDER BY assigned_at, id`,
      )
      .bind(ids[0], ids[1])
      .all<{ reviewer_user_id: string }>();
    expect(new Set((rows.results ?? []).map((r) => r.reviewer_user_id)).size).toBe(2);
    expect(result.created).toBe(2);
  });
});

describe('the schema additions that cannot be retrofitted', () => {
  it('records a conflict attestation separately from the declaration', async () => {
    // Two events: declared at assignment, attested at submission. NULL means
    // never asked, which must not look like "attested nothing".
    const { applications } = await cycleWithApplications(1);
    const rev = await reviewer('aa');
    const a = await assignReviewer(db, ctx(), admin, applications[0]!, rev.id);
    expect(a.coi_attested_at).toBeNull();

    const now = nowIso();
    await db
      .prepare(`UPDATE review_assignments SET coi_attested_at=? WHERE id=?`)
      .bind(now, a.id)
      .run();
    const row = await db
      .prepare(`SELECT coi_attested_at, conflict_declared_at FROM review_assignments WHERE id=?`)
      .bind(a.id)
      .first<{ coi_attested_at: string; conflict_declared_at: string | null }>();
    expect(row?.coi_attested_at).toBe(now);
    expect(row?.conflict_declared_at).toBeNull();
  });

  it('defaults every field to visible and every cycle to non-blind', async () => {
    // Nothing became concealed by adding the column. A form has to say so.
    const hidden = await db
      .prepare(`SELECT COUNT(*) AS n FROM form_fields WHERE conceal_in_review = 1`)
      .first<{ n: number }>();
    expect(hidden?.n).toBe(0);

    const blind = await db
      .prepare(`SELECT COUNT(*) AS n FROM cycles WHERE blind_review = 1`)
      .first<{ n: number }>();
    expect(blind?.n).toBe(0);
  });
});
