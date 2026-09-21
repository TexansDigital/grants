/**
 * The offline scorecard: an export a consultant can fill in, and an import
 * that checks it on the way back.
 *
 * WHAT CLAUDE.MD SAYS ABOUT THIS, and it is worth repeating where somebody
 * will read it before extending the feature: "This exists so a consultant does
 * not block a decision, not as the normal path. Uploaded scorecards drift from
 * the rubric, carry no conflict declaration, and produce no audit trail. Say so
 * if anyone proposes making it the default."
 *
 * Two of those three are fixable and are fixed here. The import writes the same
 * audit rows as in-app scoring, and it refuses a file whose rubric version does
 * not match the one the cycle is using, which is what "drift from the rubric"
 * actually means in practice. The third is not fixable and is the reason this
 * stays a fallback: a spreadsheet emailed back carries no evidence that the
 * person who filled it in was the person it was sent to, and no moment at
 * which they were asked about a conflict.
 *
 * THE STAMP IS THE WHOLE DESIGN. Every file carries the rubric id, its version,
 * and the criterion keys in order. A file filled in against last year's rubric
 * looks exactly like one filled in against this year's, right up to the point
 * where the scores land against the wrong criteria and nobody can tell. So the
 * import compares all three and refuses on any mismatch, before reading a
 * single score.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { parseDelimited, toRecord, sniffDelimiter, CsvError } from './csv';
import { saveScores } from './scoring';
import { conflictOutstandingSql } from './reviewAssign';

/** A megabyte of scorecard is thousands of rows. Anything larger is a mistake. */
export const MAX_SCORECARD_BYTES = 1_000_000;

/**
 * The header block, carried as columns rather than as a preamble.
 *
 * A preamble above the header is what most systems do and it is why most
 * scorecard imports are fragile: Excel helpfully reformats it, a reviewer
 * deletes the "instructions" rows, and the file no longer says what it is
 * about. Repeating the stamp on every row is redundant and survives all of
 * that.
 */
export const STAMP_COLUMNS = ['rubric_id', 'rubric_version', 'criterion_key'] as const;

export interface ScorecardRow {
  assignmentId: string;
  applicationId: string;
  organization: string;
  projectTitle: string;
  criterionKey: string;
  criterionLabel: string;
  maxScore: number;
  score: string;
  comment: string;
}

function csvCell(value: string | number | null): string {
  const s = String(value ?? '');
  // Quote anything that could change the shape of the file, and double any
  // quote inside it. A project title containing a comma is normal.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_HEADER = [
  'assignment_id',
  'application_id',
  'organization',
  'project_title',
  'rubric_id',
  'rubric_version',
  'criterion_key',
  'criterion_label',
  'max_score',
  'score',
  'comment',
] as const;

/**
 * One reviewer's whole queue for a cycle, as a CSV they can fill in.
 *
 * ONE ROW PER APPLICATION PER CRITERION, not a grid with criteria as columns.
 * A grid is nicer to look at and impossible to validate: a reviewer who
 * inserts a column, or whose spreadsheet reorders them, produces a file whose
 * scores are silently against the wrong criteria. A long file has the
 * criterion key on every row, so a reordered file is still correct and a
 * renamed one is refused.
 *
 * EXISTING SCORES ARE INCLUDED, so a part-finished review exports as what it
 * is rather than as blank. A reviewer who scored three in the app and takes
 * the rest offline should not have to retype the three.
 */
