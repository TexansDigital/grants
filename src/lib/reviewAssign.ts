/**
 * Putting applications in front of reviewers, and recording conflicts.
 *
 * SCORING IS NOT HERE. This is everything that can be built before a rubric
 * exists, which is most of it: who reviews what, who declared a conflict, who
 * recused, and whether every application has enough eyes on it. Scoring waits
 * for the Foundation's criteria, because building it against a guessed rubric
 * means building it twice.
 *
 * THREE ASSIGNMENT MECHANISMS, because grant managers expect all three:
 *   - name a reviewer for an application
 *   - remove one
 *   - distribute a cycle across a pool, N reviewers per application
 *
 * The third is the one every platform copies, and the one that makes a
 * deadline survivable. It is also where the mistakes are, so see the notes on
 * `distributeReviewers` below.
 *
 * CONFLICT OF INTEREST IS TWO EVENTS. Declaration at assignment, attestation at
 * submission. 0015 adds the second; the first was already here. A conflict that
 * arises in the six weeks between the two is the case the single-event design
 * cannot see.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { auditStatement } from './audit';
import { newId } from './ids';
import { nowIso } from './time';

/** Reviewers per application when the caller does not say. */
export const DEFAULT_REVIEWERS_PER_APPLICATION = 2;

/**
 * The most a single distribution will create.
 *
 * 400 applications at 3 reviewers is 1,200 rows, and D1 batches have limits.
 * A cycle larger than this is a data problem worth looking at before it is an
 * assignment problem.
 */
export const MAX_ASSIGNMENTS_PER_RUN = 1_200;

export interface AssignmentRow {
  // Indexed, because the audit helper takes a Record<string, unknown> for its
  // before/after snapshots and a named interface without an index signature is
  // not assignable to one. Naming the fields is still worth it: every read
  // below is checked, and a typo in a column name is a compile error.
  [key: string]: unknown;
  id: string;
  application_id: string;
  reviewer_user_id: string;
  assigned_at: string;
  conflict_declared_at: string | null;
  conflict_note: string | null;
  recused_at: string | null;
  recused_reason: string | null;
  completed_at: string | null;
  coi_attested_at: string | null;
}

async function liveReviewer(db: D1Database, userId: string): Promise<{ id: string; email: string }> {
  const row = await db
    .prepare(
      `SELECT id, email FROM users
        WHERE id = ? AND deleted_at IS NULL AND is_active = 1
          AND role IN ('reviewer','admin')`,
    )
    .bind(userId)
    .first<{ id: string; email: string }>();
  // 404 rather than a message naming what was wrong: an applicant id, an
  // inactive account and a grantee all answer the same, so this cannot be used
  // to ask who has an account.
  if (!row) throw notFound('reviewer');
  return row;
}

