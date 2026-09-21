/**
 * Building a scoring rubric in the app.
 *
 * WHAT WAS ASKED FOR AND WHY THIS IS THAT. The first idea was to upload a
 * scoring template and have a model turn it into a screen. That works once and
 * is unaccountable afterwards: nobody can say what the weights were in the
 * cycle that has already been decided, a re-upload silently rewrites a rubric
 * applications were scored against, and a spreadsheet with a merged cell
 * produces criteria nobody intended. A builder makes the rubric DATA, edited
 * by a person, versioned, and frozen the moment it is published.
 *
 * THE UNITS, which are the part that goes wrong quietly.
 *
 * `weight_bp` is basis points: 10000 is a weight of 1.0, 2500 is 0.25. Same
 * discipline as money -- integers all the way through, formatted at the display
 * edge -- for the same reason. A rubric weighted 1/3, 1/3, 1/3 in floats gives
 * two applications the same score and ranks one above the other, and nobody
 * ever finds out why.
 *
 * So a weighted total is `SUM(score * weight_bp)` and the ceiling is
 * `SUM(max_score * weight_bp)`. Both are exact integers. `max_total_score`
 * holds the ceiling in those units -- score-basis-points -- and dividing by
 * 10000 is a display concern, never a storage one.
 *
 * WHAT THE DATABASE ENFORCES AND THIS DOES NOT REPEAT. 0006 freezes a
 * published rubric with triggers: no criterion may be inserted into, updated
 * in, or deleted from anything that is not a draft, and a cycle's rubric must
 * belong to the cycle's own program. Those are not re-checked here. A second
 * copy of a rule is a second place for it to be wrong.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';

/** 10000 basis points is a weight of 1.0. */
export const WEIGHT_ONE_BP = 10000;

/**
 * A ceiling on a single criterion.
 *
 * Not arbitrary: a reviewer asked to place an application on a 1-to-1000 scale
 * is being asked for precision they do not have, and the spread it produces is
 * noise that looks like signal in a ranking.
 */
export const MAX_CRITERION_SCORE = 100;

/** Enough for any rubric a human will actually read in one sitting. */
export const MAX_CRITERIA = 40;

/**
 * A ceiling on a single weight: 1,000,000 basis points, a weight of 100.
 *
 * WHY THERE HAS TO BE ONE. The floor was checked and the ceiling was not, so a
 * weight of Number.MAX_SAFE_INTEGER validated cleanly. Every weighted total in
 * the system is `SUM(score * weight_bp)` computed in SQLite, and once that
 * product leaves safe-integer range the sums stop being exact -- which is the
 * whole reason weights are integers in the first place. The bound is generous
 * on purpose: 40 criteria at a max score of 100 and a weight of 100 apiece
 * tops out at 400,000,000 score-basis-points, four orders of magnitude inside
 * the safe range, so no legitimate rubric can reach it and no rubric can
 * silently leave it.
 */
export const MAX_WEIGHT_BP = 1_000_000;

export interface CriterionInput {
  /** Stable within the rubric. Carried across versions so trends survive. */
  criterionKey: string;
  label: string;
  description?: string | null;
  /** Basis points. 10000 = 1.0. */
  weightBp: number;
  maxScore: number;
}

export interface RubricRow {
  id: string;
  program_id: string;
  name: string;
  rubric_key: string;
  version: number;
  status: string;
  max_total_score: number | null;
  published_at: string | null;
}

export interface CriterionRow {
  id: string;
  criterion_key: string;
  label: string;
  description: string | null;
  weight_bp: number;
  max_score: number;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listRubrics(db: D1Database, programId: string): Promise<RubricRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, program_id, name, rubric_key, version, status, max_total_score, published_at
         FROM rubrics
        WHERE program_id = ? AND deleted_at IS NULL
        ORDER BY rubric_key, version DESC`,
    )
    .bind(programId)
    .all<RubricRow>();
  return results ?? [];
}

export interface RubricDetail {
  rubric: RubricRow;
  criteria: CriterionRow[];
  /** SUM(max_score * weight_bp) as it stands right now, published or not. */
  maxTotalScoreBp: number;
  /** Cycles pointing at this rubric. A published rubric in use cannot retire. */
  cyclesUsing: { id: string; name: string; status: string }[];
}

export async function getRubric(db: D1Database, rubricId: string): Promise<RubricDetail> {
  const rubric = await db
    .prepare(
      `SELECT id, program_id, name, rubric_key, version, status, max_total_score, published_at
         FROM rubrics WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(rubricId)
    .first<RubricRow>();
  if (!rubric) throw notFound('rubric');

