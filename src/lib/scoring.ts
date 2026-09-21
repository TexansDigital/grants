/**
 * A reviewer scoring one application against the cycle's rubric.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER WRITE PATH. The thing being
 * written is the input to a funding decision, and the people writing it are
 * the least-privileged accounts in the system -- including outside consultants
 * hired for a single cycle. So two questions are answered in SQL, on every
 * call, and never by a role check or by trusting an id in a URL:
 *
 *   1. Is this assignment THIS reviewer's? Anyone else's is a 404.
 *   2. Is the criterion part of the rubric attached to THIS application's
 *      cycle? 0006 refuses anything else at the database, and this refuses it
 *      earlier with a message a person can act on.
 *
 * REVIEWERS NEVER SEE EACH OTHER'S SCORES. CLAUDE.md's access table is
 * explicit, and the enforcement is that no reviewer-reachable query selects
 * another assignment's rows at all -- not a filter in the UI, not a column
 * dropped at serialization. The comparison view is admin-only and lives in its
 * own function below.
 *
 * WEIGHTED TOTALS ARE INTEGERS. A total is SUM(score * weight_bp) in
 * score-basis-points, exactly as rubrics.ts builds the ceiling, divided by
 * 10000 only for display. Three criteria weighted a third each in floats give
 * two identical applications different totals.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { WEIGHT_ONE_BP } from './rubrics';

export interface ScoringCriterion {
  id: string;
  criterion_key: string;
  label: string;
  description: string | null;
  weight_bp: number;
  max_score: number;
  sort_order: number;
  /** This reviewer's own score, or null. Never anybody else's. */
  score: number | null;
  comment: string | null;
}

export interface ScoringSheet {
  assignmentId: string;
  applicationId: string;
  projectTitle: string | null;
  organizationName: string;
  rubric: { id: string; name: string; version: number; maxTotalScoreBp: number };
  criteria: ScoringCriterion[];
  /** SUM(score * weight_bp) over what is scored so far. */
  totalSoFarBp: number;
  completedAt: string | null;
  /** Set when this reviewer disclosed a conflict and nobody has acted on it. */
  conflictDeclaredAt: string | null;
  /** False once the application is decided: a settled decision is not rescored. */
  editable: boolean;
}

interface AssignmentContext {
  assignmentId: string;
  applicationId: string;
  reviewerUserId: string;
  completedAt: string | null;
  conflictDeclaredAt: string | null;
  decidedAt: string | null;
  rubricId: string | null;
  projectTitle: string | null;
  organizationName: string;
}

/**
 * Load the assignment this session is allowed to act on.
 *
 * ONE QUERY, and the reviewer's own id is a bind in it rather than a
 * comparison afterwards. A load-then-check shape is the one that gets
 * refactored into a load that forgets to check.
 *
 * An ADMIN may load any assignment -- recording a score a consultant phoned in
 * is ordinary work, and the audit row names who actually typed it.
 */
async function loadAssignment(
  db: D1Database,
  session: Session,
  assignmentId: string,
): Promise<AssignmentContext> {
  const mine = session.role === 'admin' ? '' : 'AND ra.reviewer_user_id = ?';
  const binds: unknown[] = [assignmentId];
  if (session.role !== 'admin') binds.push(session.userId);

  const row = await db
    .prepare(
      `SELECT ra.id AS assignmentId, ra.application_id AS applicationId,
              ra.reviewer_user_id AS reviewerUserId,
              ra.completed_at AS completedAt,
              ra.conflict_declared_at AS conflictDeclaredAt,
              a.decided_at AS decidedAt, a.project_title AS projectTitle,
              c.rubric_id AS rubricId,
              o.legal_name AS organizationName
         FROM review_assignments ra
         JOIN applications a   ON a.id = ra.application_id AND a.deleted_at IS NULL
         JOIN cycles c         ON c.id = a.cycle_id
         JOIN organizations o  ON o.id = a.organization_id
        WHERE ra.id = ?
          ${mine}
          AND ra.recused_at IS NULL
          AND ra.deleted_at IS NULL`,
    )
    .bind(...binds)
    .first<AssignmentContext>();
  // 404, never 403. A reviewer walking assignment ids learns nothing about
  // which applications exist or who else is reviewing them.
  if (!row) throw notFound('assignment');
  return row;
}