export async function exportScorecard(
  db: D1Database,
  session: Session,
  cycleId: string,
  reviewerUserId: string,
): Promise<{ filename: string; csv: string; rows: number }> {
  if (session.role !== 'admin' && session.userId !== reviewerUserId) {
    // A reviewer may export their own. Anybody else's is a 404, not a 403:
    // the id in the URL must not confirm that a reviewer exists.
    throw notFound('reviewer');
  }

  const cycle = await db
    .prepare(
      `SELECT c.id, c.name, c.rubric_id AS rubricId FROM cycles c
        WHERE c.id = ? AND c.deleted_at IS NULL`,
    )
    .bind(cycleId)
    .first<{ id: string; name: string; rubricId: string | null }>();
  if (!cycle) throw notFound('cycle');
  if (!cycle.rubricId) {
    throw new AppError('CONFLICT', 'This cycle has no scoring rubric yet.', {
      internalMessage: `scorecard export for cycle ${cycleId} with no rubric`,
      severity: 'warn',
    });
  }

  const rubric = await db
    .prepare(`SELECT id, version FROM rubrics WHERE id = ? AND deleted_at IS NULL`)
    .bind(cycle.rubricId)
    .first<{ id: string; version: number }>();
  if (!rubric) throw notFound('rubric');

  /*
   * The reviewer's own assignments, joined to the rubric's criteria and to
   * THEIR OWN scores. The assignment id is in the join for the scores, so no
   * other reviewer's numbers are read -- the same rule as the in-app sheet,
   * and for the same reason: a file that leaked a colleague's scores would be
   * emailed to an outside consultant.
   */
  const { results } = await db
    .prepare(
      `SELECT ra.id AS assignmentId, a.id AS applicationId,
              o.legal_name AS organization,
              COALESCE(a.project_title, '') AS projectTitle,
              rc.criterion_key AS criterionKey, rc.label AS criterionLabel,
              rc.max_score AS maxScore, rc.sort_order AS sortOrder,
              COALESCE(CAST(rs.score AS TEXT), '') AS score,
              COALESCE(rs.comment, '') AS comment
         FROM review_assignments ra
         JOIN applications a  ON a.id = ra.application_id AND a.deleted_at IS NULL
         JOIN organizations o ON o.id = a.organization_id
         JOIN rubric_criteria rc ON rc.rubric_id = ? AND rc.deleted_at IS NULL
         LEFT JOIN review_scores rs
           ON rs.rubric_criterion_id = rc.id
          AND rs.review_assignment_id = ra.id
          AND rs.deleted_at IS NULL
        WHERE ra.reviewer_user_id = ?
          AND a.cycle_id = ?
          AND ra.recused_at IS NULL
          AND NOT ${conflictOutstandingSql('ra')}
          AND ra.deleted_at IS NULL
        ORDER BY o.legal_name, rc.sort_order, rc.criterion_key`,
    )
    .bind(cycle.rubricId, reviewerUserId, cycleId)
    .all<ScorecardRow & { sortOrder: number }>();

  const rows = results ?? [];
  const lines = [EXPORT_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.assignmentId, r.applicationId, r.organization, r.projectTitle,
        rubric.id, rubric.version, r.criterionKey, r.criterionLabel,
        r.maxScore, r.score, r.comment,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  const safeCycle = cycle.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    filename: `scorecard-${safeCycle || 'cycle'}-v${rubric.version}.csv`,
    csv: `${lines.join('\r\n')}\r\n`,
    rows: rows.length,
  };
}

export interface CycleReviewer {
  reviewerUserId: string;
  email: string;
  assigned: number;
  completed: number;
  conflicts: number;
}

/**
 * Who is reviewing in this cycle, one row each.
 *
 * NOT reviewCoverage, which answers the other question -- how many reviewers
 * each APPLICATION has. Both are needed and neither is a filter on the other:
 * coverage catches the application with one reviewer at the deadline, and this
 * catches the consultant with eleven who has filed nothing.
 *
 * Conflicts are counted rather than hidden, because a reviewer whose
 * scorecard will be three applications short should not look like one whose
 * file is complete.
 */