async function liveApplication(
  db: D1Database,
  applicationId: string,
): Promise<{ id: string; cycle_id: string; submitted_at: string | null }> {
  const row = await db
    .prepare(
      `SELECT id, cycle_id, submitted_at FROM applications
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(applicationId)
    .first<{ id: string; cycle_id: string; submitted_at: string | null }>();
  if (!row) throw notFound('application');
  return row;
}

/**
 * Assign one reviewer to one application.
 *
 * IDEMPOTENT ON THE LIVE PAIR. Assigning somebody who is already assigned
 * returns the existing row rather than creating a second one — a double-click
 * on a slow connection must not put an application in a reviewer's list twice,
 * and a UNIQUE constraint would turn that double-click into an error the admin
 * has to interpret.
 *
 * A RECUSED ASSIGNMENT DOES NOT BLOCK A NEW ONE. Recusal is a historical fact
 * that stays on the record; if the conflict is resolved and the admin assigns
 * the same person again, that is a new assignment with its own audit trail.
 */
export async function assignReviewer(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  reviewerUserId: string,
): Promise<AssignmentRow> {
  const application = await liveApplication(db, applicationId);
  // An unsubmitted application is still a draft belonging to the applicant.
  // Putting a draft in front of a reviewer shows them work nobody has chosen
  // to submit yet.
  if (application.submitted_at === null) {
    throw new AppError('CONFLICT', 'That application has not been submitted yet.', {
      internalMessage: `assignment attempted on unsubmitted application ${applicationId}`,
      severity: 'warn',
    });
  }
  await liveReviewer(db, reviewerUserId);

  const existing = await db
    .prepare(
      `SELECT * FROM review_assignments
        WHERE application_id = ? AND reviewer_user_id = ?
          AND recused_at IS NULL AND deleted_at IS NULL`,
    )
    .bind(applicationId, reviewerUserId)
    .first<AssignmentRow>();
  if (existing) return existing;

  const id = newId();
  const now = nowIso();
  const after = {
    id,
    application_id: applicationId,
    reviewer_user_id: reviewerUserId,
    assigned_at: now,
    assigned_by: session.userId,
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO review_assignments
           (id, application_id, reviewer_user_id, assigned_at, assigned_by,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(id, applicationId, reviewerUserId, now, session.userId, now, now),
    auditStatement(db, ctx, {
      action: 'review.assigned',
      entityType: 'review_assignment',
      entityId: id,
      after,
    }),
  ]);

  return {
    ...after,
    conflict_declared_at: null,
    conflict_note: null,
    recused_at: null,
    recused_reason: null,
    completed_at: null,
    coi_attested_at: null,
  } as AssignmentRow;
}

/**
 * Take an assignment back.
 *
 * SOFT, like everything else here. An assignment that was made and withdrawn is
 * part of how a decision was reached, and non-negotiable #7 does not have an
 * exception for rows that turned out to be mistakes.
 *
 * REFUSES ONCE SCORES EXIST. Removing an assignment that has scores attached
 * would orphan them: the scores would still be in the database, counted by
 * nothing and explicable by nobody. Recusal is the right verb there, and it
 * keeps the reason.
 */
export async function unassignReviewer(
  db: D1Database,
  ctx: RequestContext,
  _session: Session,
  assignmentId: string,
): Promise<void> {
  const before = await db
    .prepare(`SELECT * FROM review_assignments WHERE id = ? AND deleted_at IS NULL`)
    .bind(assignmentId)
    .first<AssignmentRow>();
  if (!before) throw notFound('assignment');

  const scored = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM review_scores
        WHERE review_assignment_id = ? AND deleted_at IS NULL`,
    )
    .bind(assignmentId)
    .first<{ n: number }>();
  if ((scored?.n ?? 0) > 0) {
    throw new AppError(
      'CONFLICT',
      'That reviewer has already scored this application. Record a recusal instead, which keeps the reason.',
      {
        internalMessage: `unassign refused: assignment ${assignmentId} has ${scored?.n} scores`,
        severity: 'warn',
      },
    );
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE review_assignments SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(now, now, assignmentId),
    auditStatement(
      db,
      ctx,
      {
        action: 'review.unassigned',
        entityType: 'review_assignment',
        entityId: assignmentId,
        before,
        after: { ...before, deleted_at: now },
      },
      {
        /*
         * Guards on the value just WRITTEN, not on the precondition.
         *
         * This first read `deleted_at IS NULL`, which is true before the
         * UPDATE in the same batch and false after it -- so the audit row was
         * never written at all, and a withdrawn assignment left no trace. The
         * declaration and recusal guards below had it right; this one was
         * copied from the wrong half of the pattern.
         *
         * Caught by asserting the audit row exists rather than assuming it.
         */
        guard: {
          sql: `EXISTS (SELECT 1 FROM review_assignments WHERE id = ? AND deleted_at = ?)`,
          binds: [assignmentId, now],
        },
      },
    ),
  ]);
}