  const { results: criteria } = await db
    .prepare(
      `SELECT id, criterion_key, label, description, weight_bp, max_score, sort_order
         FROM rubric_criteria
        WHERE rubric_id = ? AND deleted_at IS NULL
        ORDER BY sort_order, criterion_key`,
    )
    .bind(rubricId)
    .all<CriterionRow>();

  const { results: cyclesUsing } = await db
    .prepare(
      `SELECT id, name, status FROM cycles
        WHERE rubric_id = ? AND deleted_at IS NULL ORDER BY opens_at DESC`,
    )
    .bind(rubricId)
    .all<{ id: string; name: string; status: string }>();

  return {
    rubric,
    criteria: criteria ?? [],
    maxTotalScoreBp: (criteria ?? []).reduce((t, c) => t + c.max_score * c.weight_bp, 0),
    cyclesUsing: cyclesUsing ?? [],
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Everything a rubric must be true of before it can be saved.
 *
 * VALIDATED ON SAVE, not only on publish. A draft that cannot be published is
 * a draft somebody will discover is broken on the morning the cycle opens, and
 * the errors are much cheaper to read while the person is still looking at the
 * field they typed.
 */
export function validateCriteria(criteria: CriterionInput[]): { field: string; message: string }[] {
  const problems: { field: string; message: string }[] = [];
  if (criteria.length === 0) {
    problems.push({ field: 'criteria', message: 'A rubric needs at least one criterion.' });
  }
  if (criteria.length > MAX_CRITERIA) {
    problems.push({
      field: 'criteria',
      message: `A rubric can have at most ${MAX_CRITERIA} criteria.`,
    });
  }

  const seen = new Set<string>();
  criteria.forEach((c, i) => {
    const key = (c.criterionKey ?? '').trim();
    if (!key) {
      problems.push({ field: `criteria[${i}].criterionKey`, message: 'Every criterion needs a key.' });
    } else if (!/^[a-z0-9_]+$/.test(key)) {
      // The key travels into exports, offline scorecards and column headers.
      // Spaces and punctuation there become somebody's broken CSV.
      problems.push({
        field: `criteria[${i}].criterionKey`,
        message: 'A key can use lowercase letters, numbers and underscores only.',
      });
    } else if (seen.has(key)) {
      problems.push({
        field: `criteria[${i}].criterionKey`,
        message: `There is already a criterion called ${key}.`,
      });
    }
    seen.add(key);

    if (!(c.label ?? '').trim()) {
      problems.push({ field: `criteria[${i}].label`, message: 'Every criterion needs a label.' });
    }
    if (!Number.isInteger(c.maxScore) || c.maxScore < 1 || c.maxScore > MAX_CRITERION_SCORE) {
      problems.push({
        field: `criteria[${i}].maxScore`,
        message: `A maximum score is a whole number between 1 and ${MAX_CRITERION_SCORE}.`,
      });
    }
    if (!Number.isInteger(c.weightBp) || c.weightBp < 0 || c.weightBp > MAX_WEIGHT_BP) {
      /*
       * INTEGER BASIS POINTS, and a float is refused rather than rounded.
       * Rounding 0.333 to 3333 silently is how a rubric stops summing to what
       * the person who built it believes it sums to -- and they find out from
       * a ranking.
       */
      problems.push({
        field: `criteria[${i}].weightBp`,
        message:
          'A weight is a whole number of basis points between 0 and ' +
          `${MAX_WEIGHT_BP}; 10000 means a weight of 1.`,
      });
    }
  });

  if (
    criteria.length > 0 &&
    criteria.every((c) => Number.isInteger(c.weightBp) && c.weightBp === 0)
  ) {
    // Every weight zero makes every total zero and every application tied. It
    // is a rubric that cannot rank anything, and it looks fine on screen.
    problems.push({
      field: 'criteria',
      message: 'At least one criterion has to carry some weight.',
    });
  }

  return problems;
}

function refuse(problems: { field: string; message: string }[]): never {
  throw new AppError('VALIDATION_FAILED', 'This rubric is not ready to save yet.', {
    internalMessage: `rubric validation failed: ${problems.map((p) => p.field).join(', ')}`,
    severity: 'warn',
    fieldErrors: problems,
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * A new draft rubric, either the first of its key or the next version.
 *
 * VERSIONS ARE PER KEY, not per program. "Inspire Change 2026 scoring" is one
 * key whose version goes up each time the rubric is revised, and a cycle points
 * at one exact version. That is what makes "what were we scoring against in
 * 2025" answerable two years later.
 */
export async function createRubric(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  input: { programId: string; name: string; rubricKey: string },
): Promise<{ rubricId: string; version: number }> {
  const key = (input.rubricKey ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!/^[a-z0-9_]+$/.test(key)) {
    refuse([{ field: 'rubricKey', message: 'A key can use lowercase letters, numbers and underscores only.' }]);
  }
  if (!name) refuse([{ field: 'name', message: 'Give this rubric a name.' }]);

  const program = await db
    .prepare(`SELECT id FROM programs WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.programId)
    .first<{ id: string }>();
  if (!program) throw notFound('program');

  const latest = await db
    .prepare(
      `SELECT MAX(version) AS v FROM rubrics
        WHERE program_id = ? AND rubric_key = ? AND deleted_at IS NULL`,
    )
    .bind(input.programId, key)
    .first<{ v: number | null }>();
  const version = (latest?.v ?? 0) + 1;

  const id = newId();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO rubrics (id, program_id, name, rubric_key, version, status,
           created_at, updated_at)
         VALUES (?,?,?,?,?, 'draft', ?, ?)`,
      )
      .bind(id, input.programId, name, key, version, now, now),
    auditStatement(db, ctx, {
      action: 'rubric.created',
      entityType: 'rubric',
      entityId: id,
      after: { program_id: input.programId, name, rubric_key: key, version, actor: session.userId },
    }),
  ]);

  return { rubricId: id, version };
}

/**
 * Save the whole criterion list at once.
 *
 * WHY THE WHOLE LIST RATHER THAN PER-ROW EDITS. A builder screen holds the
 * rubric as one object and the person thinks of it that way: they reorder two
 * rows, retitle a third and change a weight before pressing save. Six
 * independent requests can land half-applied, and the half-applied state is a
 * rubric whose weights no longer mean what the screen showed.
 *
 * REMOVED CRITERIA ARE SOFT-DELETED, never dropped. The unique index on
 * (rubric_id, criterion_key) is partial on `deleted_at IS NULL`, so a key can
 * be removed and added back. A hard delete would also be the one place in this
 * schema that destroys a row.
 */
export async function replaceCriteria(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  rubricId: string,
  criteria: CriterionInput[],
): Promise<{ rubricId: string; criteria: number; maxTotalScoreBp: number }> {
  const detail = await getRubric(db, rubricId);
  if (detail.rubric.status !== 'draft') {
    /*
     * The database refuses this too. It is said here as well because the
     * trigger's message -- "cannot change a criterion of a rubric that is not
     * draft" -- would reach an admin as an INTERNAL error, and what they need
     * to be told is that there is a way to do what they want: a new version.
     */
    throw new AppError('CONFLICT', 'This rubric is published. Start a new version to change it.', {
      internalMessage: `replaceCriteria on rubric ${rubricId} in status ${detail.rubric.status}`,
      severity: 'warn',
    });
  }

  const problems = validateCriteria(criteria);
  if (problems.length > 0) refuse(problems);

  const now = nowIso();
  const existing = new Map(detail.criteria.map((c) => [c.criterion_key, c]));
  const incoming = new Set(criteria.map((c) => c.criterionKey.trim()));
  const statements = [];

  criteria.forEach((c, i) => {
    const key = c.criterionKey.trim();
    const label = c.label.trim();
    const description = (c.description ?? '')?.toString().trim() || null;
    const found = existing.get(key);
    if (found) {
      statements.push(
        db
          .prepare(
            `UPDATE rubric_criteria
                SET label = ?, description = ?, weight_bp = ?, max_score = ?,
                    sort_order = ?, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL`,
          )
          .bind(label, description, c.weightBp, c.maxScore, i, now, found.id),
      );
    } else {
      statements.push(
        db
          .prepare(
            `INSERT INTO rubric_criteria (id, rubric_id, criterion_key, label, description,
               weight_bp, max_score, sort_order, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(newId(), rubricId, key, label, description, c.weightBp, c.maxScore, i, now, now),
      );
    }
  });

  for (const [key, row] of existing) {
    if (incoming.has(key)) continue;
    statements.push(
      db
        .prepare(`UPDATE rubric_criteria SET deleted_at = ?, updated_at = ? WHERE id = ?`)
        .bind(now, now, row.id),
    );
  }

  const maxTotalScoreBp = criteria.reduce((t, c) => t + c.maxScore * c.weightBp, 0);

  statements.push(
    db.prepare(`UPDATE rubrics SET updated_at = ? WHERE id = ?`).bind(now, rubricId),
    auditStatement(db, ctx, {
      action: 'rubric.criterion_changed',
      entityType: 'rubric',
      entityId: rubricId,
      before: {
        criteria: detail.criteria.map((c) => ({
          key: c.criterion_key, weight_bp: c.weight_bp, max_score: c.max_score,
        })),
      },
      after: {
        criteria: criteria.map((c) => ({
          key: c.criterionKey.trim(), weight_bp: c.weightBp, max_score: c.maxScore,
        })),
        max_total_score_bp: maxTotalScoreBp,
        actor: session.userId,
      },
    }),
  );

  await db.batch(statements);
  return { rubricId, criteria: criteria.length, maxTotalScoreBp };
}

/**
 * Freeze it, and stand down whatever it replaces.
 *
 * THE CEILING IS COMPUTED HERE AND STORED, rather than derived whenever it is
 * needed. It has to be, because the criteria it was computed from are frozen
 * from this moment and a later version will have different ones -- a total
 * recomputed on read would change what an already-decided cycle scored out of.
 *
 * ONE PUBLISHED RUBRIC PER KEY, which the schema's partial unique index
 * enforces. The previous version is retired in the SAME batch: retire-then-
 * publish as two calls leaves a window with no published rubric, and a window
 * with none is a cycle whose scoring screen has nothing to render.
 */
export async function publishRubric(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  rubricId: string,
): Promise<{ rubricId: string; version: number; maxTotalScoreBp: number; retiredRubricId: string | null }> {
  const detail = await getRubric(db, rubricId);
  if (detail.rubric.status !== 'draft') {
    throw new AppError('CONFLICT', 'Only a draft rubric can be published.', {
      internalMessage: `publishRubric on ${rubricId} in status ${detail.rubric.status}`,
      severity: 'warn',
    });
  }

  const problems = validateCriteria(
    detail.criteria.map((c) => ({
      criterionKey: c.criterion_key,
      label: c.label,
      description: c.description,
      weightBp: c.weight_bp,
      maxScore: c.max_score,
    })),
  );
  if (problems.length > 0) refuse(problems);

  const maxTotalScoreBp = detail.criteria.reduce((t, c) => t + c.max_score * c.weight_bp, 0);

  const current = await db
    .prepare(
      `SELECT id FROM rubrics
        WHERE program_id = ? AND rubric_key = ? AND status = 'published' AND deleted_at IS NULL`,
    )
    .bind(detail.rubric.program_id, detail.rubric.rubric_key)
    .first<{ id: string }>();

  const now = nowIso();
  const statements = [];
  if (current) {
    statements.push(
      db
        .prepare(`UPDATE rubrics SET status = 'retired', updated_at = ? WHERE id = ?`)
        .bind(now, current.id),
      auditStatement(db, ctx, {
        action: 'rubric.retired',
        entityType: 'rubric',
        entityId: current.id,
        before: { status: 'published' },
        after: { status: 'retired', replaced_by: rubricId, actor: session.userId },
      }),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE rubrics
            SET status = 'published', published_at = ?, max_total_score = ?, updated_at = ?
          WHERE id = ? AND status = 'draft'`,
      )
      .bind(now, maxTotalScoreBp, now, rubricId),
    auditStatement(db, ctx, {
      action: 'rubric.published',
      entityType: 'rubric',
      entityId: rubricId,
      before: { status: 'draft' },
      after: {
        status: 'published',
        version: detail.rubric.version,
        // In score-basis-points, like everything else here. Named so nobody
        // reading the audit log later divides it twice.
        max_total_score_bp: maxTotalScoreBp,
        criteria: detail.criteria.length,
        actor: session.userId,
      },
    }),
  );

  await db.batch(statements);
  return {
    rubricId,
    version: detail.rubric.version,
    maxTotalScoreBp,
    retiredRubricId: current?.id ?? null,
  };
}

/**
 * Copy a published rubric into a new draft version.
 *
 * The only way to change a published rubric, and deliberately so. Editing one
 * in place would rewrite the criteria that applications in a closed cycle were
 * already scored against, and the scores would silently start meaning
 * something else.
 */
export async function newDraftFrom(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  rubricId: string,
): Promise<{ rubricId: string; version: number }> {
  const detail = await getRubric(db, rubricId);
  const created = await createRubric(db, ctx, session, {
    programId: detail.rubric.program_id,
    name: detail.rubric.name,
    rubricKey: detail.rubric.rubric_key,
  });
  if (detail.criteria.length > 0) {
    await replaceCriteria(
      db, ctx, session, created.rubricId,
      detail.criteria.map((c) => ({
        // The KEY is carried across, which is what lets "how did we score
        // community need" be a question across versions rather than one per
        // rubric.
        criterionKey: c.criterion_key,
        label: c.label,
        description: c.description,
        weightBp: c.weight_bp,
        maxScore: c.max_score,
      })),
    );
  }
  return created;
}

/**
 * Point a cycle at a rubric.
 *
 * PUBLISHED ONLY. A cycle pointing at a draft is a cycle whose criteria can
 * change under the reviewers scoring against them.
 *
 * REFUSED ONCE SCORING HAS STARTED. Swapping the rubric mid-cycle orphans
 * every score already entered -- 0006's trigger refuses new scores against a
 * criterion outside the cycle's rubric, so the existing ones stay and stop
 * being reachable, which is worse than a refusal here.
 */
export async function attachRubricToCycle(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  cycleId: string,
  rubricId: string,
): Promise<{ cycleId: string; rubricId: string }> {
  const cycle = await db
    .prepare(`SELECT id, program_id, rubric_id FROM cycles WHERE id = ? AND deleted_at IS NULL`)
    .bind(cycleId)
    .first<{ id: string; program_id: string; rubric_id: string | null }>();
  if (!cycle) throw notFound('cycle');

  const rubric = await db
    .prepare(
      `SELECT id, program_id, status FROM rubrics WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(rubricId)
    .first<{ id: string; program_id: string; status: string }>();
  if (!rubric) throw notFound('rubric');
  if (rubric.status !== 'published') {
    throw new AppError('CONFLICT', 'A cycle can only use a published rubric.', {
      internalMessage: `attach rubric ${rubricId} in status ${rubric.status}`,
      severity: 'warn',
    });
  }

  const scored = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM review_scores s
         JOIN review_assignments ra ON ra.id = s.review_assignment_id
         JOIN applications a ON a.id = ra.application_id
        WHERE a.cycle_id = ? AND s.deleted_at IS NULL`,
    )
    .bind(cycleId)
    .first<{ n: number }>();
  if ((scored?.n ?? 0) > 0 && cycle.rubric_id !== rubricId) {
    throw new AppError('CONFLICT', 'Scoring has already started in this cycle.', {
      internalMessage: `attach rubric to cycle ${cycleId} with ${scored?.n} scores recorded`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await db.batch([
    // The program match is enforced by 0006's trigger. Not repeated here.
    db.prepare(`UPDATE cycles SET rubric_id = ?, updated_at = ? WHERE id = ?`)
      .bind(rubricId, now, cycleId),
    auditStatement(db, ctx, {
      action: 'cycle.updated',
      entityType: 'cycle',
      entityId: cycleId,
      before: { rubric_id: cycle.rubric_id },
      after: { rubric_id: rubricId, actor: session.userId },
    }),
  ]);

  return { cycleId, rubricId };
}