export async function loadScoringSheet(
  db: D1Database,
  session: Session,
  assignmentId: string,
): Promise<ScoringSheet> {
  const a = await loadAssignment(db, session, assignmentId);
  if (!a.rubricId) {
    throw new AppError('CONFLICT', 'This cycle has no scoring rubric yet.', {
      internalMessage: `assignment ${assignmentId} on a cycle with no rubric`,
      severity: 'warn',
    });
  }

  const rubric = await db
    .prepare(
      `SELECT id, name, version, max_total_score AS maxTotalScoreBp
         FROM rubrics WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(a.rubricId)
    .first<{ id: string; name: string; version: number; maxTotalScoreBp: number }>();
  if (!rubric) throw notFound('rubric');

  /*
   * THE JOIN CARRIES THE ASSIGNMENT ID. Selecting every score for these
   * criteria and filtering in the caller would put other reviewers' numbers
   * into this function's memory, one careless serialization away from the
   * wire. They are never fetched.
   */
  const { results: criteria } = await db
    .prepare(
      `SELECT rc.id, rc.criterion_key, rc.label, rc.description,
              rc.weight_bp, rc.max_score, rc.sort_order,
              rs.score, rs.comment
         FROM rubric_criteria rc
         LEFT JOIN review_scores rs
           ON rs.rubric_criterion_id = rc.id
          AND rs.review_assignment_id = ?
          AND rs.deleted_at IS NULL
        WHERE rc.rubric_id = ? AND rc.deleted_at IS NULL
        ORDER BY rc.sort_order, rc.criterion_key`,
    )
    .bind(assignmentId, a.rubricId)
    .all<ScoringCriterion>();

  const rows = criteria ?? [];
  return {
    assignmentId: a.assignmentId,
    applicationId: a.applicationId,
    projectTitle: a.projectTitle,
    organizationName: a.organizationName,
    rubric,
    criteria: rows,
    totalSoFarBp: rows.reduce((t, c) => t + (c.score ?? 0) * c.weight_bp, 0),
    completedAt: a.completedAt,
    conflictDeclaredAt: a.conflictDeclaredAt,
    // `completedAt` belongs here too: a submitted review is not editable
    // until it is reopened, and omitting it let the UI offer inputs the API
    // now refuses.
    editable:
      a.decidedAt === null && a.conflictDeclaredAt === null && a.completedAt === null,
  };
}

export interface ScoreInput {
  criterionId: string;
  /** null clears a score, which is not the same as zero. */
  score: number | null;
  comment?: string | null;
}

/**
 * Save some or all of this reviewer's scores.
 *
 * PARTIAL SAVES ARE NORMAL. A reviewer reads a forty-field application over an
 * hour and scores as they go. Requiring the whole sheet at once would mean
 * losing an hour to a closed laptop, which is the same reason the application
 * form autosaves.
 *
 * A NULL SCORE CLEARS, and is not zero. Zero is a judgement -- "this
 * application does nothing on this criterion" -- and an unscored criterion is
 * the absence of one. Collapsing them would let an unfinished review look
 * complete and drag a weighted total down with scores nobody gave.
 */
export async function saveScores(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  assignmentId: string,
  scores: ScoreInput[],
): Promise<{ assignmentId: string; saved: number; totalSoFarBp: number }> {
  const a = await loadAssignment(db, session, assignmentId);
  if (a.decidedAt) {
    throw new AppError('CONFLICT', 'This application has already been decided.', {
      internalMessage: `saveScores on decided application ${a.applicationId}`,
      severity: 'warn',
    });
  }
  if (a.completedAt) {
    /*
     * A SUBMITTED REVIEW CANNOT BE REWRITTEN WITHOUT REOPENING IT, and this
     * check was missing.
     *
     * `reopenReview` and its `review.reopened` audit action existed and were
     * decorative: a reviewer -- or an admin importing a scorecard -- could
     * overwrite every score on a completed review, the total would change, and
     * `completed_at` would still read as submitted. The audit trail would show
     * scores saved after a completion with nothing marking the review as
     * having been taken back.
     */
    throw new AppError('CONFLICT', 'This review has been submitted. Reopen it to change it.', {
      internalMessage: `saveScores on completed assignment ${assignmentId}`,
      severity: 'warn',
    });
  }
  if (a.conflictDeclaredAt) {
    /*
     * A DISCLOSED CONFLICT STOPS SCORING until somebody acts on it.
     *
     * CLAUDE.md puts disclosure at assignment rather than at scoring because
     * "a conflict discovered while scoring has already contaminated the
     * score". The same reasoning applies after the fact: once a reviewer has
     * said there is a conflict, a score they then enter is exactly what that
     * rule exists to prevent. The admin's move is to recuse them or to
     * reassign, both of which are recorded.
     */
    throw new AppError('CONFLICT', 'You declared a conflict on this application.', {
      internalMessage: `saveScores with an unresolved conflict on ${assignmentId}`,
      severity: 'warn',
    });
  }

  if (!a.rubricId) throw notFound('rubric');

  // Every criterion named, checked against THIS cycle's rubric, in one query.
  // 0006 has a trigger for the same rule; this reaches the reviewer as a
  // message rather than as an INTERNAL error from a RAISE(ABORT).
  const ids = [...new Set(scores.map((s) => s.criterionId))];
  if (ids.length === 0) {
    return { assignmentId, saved: 0, totalSoFarBp: (await loadScoringSheet(db, session, assignmentId)).totalSoFarBp };
  }
  const { results: known } = await db
    .prepare(
      `SELECT id, max_score FROM rubric_criteria
        WHERE rubric_id = ? AND deleted_at IS NULL
          AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(a.rubricId, ...ids)
    .all<{ id: string; max_score: number }>();
  const byId = new Map((known ?? []).map((r) => [r.id, r]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw new AppError('VALIDATION_FAILED', 'That is not a criterion on this rubric.', {
        internalMessage: `score for criterion ${id} outside rubric ${a.rubricId}`,
        severity: 'warn',
      });
    }
  }

  const now = nowIso();
  const statements = [];
  for (const s of scores) {
    const criterion = byId.get(s.criterionId)!;
    if (s.score === null) {
      statements.push(
        db
          .prepare(
            `UPDATE review_scores SET deleted_at = ?, updated_at = ?
              WHERE review_assignment_id = ? AND rubric_criterion_id = ?
                AND deleted_at IS NULL`,
          )
          .bind(now, now, assignmentId, s.criterionId),
      );
      continue;
    }
    if (!Number.isInteger(s.score) || s.score < 0 || s.score > criterion.max_score) {
      throw new AppError(
        'VALIDATION_FAILED',
        `A score has to be a whole number between 0 and ${criterion.max_score}.`,
        {
          internalMessage: `score ${s.score} outside 0..${criterion.max_score}`,
          severity: 'warn',
        },
      );
    }
    const comment = (s.comment ?? '')?.toString().trim() || null;
    /*
     * UPDATE then INSERT-WHERE-NOT-EXISTS, rather than INSERT OR REPLACE.
     *
     * OR REPLACE deletes the existing row and inserts a new one, which changes
     * its id, drops its created_at and fires the DELETE triggers. This schema
     * has been bitten by that before -- see regressions.test.ts, "append-only
     * survives INSERT OR REPLACE". Two statements in one batch, and the
     * partial unique index makes the second a no-op when the first matched.
     */
    statements.push(
      db
        .prepare(
          `UPDATE review_scores SET score = ?, comment = ?, scored_at = ?, updated_at = ?
            WHERE review_assignment_id = ? AND rubric_criterion_id = ? AND deleted_at IS NULL`,
        )
        .bind(s.score, comment, now, now, assignmentId, s.criterionId),
      db
        .prepare(
          `INSERT INTO review_scores (id, review_assignment_id, rubric_criterion_id,
             score, comment, scored_at, created_at, updated_at)
           SELECT ?,?,?,?,?,?,?,?
            WHERE NOT EXISTS (
              SELECT 1 FROM review_scores
               WHERE review_assignment_id = ? AND rubric_criterion_id = ?
                 AND deleted_at IS NULL
            )`,
        )
        .bind(
          newId(), assignmentId, s.criterionId, s.score, comment, now, now, now,
          assignmentId, s.criterionId,
        ),
    );
  }

  statements.push(
    auditStatement(db, ctx, {
      action: 'review.score_saved',
      entityType: 'review_assignment',
      entityId: assignmentId,
      after: {
        application_id: a.applicationId,
        reviewer_user_id: a.reviewerUserId,
        // The actor is the person who typed it, which is not always the
        // reviewer: an admin may be recording a consultant's scorecard.
        actor_user_id: session.userId,
        criteria: scores.length,
      },
    }),
  );

  await db.batch(statements);
  const sheet = await loadScoringSheet(db, session, assignmentId);
  return { assignmentId, saved: scores.length, totalSoFarBp: sheet.totalSoFarBp };
}

/**
 * Mark this review finished.
 *
 * EVERY CRITERION MUST CARRY A SCORE. A review submitted with three of five
 * criteria blank produces a weighted total that is lower than the reviewer
 * meant and looks like a judgement rather than an omission -- and it is
 * compared directly against colleagues who filled all five.
 */
export async function completeReview(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  assignmentId: string,
): Promise<{ assignmentId: string; completedAt: string; totalBp: number }> {
  const sheet = await loadScoringSheet(db, session, assignmentId);
  if (sheet.completedAt) {
    throw new AppError('CONFLICT', 'This review is already submitted.', {
      internalMessage: `completeReview on already-complete ${assignmentId}`,
      severity: 'warn',
    });
  }
  if (!sheet.editable) {
    throw new AppError('CONFLICT', 'This review can no longer be changed.', {
      internalMessage: `completeReview on a decided or conflicted assignment ${assignmentId}`,
      severity: 'warn',
    });
  }
  const missing = sheet.criteria.filter((c) => c.score === null);
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Every criterion needs a score before you can submit.',
      {
        internalMessage: `completeReview with ${missing.length} unscored criteria`,
        severity: 'warn',
        fieldErrors: missing.map((c) => ({
          field: c.criterion_key,
          message: `${c.label} has not been scored.`,
        })),
      },
    );
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE review_assignments SET completed_at = ?, updated_at = ?
          WHERE id = ? AND completed_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(now, now, assignmentId),
    auditStatement(db, ctx, {
      action: 'review.completed',
      entityType: 'review_assignment',
      entityId: assignmentId,
      before: { completed_at: null },
      after: {
        completed_at: now,
        application_id: sheet.applicationId,
        total_bp: sheet.totalSoFarBp,
        actor_user_id: session.userId,
      },
    }),
  ]);

  return { assignmentId, completedAt: now, totalBp: sheet.totalSoFarBp };
}