export async function reviewersInCycle(
  db: D1Database,
  session: Session,
  cycleId: string,
): Promise<{ cycleId: string; reviewers: CycleReviewer[] }> {
  if (session.role !== 'admin') throw notFound('cycle');
  const { results } = await db
    .prepare(
      `SELECT ra.reviewer_user_id AS reviewerUserId, u.email,
              COUNT(*) AS assigned,
              SUM(CASE WHEN ra.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
              -- OUTSTANDING conflicts, not declarations ever made. A count
              -- that includes resolved ones tells an admin there is work to
              -- do on an assignment they already dealt with.
              SUM(CASE WHEN ${conflictOutstandingSql('ra')} THEN 1 ELSE 0 END) AS conflicts
         FROM review_assignments ra
         JOIN users u ON u.id = ra.reviewer_user_id
         JOIN applications a ON a.id = ra.application_id AND a.deleted_at IS NULL
        WHERE a.cycle_id = ?
          AND ra.recused_at IS NULL
          AND ra.deleted_at IS NULL
        GROUP BY ra.reviewer_user_id
        ORDER BY u.email`,
    )
    .bind(cycleId)
    .all<CycleReviewer>();
  return { cycleId, reviewers: results ?? [] };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ScorecardIssue {
  row: number | null;
  message: string;
}

export interface ScorecardPlan {
  ok: boolean;
  rubricId: string | null;
  rubricVersion: number | null;
  issues: ScorecardIssue[];
  /** One entry per assignment the file touches. */
  assignments: {
    assignmentId: string;
    organization: string;
    reviewerEmail: string;
    scored: number;
    cleared: number;
    unchanged: number;
  }[];
  totalScores: number;
}

interface Planned {
  assignmentId: string;
  criterionId: string;
  score: number | null;
  comment: string | null;
  changed: boolean;
}

/**
 * Read a filled-in scorecard and say exactly what it would do.
 *
 * WRITES NOTHING. The awards importer works this way and so does this: a file
 * somebody edited in Excel over a weekend is not a thing to apply unseen.
 *
 * THE CHECKS, IN ORDER, AND WHY THEY STOP WHERE THEY DO. Anything that makes
 * the whole file meaningless is fatal and returns immediately -- a rubric
 * mismatch, an unreadable file -- because listing sixty row errors caused by
 * one wrong rubric buries the one fact that matters. Everything after that is
 * collected per row, so a reviewer gets the whole list in one pass rather than
 * one error per upload.
 */
async function planInternal(
  db: D1Database,
  session: Session,
  cycleId: string,
  csv: string,
): Promise<{ plan: ScorecardPlan; planned: Planned[] }> {
  if (session.role !== 'admin') throw notFound('cycle');

  const empty = (issues: ScorecardIssue[]): { plan: ScorecardPlan; planned: Planned[] } => ({
    plan: {
      ok: false, rubricId: null, rubricVersion: null, issues, assignments: [], totalScores: 0,
    },
    planned: [],
  });

  if (csv.length > MAX_SCORECARD_BYTES) {
    return empty([{ row: null, message: 'That file is too large to be a scorecard.' }]);
  }

  const cycle = await db
    .prepare(`SELECT id, rubric_id AS rubricId FROM cycles WHERE id = ? AND deleted_at IS NULL`)
    .bind(cycleId)
    .first<{ id: string; rubricId: string | null }>();
  if (!cycle) throw notFound('cycle');
  if (!cycle.rubricId) {
    return empty([{ row: null, message: 'This cycle has no scoring rubric.' }]);
  }

  const rubric = await db
    .prepare(`SELECT id, version FROM rubrics WHERE id = ? AND deleted_at IS NULL`)
    .bind(cycle.rubricId)
    .first<{ id: string; version: number }>();
  if (!rubric) return empty([{ row: null, message: 'This cycle points at a rubric that is gone.' }]);

  let table;
  try {
    table = parseDelimited(csv, sniffDelimiter(csv));
  } catch (e) {
    return empty([
      { row: e instanceof CsvError ? e.line : null, message: (e as Error).message },
    ]);
  }
  const header = table.header.map((h) => h.trim().toLowerCase());
  const missing = ['assignment_id', ...STAMP_COLUMNS, 'score'].filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return empty([
      {
        row: null,
        message:
          `This file is missing ${missing.join(', ')}. Export a fresh scorecard and fill ` +
          `that in rather than building one by hand.`,
      },
    ]);
  }

  const issues: ScorecardIssue[] = [];
  const records: Record<string, string>[] = [];
  table.rows.forEach((row, i) => {
    try {
      records.push(toRecord(header, row, i + 2));
    } catch (e) {
      issues.push({ row: i + 2, message: (e as Error).message });
    }
  });
  if (records.length === 0) {
    return empty([...issues, { row: null, message: 'That file has no rows.' }]);
  }

  /*
   * THE STAMP CHECK, BEFORE ANY SCORE IS READ.
   *
   * A file filled in against last year's rubric looks exactly like one filled
   * in against this year's. The scores land against whatever criterion keys
   * happen to match, the rest are silently dropped, and the totals are wrong
   * in a way nobody can see. One fatal issue, named precisely, beats sixty row
   * errors that all trace back to it.
   */
  const stamps = new Set(records.map((r) => `${r.rubric_id}|${r.rubric_version}`));
  const expected = `${rubric.id}|${rubric.version}`;
  if (stamps.size > 1) {
    return empty([
      { row: null, message: 'This file mixes rows from more than one rubric version.' },
    ]);
  }
  if (!stamps.has(expected)) {
    const found = [...stamps][0] ?? '(none)';
    return empty([
      {
        row: null,
        message:
          `This scorecard was made for a different rubric (${found.split('|')[1] ? `version ${found.split('|')[1]}` : found}). ` +
          `This cycle scores against version ${rubric.version}. Export a fresh one.`,
      },
    ]);
  }

  // Criteria by key, for this rubric only.
  const { results: criteria } = await db
    .prepare(
      `SELECT id, criterion_key AS criterionKey, max_score AS maxScore
         FROM rubric_criteria WHERE rubric_id = ? AND deleted_at IS NULL`,
    )
    .bind(rubric.id)
    .all<{ id: string; criterionKey: string; maxScore: number }>();
  const byKey = new Map((criteria ?? []).map((c) => [c.criterionKey, c]));

  // Assignments the file names, with everything needed to refuse them.
  const ids = [...new Set(records.map((r) => r.assignment_id).filter(Boolean))];
  const { results: assignments } = ids.length
    ? await db
        .prepare(
          `SELECT ra.id, ra.reviewer_user_id AS reviewerUserId, ra.recused_at AS recusedAt,
                  ra.conflict_declared_at AS conflictAt,
                  ra.conflict_cleared_at AS conflictClearedAt,
                  ra.completed_at AS completedAt,
                  u.email AS reviewerEmail, o.legal_name AS organization,
                  a.cycle_id AS cycleId, a.decided_at AS decidedAt
             FROM review_assignments ra
             JOIN users u ON u.id = ra.reviewer_user_id
             JOIN applications a ON a.id = ra.application_id AND a.deleted_at IS NULL
             JOIN organizations o ON o.id = a.organization_id
            WHERE ra.deleted_at IS NULL AND ra.id IN (${ids.map(() => '?').join(',')})`,
        )
        .bind(...ids)
        .all<{
          id: string; reviewerUserId: string; recusedAt: string | null;
          conflictAt: string | null; conflictClearedAt: string | null;
          completedAt: string | null;
          reviewerEmail: string; organization: string; cycleId: string; decidedAt: string | null;
        }>()
    : { results: [] };
  const byAssignment = new Map((assignments ?? []).map((a) => [a.id, a]));

  // Existing scores, so "unchanged" is a real category rather than a rewrite.
  const { results: existing } = ids.length
    ? await db
        .prepare(
          `SELECT review_assignment_id AS assignmentId, rubric_criterion_id AS criterionId,
                  score, comment
             FROM review_scores
            WHERE deleted_at IS NULL
              AND review_assignment_id IN (${ids.map(() => '?').join(',')})`,
        )
        .bind(...ids)
        .all<{ assignmentId: string; criterionId: string; score: number; comment: string | null }>()
    : { results: [] };
  const existingByPair = new Map(
    (existing ?? []).map((e) => [`${e.assignmentId}|${e.criterionId}`, e]),
  );

  const planned: Planned[] = [];
  const seenPairs = new Set<string>();

  records.forEach((r, i) => {
    const rowNo = i + 2;
    // toRecord builds from the header, so every named column is present --
    // but the index signature does not know that, and a cast would hide a
    // genuinely missing column behind `undefined`.
    const assignmentId = r.assignment_id ?? '';
    const assignment = byAssignment.get(assignmentId);
    if (!assignment) {
      issues.push({ row: rowNo, message: `No assignment ${assignmentId}.` });
      return;
    }
    if (assignment.cycleId !== cycleId) {
      // The file is being uploaded against the wrong cycle. Refusing the row
      // rather than the file, because a mixed file is the likelier mistake and
      // saying which rows is more useful than saying "no".
      issues.push({ row: rowNo, message: `That assignment is not in this cycle.` });
      return;
    }
    if (assignment.recusedAt) {
      issues.push({ row: rowNo, message: `${assignment.reviewerEmail} was recused from this one.` });
      return;
    }
    if (assignment.conflictAt && assignment.conflictClearedAt === null) {
      /*
       * The conflict was declared AFTER the file went out. Importing anyway
       * would write a score from somebody who has since said they should not
       * be scoring it -- which is exactly what the declaration is for.
       */
      issues.push({
        row: rowNo,
        message: `${assignment.reviewerEmail} declared a conflict on ${assignment.organization}.`,
      });
      return;
    }
    if (assignment.decidedAt) {
      issues.push({ row: rowNo, message: `${assignment.organization} has already been decided.` });
      return;
    }
    if (assignment.completedAt) {
      /*
       * THE PLAN SELECTED completed_at AND NEVER READ IT -- a check that was
       * clearly intended and was missing. saveScores now refuses a submitted
       * review, so without this the file planned cleanly and then threw
       * PART-WAY THROUGH the apply loop, leaving some reviews written and
       * others not. Catching it here refuses the whole file, which is this
       * importer's rule everywhere else.
       */
      issues.push({
        row: rowNo,
        message:
          `${assignment.reviewerEmail} has already submitted their review of ` +
          `${assignment.organization}. Reopen it first if it should be replaced.`,
      });
      return;
    }

    const criterionKey = r.criterion_key ?? '';
    const criterion = byKey.get(criterionKey);
    if (!criterion) {
      issues.push({ row: rowNo, message: `No criterion "${criterionKey}" on this rubric.` });
      return;
    }

    const pair = `${assignment.id}|${criterion.id}`;
    if (seenPairs.has(pair)) {
      // Two rows for the same criterion is a copy-paste, and picking one
      // silently is how the wrong number wins.
      issues.push({ row: rowNo, message: `This criterion appears twice for ${assignment.organization}.` });
      return;
    }
    seenPairs.add(pair);

    const raw = (r.score ?? '').trim();
    let score: number | null = null;
    if (raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > criterion.maxScore) {
        issues.push({
          row: rowNo,
          message: `"${raw}" is not a whole number between 0 and ${criterion.maxScore}.`,
        });
        return;
      }
      score = n;
    }

    const comment = (r.comment ?? '').trim() || null;
    const prior = existingByPair.get(pair);
    const changed =
      (prior?.score ?? null) !== score || (prior?.comment ?? null) !== comment;
    planned.push({ assignmentId: assignment.id, criterionId: criterion.id, score, comment, changed });
  });

  const perAssignment = new Map<string, { scored: number; cleared: number; unchanged: number }>();
  for (const p of planned) {
    const acc = perAssignment.get(p.assignmentId) ?? { scored: 0, cleared: 0, unchanged: 0 };
    if (!p.changed) acc.unchanged += 1;
    else if (p.score === null) acc.cleared += 1;
    else acc.scored += 1;
    perAssignment.set(p.assignmentId, acc);
  }

  return {
    plan: {
      // A file with ANY issue does not apply. A partial import of a scorecard
      // leaves a review that is neither what the reviewer sent nor what was
      // there before, and nobody can tell which rows landed.
      ok: issues.length === 0 && planned.length > 0,
      rubricId: rubric.id,
      rubricVersion: rubric.version,
      issues,
      assignments: [...perAssignment.entries()].map(([assignmentId, acc]) => ({
        assignmentId,
        organization: byAssignment.get(assignmentId)?.organization ?? '',
        reviewerEmail: byAssignment.get(assignmentId)?.reviewerEmail ?? '',
        ...acc,
      })),
      totalScores: planned.filter((p) => p.changed).length,
    },
    planned,
  };
}