/**
 * Declare a conflict of interest on an assignment.
 *
 * DECLARING IS NOT RECUSING. A reviewer may sit on a nonprofit's board and
 * still be the right person to read an unrelated application, and that judgment
 * belongs to an admin looking at the note — not to whoever wrote this code.
 * Recusal is a separate, deliberate act with its own verb.
 *
 * A declaration is not editable. A second declaration on the same assignment is
 * refused rather than overwriting the first: the sequence of what was disclosed
 * and when is the part an auditor reads.
 */
export async function declareConflict(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  assignmentId: string,
  note: string,
): Promise<void> {
  const text = note.trim();
  if (text.length < 3) {
    throw new AppError('VALIDATION_FAILED', 'Please say what the conflict is.', {
      internalMessage: 'conflict declared with an empty or near-empty note',
      severity: 'warn',
    });
  }

  const before = await db
    .prepare(`SELECT * FROM review_assignments WHERE id = ? AND deleted_at IS NULL`)
    .bind(assignmentId)
    .first<AssignmentRow>();
  if (!before) throw notFound('assignment');
  // Only the reviewer it belongs to, or an admin recording what they were told.
  if (before.reviewer_user_id !== session.userId && session.role !== 'admin') {
    throw notFound('assignment');
  }
  if (before.conflict_declared_at !== null) {
    throw new AppError('CONFLICT', 'A conflict has already been declared on this assignment.', {
      internalMessage: `second declaration on assignment ${assignmentId}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE review_assignments
            SET conflict_note = ?, conflict_declared_at = ?, updated_at = ?
          WHERE id = ? AND conflict_declared_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(text, now, now, assignmentId),
    auditStatement(
      db,
      ctx,
      {
        action: 'review.conflict_declared',
        entityType: 'review_assignment',
        entityId: assignmentId,
        before,
        after: { ...before, conflict_note: text, conflict_declared_at: now },
      },
      {
        guard: {
          sql: `EXISTS (SELECT 1 FROM review_assignments
                         WHERE id = ? AND conflict_declared_at = ? AND deleted_at IS NULL)`,
          binds: [assignmentId, now],
        },
      },
    ),
  ]);
}

/**
 * Step away from an assignment, with a reason.
 *
 * The reason is required by the schema, not only here: "recused" with no reason
 * is a gap in the audit trail exactly where somebody will look.
 */
export async function recuse(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  assignmentId: string,
  reason: string,
): Promise<void> {
  const text = reason.trim();
  if (text.length < 3) {
    throw new AppError('VALIDATION_FAILED', 'Please say why.', {
      internalMessage: 'recusal with an empty or near-empty reason',
      severity: 'warn',
    });
  }

  const before = await db
    .prepare(`SELECT * FROM review_assignments WHERE id = ? AND deleted_at IS NULL`)
    .bind(assignmentId)
    .first<AssignmentRow>();
  if (!before) throw notFound('assignment');
  if (before.reviewer_user_id !== session.userId && session.role !== 'admin') {
    throw notFound('assignment');
  }
  if (before.recused_at !== null) return; // Already stepped away. Not an error.

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE review_assignments SET recused_at = ?, recused_reason = ?, updated_at = ?
          WHERE id = ? AND recused_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(now, text, now, assignmentId),
    auditStatement(
      db,
      ctx,
      {
        action: 'review.recused',
        entityType: 'review_assignment',
        entityId: assignmentId,
        before,
        after: { ...before, recused_at: now, recused_reason: text },
      },
      {
        guard: {
          sql: `EXISTS (SELECT 1 FROM review_assignments
                         WHERE id = ? AND recused_at = ? AND deleted_at IS NULL)`,
          binds: [assignmentId, now],
        },
      },
    ),
  ]);
}

// ---------------------------------------------------------------------------

export interface CoverageRow {
  application_id: string;
  project_title: string | null;
  organization_name: string | null;
  reviewers: number;
  conflicts: number;
  completed: number;
}

export interface Coverage {
  cycleId: string;
  target: number;
  rows: CoverageRow[];
  /** Applications with fewer live reviewers than the target. */
  under: number;
}

/**
 * Who is covering what, for a whole cycle.
 *
 * A SEPARATE VIEW, not a filter on the reviewer's own list. The mistake this
 * exists to prevent is shipping the reviewer's worklist and forgetting the
 * admin's coverage grid — and then discovering at the deadline that six
 * applications have one reviewer and two have four.
 *
 * Counts LIVE assignments: recused and withdrawn ones are history, and an
 * application whose only reviewer recused has zero coverage, not one.
 */
export async function reviewCoverage(
  db: D1Database,
  cycleId: string,
  target: number = DEFAULT_REVIEWERS_PER_APPLICATION,
): Promise<Coverage> {
  const { results } = await db
    .prepare(
      `SELECT a.id AS application_id,
              a.project_title,
              o.legal_name AS organization_name,
              COUNT(ra.id) AS reviewers,
              COALESCE(SUM(CASE WHEN ra.conflict_declared_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS conflicts,
              COALESCE(SUM(CASE WHEN ra.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed
         FROM applications a
         LEFT JOIN organizations o ON o.id = a.organization_id
         LEFT JOIN review_assignments ra
                ON ra.application_id = a.id
               AND ra.recused_at IS NULL
               AND ra.deleted_at IS NULL
        WHERE a.cycle_id = ?
          AND a.deleted_at IS NULL
          AND a.submitted_at IS NOT NULL
        GROUP BY a.id
        ORDER BY reviewers ASC, a.submitted_at ASC`,
    )
    .bind(cycleId)
    .all<CoverageRow>();

  const rows = results ?? [];
  return {
    cycleId,
    target,
    rows,
    under: rows.filter((r) => Number(r.reviewers) < target).length,
  };
}

export interface DistributionResult {
  created: number;
  skipped: number;
  applications: number;
  perReviewer: { reviewerUserId: string; assigned: number }[];
}

/**
 * Spread a cycle's submitted applications across a pool of reviewers.
 *
 * THE RULES, each of which is a way this goes wrong:
 *
 *   EVEN LOAD. Reviewers are picked least-loaded-first, counting what they
 *   already hold in this cycle. Assigning at random without counting gives one
 *   consultant nine applications and another two, and the one with nine is the
 *   reason the decision meeting slips.
 *
 *   NEVER THE SAME REVIEWER TWICE on one application. Obvious, and the reason
 *   the pool is filtered per application rather than globally.
 *
 *   TOP UP, DO NOT REPLACE. An application that already has two reviewers when
 *   the target is two is left alone. Running this twice is safe, which matters
 *   because the first run happens before the deadline and the second after the
 *   late submissions land.
 *
 *   EXISTING CONFLICTS COUNT AS COVERAGE, deliberately. A declared conflict is
 *   not automatically a recusal — that judgment is an admin's — so a reviewer
 *   who has declared still holds the assignment until somebody decides.
 *
 * NOT RANDOM, despite that being the common name for this. Ties break by a
 * stable order, so the same inputs give the same output and a test can assert
 * what happened. Randomness here buys nothing and costs reproducibility.
 */
export async function distributeReviewers(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  cycleId: string,
  reviewerUserIds: string[],
  target: number = DEFAULT_REVIEWERS_PER_APPLICATION,
): Promise<DistributionResult> {
  if (reviewerUserIds.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Choose at least one reviewer.', {
      internalMessage: 'distribute called with an empty pool',
      severity: 'warn',
    });
  }
  /*
   * DEDUPLICATE FIRST, then check the target against the real size.
   *
   * The other order let a pool of [X, X] pass as two reviewers: the length
   * check saw 2, and the run then quietly assigned ONE reviewer per
   * application while reporting success. An admin asking for two pairs of eyes
   * on every application would have got one, and nothing would have said so.
   */
  const pool = [...new Set(reviewerUserIds)];
  if (target < 1 || target > pool.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Cannot put ${target} reviewers on each application from a pool of ${pool.length}.`,
      { internalMessage: `target ${target} exceeds deduplicated pool ${pool.length}`, severity: 'warn' },
    );
  }
  for (const id of pool) await liveReviewer(db, id);

  const coverage = await reviewCoverage(db, cycleId, target);
  if (coverage.rows.length === 0) {
    return { created: 0, skipped: 0, applications: 0, perReviewer: [] };
  }

  // Who already holds what in this cycle, so load is counted from reality
  // rather than from this run alone.
  const { results: held } = await db
    .prepare(
      `SELECT ra.reviewer_user_id, ra.application_id
         FROM review_assignments ra
         JOIN applications a ON a.id = ra.application_id
        WHERE a.cycle_id = ? AND a.deleted_at IS NULL
          AND ra.recused_at IS NULL AND ra.deleted_at IS NULL`,
    )
    .bind(cycleId)
    .all<{ reviewer_user_id: string; application_id: string }>();

  const load = new Map<string, number>(pool.map((id) => [id, 0]));
  const alreadyOn = new Map<string, Set<string>>();
  for (const row of held ?? []) {
    load.set(row.reviewer_user_id, (load.get(row.reviewer_user_id) ?? 0) + 1);
    const set = alreadyOn.get(row.application_id) ?? new Set<string>();
    set.add(row.reviewer_user_id);
    alreadyOn.set(row.application_id, set);
  }

  const planned: { applicationId: string; reviewerUserId: string }[] = [];
  let skipped = 0;

  for (const row of coverage.rows) {
    const have = Number(row.reviewers);
    if (have >= target) {
      skipped += 1;
      continue;
    }
    const on = alreadyOn.get(row.application_id) ?? new Set<string>();
    const wanted = target - have;

    for (let i = 0; i < wanted; i += 1) {
      const candidate = pool
        .filter((id) => !on.has(id))
        // Least loaded first; ties by the order the caller gave, which makes
        // the whole run reproducible.
        .sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || pool.indexOf(a) - pool.indexOf(b))[0];
      // The pool is exhausted for this application: everybody available is
      // already on it. Not an error, and not a reason to abandon the run.
      if (candidate === undefined) break;
      on.add(candidate);
      load.set(candidate, (load.get(candidate) ?? 0) + 1);
      planned.push({ applicationId: row.application_id, reviewerUserId: candidate });
    }
    alreadyOn.set(row.application_id, on);
  }

  if (planned.length > MAX_ASSIGNMENTS_PER_RUN) {
    throw new AppError(
      'VALIDATION_FAILED',
      `That would create ${planned.length} assignments in one go. Narrow the cycle or the pool.`,
      { internalMessage: `distribution of ${planned.length} exceeds the cap`, severity: 'warn' },
    );
  }

  const now = nowIso();
  const statements = planned.flatMap(({ applicationId, reviewerUserId }) => {
    const id = newId();
    const after = {
      id,
      application_id: applicationId,
      reviewer_user_id: reviewerUserId,
      assigned_at: now,
      assigned_by: session.userId,
      via: 'distribution',
    };
    return [
      db
        .prepare(
          `INSERT INTO review_assignments
             (id, application_id, reviewer_user_id, assigned_at, assigned_by,
              created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(id, applicationId, reviewerUserId, now, session.userId, now, now),
      auditStatement(db, ctx, {
        action: 'review.assigned',
        entityType: 'review_assignment',
        entityId: id,
        after,
      }),
    ];
  });

  if (statements.length > 0) await db.batch(statements);

  return {
    created: planned.length,
    skipped,
    applications: coverage.rows.length,
    perReviewer: pool.map((id) => ({ reviewerUserId: id, assigned: load.get(id) ?? 0 })),
  };
}