/**
 * Let a reviewer reopen their own submitted review.
 *
 * ONLY WHILE THE APPLICATION IS UNDECIDED. A reviewer who realises at 9pm that
 * they misread a budget should not have to find an admin, and the alternative
 * -- a review nobody can correct -- means the wrong number goes into the
 * decision. Once the decision is made the record is settled and this refuses.
 */
export async function reopenReview(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  assignmentId: string,
): Promise<{ assignmentId: string }> {
  const a = await loadAssignment(db, session, assignmentId);
  if (a.decidedAt) {
    throw new AppError('CONFLICT', 'This application has already been decided.', {
      internalMessage: `reopenReview on decided application ${a.applicationId}`,
      severity: 'warn',
    });
  }
  if (!a.completedAt) {
    throw new AppError('CONFLICT', 'This review has not been submitted.', {
      internalMessage: `reopenReview on an open review ${assignmentId}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE review_assignments SET completed_at = NULL, updated_at = ?
          WHERE id = ? AND completed_at IS NOT NULL AND deleted_at IS NULL`,
      )
      .bind(now, assignmentId),
    auditStatement(db, ctx, {
      action: 'review.reopened',
      entityType: 'review_assignment',
      entityId: assignmentId,
      before: { completed_at: a.completedAt },
      after: { completed_at: null, actor_user_id: session.userId },
    }),
  ]);
  return { assignmentId };
}