/** The preview. Writes nothing; see planInternal for the reasoning. */
export async function planScorecardImport(
  db: D1Database,
  session: Session,
  cycleId: string,
  csv: string,
): Promise<ScorecardPlan> {
  return (await planInternal(db, session, cycleId, csv)).plan;
}

export interface ScorecardApplyResult {
  applied: number;
  assignments: number;
  plan: ScorecardPlan;
}

/**
 * Apply a scorecard that planned cleanly.
 *
 * RE-PLANNED HERE rather than trusting a plan the client sends back. The plan
 * is a description, not a token: between the preview and the click somebody
 * may have declared a conflict, the application may have been decided, or the
 * cycle may have been given a new rubric. All of those make the file wrong,
 * and all of them are cheap to re-check.
 *
 * THE WRITES GO THROUGH saveScores, the same function in-app scoring uses. So
 * an imported score gets the same range checks, the same
 * update-rather-than-replace, and the same audit row -- which is the part
 * CLAUDE.md warns that offline scorecards normally lack.
 */
export async function applyScorecardImport(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  cycleId: string,
  csv: string,
): Promise<ScorecardApplyResult> {
  if (session.role !== 'admin') throw notFound('cycle');

  const { plan, planned } = await planInternal(db, session, cycleId, csv);
  if (!plan.ok) {
    throw new AppError('VALIDATION_FAILED', 'That scorecard has problems that have to be fixed first.', {
      internalMessage: `scorecard import refused with ${plan.issues.length} issue(s)`,
      severity: 'warn',
      fieldErrors: plan.issues.slice(0, 20).map((i) => ({
        field: i.row === null ? 'file' : `row ${i.row}`,
        message: i.message,
      })),
    });
  }

  /*
   * THE ROWS COME FROM THE PLAN, not from a second parse of the same file.
   *
   * They used to be parsed twice -- once to validate, once to write -- and a
   * mutant proved the two could disagree: a blank score cell that the planner
   * read as zero still landed as null, because the writer parsed it again with
   * different rules. Either reading might be the wrong one, and nothing would
   * have shown which. One parse, one answer.
   */
  const grouped = new Map<
    string,
    { criterionId: string; score: number | null; comment: string | null; changed: boolean }[]
  >();
  for (const p of planned) {
    const list = grouped.get(p.assignmentId) ?? [];
    list.push({ criterionId: p.criterionId, score: p.score, comment: p.comment, changed: p.changed });
    grouped.set(p.assignmentId, list);
  }

  /*
   * `applied` COUNTS WHAT CHANGED, which is what the preview counted.
   *
   * It used to add up `saveScores`'s own `saved`, which is every cell sent --
   * including the ones the plan had already worked out were identical to what
   * was there. So the preview said "8 scores to import" and the confirmation
   * afterwards said "23 applied", on the same file, with nothing to explain
   * the gap. Somebody reconciling a consultant's scorecard against what landed
   * would have to assume one of the two numbers was a lie, and the larger one
   * is the one that looks like a mistake was made.
   *
   * The unchanged rows are still SENT -- they are no-op UPDATEs, and dropping
   * them would mean a second pass over the planned rows deciding what to omit,
   * which is the double-reading this function already learned not to do.
   */
  let applied = 0;
  for (const [assignmentId, scores] of grouped) {
    /*
     * ONE CALL PER ASSIGNMENT, so each review gets one audit row naming the
     * admin who imported it and the reviewer it belongs to -- and so a failure
     * on one assignment does not silently half-write another. D1 has no
     * interactive transaction spanning these; the alternative is a single
     * enormous batch whose failure tells you nothing about which review it
     * was.
     */
    await saveScores(db, ctx, session, assignmentId, scores);
    applied += scores.filter((r) => r.changed).length;
  }

  return { applied, assignments: grouped.size, plan };
}