// ---------------------------------------------------------------------------
// Admin: what the reviewers said
// ---------------------------------------------------------------------------

export interface ReviewerTotal {
  assignmentId: string;
  reviewerUserId: string;
  reviewerEmail: string;
  completedAt: string | null;
  totalBp: number;
  scored: number;
  criteriaCount: number;
}

export interface ScoreSummary {
  applicationId: string;
  rubric: { id: string; name: string; version: number; maxTotalScoreBp: number } | null;
  reviewers: ReviewerTotal[];
  /** Mean of COMPLETED reviews only, in score-basis-points. Null if none. */
  meanCompletedBp: number | null;
  /** Per-criterion, per-reviewer, for the side-by-side read. */
  byCriterion: {
    criterionId: string;
    label: string;
    maxScore: number;
    weightBp: number;
    scores: { assignmentId: string; score: number | null; comment: string | null }[];
  }[];
}

/**
 * Every reviewer's scores on one application, side by side.
 *
 * ADMIN ONLY, and the caller is responsible for saying so -- the route
 * declares `ADMIN_ONLY` and this function refuses anything else, because a
 * function this shape is exactly the one somebody reuses from a reviewer
 * endpoint later.
 *
 * ONLY COMPLETED REVIEWS COUNT TOWARD THE MEAN. A half-finished sheet has a
 * low total because it is half finished, and averaging it in makes an
 * application look weak for a reason that has nothing to do with it.
 */
export async function scoreSummary(
  db: D1Database,
  session: Session,
  applicationId: string,
): Promise<ScoreSummary> {
  if (session.role !== 'admin') throw notFound('application');

  const app = await db
    .prepare(
      `SELECT a.id, c.rubric_id AS rubricId FROM applications a
         JOIN cycles c ON c.id = a.cycle_id
        WHERE a.id = ? AND a.deleted_at IS NULL`,
    )
    .bind(applicationId)
    .first<{ id: string; rubricId: string | null }>();
  if (!app) throw notFound('application');

  const rubric = app.rubricId
    ? await db
        .prepare(
          `SELECT id, name, version, max_total_score AS maxTotalScoreBp
             FROM rubrics WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(app.rubricId)
        .first<{ id: string; name: string; version: number; maxTotalScoreBp: number }>()
    : null;

  const { results: reviewers } = await db
    .prepare(
      `SELECT ra.id AS assignmentId, ra.reviewer_user_id AS reviewerUserId,
              u.email AS reviewerEmail, ra.completed_at AS completedAt,
              COALESCE(SUM(rs.score * rc.weight_bp), 0) AS totalBp,
              -- COUNT(rc.id), NOT COUNT(rs.id), so the count and the total
              -- answer over the same set. A score whose criterion has been
              -- soft-deleted keeps a live review_scores row, but its LEFT JOIN
              -- to rubric_criteria yields NULL and SUM skips it -- counting
              -- the score row anyway would read "6 of 5 criteria scored" next
              -- to a total built from 5.
              --
              -- NOT REACHABLE TODAY, and said plainly rather than dressed up
              -- as a bug fixed: 0006 freezes a published rubric's criteria
              -- with triggers, publication is one way, and a cycle can only
              -- use a published rubric -- so nothing in this system can
              -- soft-delete a criterion that has scores against it. This is
              -- the expression that stays correct if that freeze is ever
              -- relaxed, which costs nothing now and is the kind of thing
              -- nobody re-derives later.
              COUNT(rc.id) AS scored
         FROM review_assignments ra
         JOIN users u ON u.id = ra.reviewer_user_id
         LEFT JOIN review_scores rs
           ON rs.review_assignment_id = ra.id AND rs.deleted_at IS NULL
         LEFT JOIN rubric_criteria rc
           ON rc.id = rs.rubric_criterion_id AND rc.deleted_at IS NULL
        WHERE ra.application_id = ?
          AND ra.recused_at IS NULL
          AND ra.deleted_at IS NULL
        GROUP BY ra.id
        ORDER BY u.email`,
    )
    .bind(applicationId)
    .all<Omit<ReviewerTotal, 'criteriaCount'>>();

  const { results: criteria } = app.rubricId
    ? await db
        .prepare(
          `SELECT id AS criterionId, label, max_score AS maxScore, weight_bp AS weightBp
             FROM rubric_criteria
            WHERE rubric_id = ? AND deleted_at IS NULL
            ORDER BY sort_order, criterion_key`,
        )
        .bind(app.rubricId)
        .all<{ criterionId: string; label: string; maxScore: number; weightBp: number }>()
    : { results: [] as { criterionId: string; label: string; maxScore: number; weightBp: number }[] };

  const { results: cells } = await db
    .prepare(
      `SELECT rs.review_assignment_id AS assignmentId, rs.rubric_criterion_id AS criterionId,
              rs.score, rs.comment
         FROM review_scores rs
         JOIN review_assignments ra ON ra.id = rs.review_assignment_id
        WHERE ra.application_id = ?
          AND ra.recused_at IS NULL AND ra.deleted_at IS NULL
          AND rs.deleted_at IS NULL`,
    )
    .bind(applicationId)
    .all<{ assignmentId: string; criterionId: string; score: number; comment: string | null }>();

  const criteriaCount = (criteria ?? []).length;
  const rows: ReviewerTotal[] = (reviewers ?? []).map((r) => ({ ...r, criteriaCount }));
  const completed = rows.filter((r) => r.completedAt !== null);

  return {
    applicationId,
    rubric: rubric ?? null,
    reviewers: rows,
    meanCompletedBp:
      completed.length === 0
        ? null
        : // Integer division, rounded. A mean in score-basis-points that is
          // then divided by 10000 for display, so the halved cent problem
          // never arises: the rounding happens once, here.
          Math.round(completed.reduce((t, r) => t + r.totalBp, 0) / completed.length),
    byCriterion: (criteria ?? []).map((c) => ({
      ...c,
      scores: rows.map((r) => {
        const cell = (cells ?? []).find(
          (x) => x.assignmentId === r.assignmentId && x.criterionId === c.criterionId,
        );
        return {
          assignmentId: r.assignmentId,
          score: cell?.score ?? null,
          comment: cell?.comment ?? null,
        };
      }),
    })),
  };
}

/** Score-basis-points to points, for a display edge. */
export function formatScore(bp: number): string {
  return (bp / WEIGHT_ONE_BP).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
