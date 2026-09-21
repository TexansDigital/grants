/**
 * Turning a decision into an award record.
 *
 * WHY THESE ARE SEPARATE, which is the whole reason this file exists rather
 * than a few lines inside decideApplication.
 *
 * A DECISION IS AN INTENT. An award is a commitment with an amount, a term and
 * a set of obligations attached to it. They come apart in practice more often
 * than anyone expects: the board approves "up to $50,000" and finance settles
 * the number later; a grantee declines; the amount is split across two fiscal
 * years; the terms are renegotiated before anything is signed. A system that
 * created the award at the moment of the decision would have to amend or
 * delete it every one of those times.
 *
 * It also keeps CLAUDE.md's rule about W-9s true. Tax documents and the media
 * release are collected at ACCEPTANCE, not application -- which cannot be the
 * case if an award springs into existence the instant somebody records a
 * decision, because then every awarded application is already a live award
 * with obligations before the grantee has said yes.
 *
 * So an award starts `pending`: decided, not yet accepted. The grantee portal,
 * the report periods and the payment schedule all hang off the award rather
 * than off the application, and none of them should exist until this row does.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { assertCents, MAX_CENTS } from './money';

export interface AwardInput {
  /** INTEGER CENTS. Parsed at the display edge, never here. */
  awardedAmountCents: number;
  /**
   * When the grantee may talk about it. Separate from the decision date
   * because grantees told on Tuesday post on Tuesday, and the award letter
   * carries this as its own block.
   */
  announcementDate?: string | null;
  termStart?: string | null;
  termEnd?: string | null;
  isMultiYear?: boolean;
  /** A renewal points at what it renews. Never a duplicated record. */
  parentAwardId?: string | null;
  notes?: string | null;
}

export interface AwardResult {
  awardId: string;
  applicationId: string;
  awardedAmountCents: number;
  status: string;
}

function isDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * Create the award for an application that was awarded.
 *
 * ADMIN ONLY, and refused unless the application's decision says `awarded`.
 * An award against a declined application is always a mistaken id, and it
 * would put a grantee in the portal who was told no.
 *
 * ONE LIVE AWARD PER APPLICATION. A second is either a double-click or two
 * people working the same list, and both produce a committed total that is
 * twice what the Foundation agreed. The check is here AND the caller sees a
 * conflict rather than a silent second row.
 */
export async function createAwardFromDecision(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  input: AwardInput,
): Promise<AwardResult> {
  if (session.role !== 'admin') throw notFound('application');

  const app = await db
    .prepare(
      `SELECT a.id, a.status, a.decided_at AS decidedAt, a.organization_id AS organizationId,
              c.program_id AS programId, a.cycle_id AS cycleId
         FROM applications a
         JOIN cycles c ON c.id = a.cycle_id
        WHERE a.id = ? AND a.deleted_at IS NULL`,
    )
    .bind(applicationId)
    .first<{
      id: string; status: string; decidedAt: string | null;
      organizationId: string; programId: string; cycleId: string;
    }>();
  if (!app) throw notFound('application');

  if (app.status !== 'awarded' || !app.decidedAt) {
    throw new AppError('CONFLICT', 'Record an award decision on this application first.', {
      internalMessage: `award creation for ${applicationId} in status ${app.status}`,
      severity: 'warn',
    });
  }

  const existing = await db
    .prepare(
      `SELECT id FROM awards WHERE application_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(applicationId)
    .first<{ id: string }>();
  if (existing) {
    throw new AppError('CONFLICT', 'This application already has an award.', {
      internalMessage: `second award for ${applicationId}, existing ${existing.id}`,
      severity: 'warn',
    });
  }

  /*
   * INTEGER CENTS, asserted rather than coerced.
   *
   * assertCents refuses a float, a string and a negative. The ceiling is the
   * same one the column carries: ten billion cents is a hundred million
   * dollars, four orders of magnitude above anything this program will award,
   * and still catches a misplaced decimal typed by a human.
   *
   * Zero is refused HERE though the column allows it. The column has to admit
   * zero for an imported historical record that was rescinded; a new award of
   * nothing is somebody who has not filled the field in.
   */
  /*
   * EVERY CHECK HERE COMES BEFORE assertCents, which is then a backstop.
   *
   * assertCents throws a MoneyParseError, which is not an AppError -- so a
   * float or an out-of-range value arriving from the browser would reach an
   * admin as an INTERNAL "something went wrong", on a form where the thing
   * that went wrong is a decimal point they can see. Each case gets a message
   * and a field first; assertCents stays to catch anything reaching this
   * function from a caller that skipped the form.
   *
   * Zero is refused though the COLUMN allows it: the column has to admit zero
   * for an imported historical record that was rescinded, and a new award of
   * nothing is somebody who has not filled the field in.
   *
   * The ceiling is the column's own: ten billion cents is a hundred million
   * dollars, four orders of magnitude above anything this program will award,
   * and still catches a misplaced decimal typed by a human.
   */
  const amountProblem =
    !Number.isInteger(input.awardedAmountCents)
      ? 'That amount is not a whole number of cents.'
      : input.awardedAmountCents <= 0
        ? 'An award needs an amount.'
        : input.awardedAmountCents > MAX_CENTS
          ? 'That amount looks like a typo.'
          : null;
  if (amountProblem) {
    throw new AppError('VALIDATION_FAILED', amountProblem, {
      internalMessage: `award amount rejected: ${String(input.awardedAmountCents)}`,
      severity: 'warn',
      fieldErrors: [{ field: 'awardedAmountCents', message: 'Check the amount awarded.' }],
    });
  }
  assertCents(input.awardedAmountCents, 'award amount');

  const fields: { key: 'announcementDate' | 'termStart' | 'termEnd'; label: string }[] = [
    { key: 'announcementDate', label: 'announcement date' },
    { key: 'termStart', label: 'term start' },
    { key: 'termEnd', label: 'term end' },
  ];
  for (const f of fields) {
    const v = input[f.key];
    if (v != null && v !== '' && !isDate(v)) {
      throw new AppError('VALIDATION_FAILED', `That is not a ${f.label} we can read.`, {
        internalMessage: `unparseable ${f.key}: ${String(v)}`,
        severity: 'warn',
        fieldErrors: [{ field: f.key, message: `Check the ${f.label}.` }],
      });
    }
  }

  const termStart = input.termStart || null;
  const termEnd = input.termEnd || null;
  if (termStart && termEnd && Date.parse(termEnd) < Date.parse(termStart)) {
    /*
     * The column CHECKs this too. Said here because the term drives every
     * report due date generated from it, and a RAISE(ABORT) would reach an
     * admin as an INTERNAL error rather than as "check these two dates".
     */
    throw new AppError('VALIDATION_FAILED', 'The term ends before it starts.', {
      internalMessage: `term_end ${termEnd} before term_start ${termStart}`,
      severity: 'warn',
      fieldErrors: [{ field: 'termEnd', message: 'The end date is before the start date.' }],
    });
  }

  if (input.parentAwardId) {
    // A renewal points at what it renews. An unknown parent is a typed id, and
    // a renewal chain that dangles is one nobody can follow back.
    const parent = await db
      .prepare(`SELECT id, organization_id AS organizationId FROM awards
                 WHERE id = ? AND deleted_at IS NULL`)
      .bind(input.parentAwardId)
      .first<{ id: string; organizationId: string }>();
    if (!parent) throw notFound('award');
    if (parent.organizationId !== app.organizationId) {
      throw new AppError('VALIDATION_FAILED', 'That earlier award belongs to a different organization.', {
        internalMessage: `parent award ${input.parentAwardId} on another organization`,
        severity: 'warn',
      });
    }
  }

  const awardId = newId();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO awards (id, application_id, organization_id, program_id, cycle_id,
           awarded_amount_cents, awarded_at, announcement_date, term_start, term_end,
           is_multi_year, parent_award_id, status, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)`,
      )
      .bind(
        awardId, applicationId, app.organizationId, app.programId, app.cycleId,
        input.awardedAmountCents,
        // awarded_at is the DECISION's date, not today. The award record can
        // be created weeks later; dating it now would misreport the fiscal
        // year on every total the dashboard builds.
        app.decidedAt,
        input.announcementDate || null,
        termStart, termEnd,
        input.isMultiYear ? 1 : 0,
        input.parentAwardId || null,
        (input.notes ?? '')?.toString().trim() || null,
        now, now,
      ),
    auditStatement(db, ctx, {
      action: 'award.created',
      entityType: 'award',
      entityId: awardId,
      after: {
        application_id: applicationId,
        organization_id: app.organizationId,
        program_id: app.programId,
        awarded_amount_cents: input.awardedAmountCents,
        awarded_at: app.decidedAt,
        announcement_date: input.announcementDate || null,
        term_start: termStart,
        term_end: termEnd,
        is_multi_year: input.isMultiYear ? 1 : 0,
        parent_award_id: input.parentAwardId || null,
        status: 'pending',
        actor_user_id: session.userId,
      },
    }),
  ]);

  return {
    awardId,
    applicationId,
    awardedAmountCents: input.awardedAmountCents,
    status: 'pending',
  };
}

export interface BudgetLine {
  programId: string;
  programName: string;
  fiscalYear: number | null;
  totalBudgetCents: number | null;
  committedCents: number;
  awards: number;
  /** True when commitments exceed the program's stated budget. */
  overBudget: boolean;
}

/**
 * Committed against budget, per program.
 *
 * CLAUDE.md asks for "running totals against program budget with a flag when
 * committed exceeds budget". Cancelled awards are excluded -- a rescinded
 * grant is not a commitment -- and pending ones are INCLUDED, because money
 * offered and not yet accepted is still money the Foundation cannot offer
 * twice.
 */
export async function budgetByProgram(
  db: D1Database,
  session: Session,
): Promise<BudgetLine[]> {
  if (session.role !== 'admin') throw notFound('program');
  const { results } = await db
    .prepare(
      `SELECT p.id AS programId, p.name AS programName, p.fiscal_year AS fiscalYear,
              p.total_budget_cents AS totalBudgetCents,
              COALESCE(SUM(w.awarded_amount_cents), 0) AS committedCents,
              COUNT(w.id) AS awards
         FROM programs p
         LEFT JOIN awards w
           ON w.program_id = p.id
          AND w.deleted_at IS NULL
          AND w.status <> 'cancelled'
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
        ORDER BY p.name`,
    )
    .bind()
    .all<Omit<BudgetLine, 'overBudget'>>();
  return (results ?? []).map((r) => ({
    ...r,
    overBudget: r.totalBudgetCents !== null && r.committedCents > r.totalBudgetCents,
  }));
}

// ---------------------------------------------------------------------------
// Amending one
// ---------------------------------------------------------------------------

/** The four fields an amendment may move. Everything else has its own path. */
export const AMENDABLE = [
  'awarded_amount_cents',
  'term_start',
  'term_end',
  'announcement_date',
] as const;
export type AmendableField = (typeof AMENDABLE)[number];

export interface AmendmentInput {
  /** Integer cents. Omit to leave the amount alone; null is not an amount. */
  awardedAmountCents?: number;
  termStart?: string | null;
  termEnd?: string | null;
  announcementDate?: string | null;
  /** Required. The whole content of an amendment; the amount is on the award. */
  reason: string;
  /**
   * The `updated_at` the caller believes the award carries.
   *
   * OPTIMISTIC LOCKING, and CLAUDE.md names its absence as a known gap: "Two
   * admins on one award produces last-write-wins unless optimistic locking is
   * built deliberately." Two people working a decision week from the same
   * spreadsheet is not a hypothetical, and last-write-wins on an award amount
   * means one of them believes a number that is not in the database. Omit it
   * and the write proceeds unguarded -- which is honest about scripts and
   * imports, and is never what the UI does.
   */
  expectedUpdatedAt?: string;
}

export interface AmendmentRow {
  id: string;
  awardId: string;
  amendedAt: string;
  amendedBy: string;
  fieldChanged: AmendableField;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
}

/** Every change ever made to one award, oldest first. */
export async function amendmentHistory(
  db: D1Database,
  session: Session,
  awardId: string,
): Promise<AmendmentRow[]> {
  if (session.role !== 'admin') throw notFound('award');
  const { results } = await db
    .prepare(
      `SELECT a.id, a.award_id AS awardId, a.amended_at AS amendedAt,
              COALESCE(u.email, a.amended_by) AS amendedBy,
              a.field_changed AS fieldChanged,
              a.old_value AS oldValue, a.new_value AS newValue, a.reason
         FROM award_amendments a
         LEFT JOIN users u ON u.id = a.amended_by
        WHERE a.award_id = ?
        ORDER BY a.amended_at, a.created_at`,
    )
    .bind(awardId)
    .all<AmendmentRow>();
  return results ?? [];
}

/**
 * Change an award, and record the change.
 *
 * WHY THIS EXISTS AT ALL. 0012 refuses to let an awarded amount be updated,
 * pointing at an amendments table that Phase 4 never built -- so an award
 * recorded at the wrong amount could not be corrected through this system in
 * any way, and the documented remedy amounted to editing the production
 * database by hand. CLAUDE.md's Module 3 asks for "amendments tracked, never
 * overwritten"; this is that, and 0024's triggers make it the only door.
 *
 * WHAT IT WILL NOT DO:
 *
 *   - Amend a cancelled award. That grant did not happen; changing its terms
 *     produces a record of a commitment nobody made.
 *   - Cut the amount below what has already been PAID. Finance has moved that
 *     money. An award for less than was disbursed is a reconciliation problem
 *     the moment it is written, and the number to fix is not this one.
 *   - Accept an amendment that changes nothing. A reason attached to no change
 *     is a row somebody has to explain.
 *
 * WHAT IT DELIBERATELY WILL DO: cut the amount below what is SCHEDULED. A
 * reduced award with an over-committed schedule is exactly the situation an
 * amendment exists to start, and the payment ledger already says, in words,
 * when a schedule overruns its award. Refusing here would force somebody to
 * cancel payments before they are allowed to record the fact that prompted it.
 */
export async function amendAward(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  awardId: string,
  input: AmendmentInput,
): Promise<{ awardId: string; changed: AmendableField[]; updatedAt: string }> {
  if (session.role !== 'admin') throw notFound('award');

  const reason = (input.reason ?? '').trim();
  if (reason.length < 3) {
    throw new AppError('VALIDATION_FAILED', 'Say why this award is being changed.', {
      internalMessage: 'amendment with an empty or near-empty reason',
      severity: 'warn',
      fieldErrors: [{ field: 'reason', message: 'Say why this award is being changed.' }],
    });
  }

  const award = await db
    .prepare(
      `SELECT id, status, updated_at AS updatedAt,
              awarded_amount_cents AS amountCents,
              term_start AS termStart, term_end AS termEnd,
              announcement_date AS announcementDate,
              COALESCE((
                SELECT SUM(p.amount_cents) FROM payments p
                 WHERE p.award_id = awards.id AND p.deleted_at IS NULL
                   AND p.status = 'paid'
              ), 0) AS paidCents
         FROM awards WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(awardId)
    .first<{
      id: string; status: string; updatedAt: string; amountCents: number;
      termStart: string | null; termEnd: string | null;
      announcementDate: string | null; paidCents: number;
    }>();
  if (!award) throw notFound('award');

  if (award.status === 'cancelled') {
    throw new AppError('CONFLICT', 'This award was cancelled, so there is nothing to amend.', {
      internalMessage: `amendment on cancelled award ${awardId}`,
      severity: 'warn',
    });
  }

  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== award.updatedAt) {
    /*
     * Somebody else changed this award between the screen loading and the
     * button being pressed. Refusing and saying so is the whole point: the
     * alternative is that their change disappears and neither of them knows.
     */
    throw new AppError(
      'CONFLICT',
      'Somebody else changed this award while you were working on it. Reload and look at it again.',
      {
        internalMessage: `stale amendment on ${awardId}: expected ${input.expectedUpdatedAt}, found ${award.updatedAt}`,
        severity: 'warn',
      },
    );
  }

  const changes: { field: AmendableField; oldValue: string | null; newValue: string | null }[] = [];

  if (input.awardedAmountCents !== undefined) {
    assertCents(input.awardedAmountCents, 'awarded amount');
    if (input.awardedAmountCents > MAX_CENTS) {
      throw new AppError('VALIDATION_FAILED', 'That amount is too large.', {
        internalMessage: `amendment amount ${input.awardedAmountCents} above MAX_CENTS`,
        severity: 'warn',
      });
    }
    if (input.awardedAmountCents < award.paidCents) {
      throw new AppError(
        'CONFLICT',
        'This award cannot be reduced below what has already been paid out.',
        {
          internalMessage:
            `amendment to ${input.awardedAmountCents} below paid ${award.paidCents} on ${awardId}`,
          severity: 'warn',
          fieldErrors: [
            { field: 'awardedAmountCents', message: 'Less than has already been paid.' },
          ],
        },
      );
    }
    if (input.awardedAmountCents !== award.amountCents) {
      changes.push({
        field: 'awarded_amount_cents',
        // CENTS AS A STRING, never formatted. A record that says "$18,000"
        // cannot be compared with the column it came from.
        oldValue: String(award.amountCents),
        newValue: String(input.awardedAmountCents),
      });
    }
  }

  const dateFields: [keyof AmendmentInput, AmendableField, string | null][] = [
    ['termStart', 'term_start', award.termStart],
    ['termEnd', 'term_end', award.termEnd],
    ['announcementDate', 'announcement_date', award.announcementDate],
  ];
  for (const [key, field, current] of dateFields) {
    if (!(key in input)) continue;
    const raw = input[key] as string | null | undefined;
    const next = raw === null || raw === '' ? null : String(raw);
    if (next !== null && !isDate(next)) {
      throw new AppError('VALIDATION_FAILED', 'That is not a date we can read.', {
        internalMessage: `amendment ${field} unparseable: ${next}`,
        severity: 'warn',
        fieldErrors: [{ field: String(key), message: 'That is not a date we can read.' }],
      });
    }
    if (next !== current) changes.push({ field, oldValue: current, newValue: next });
  }

  if (changes.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Nothing on this award would change.', {
      internalMessage: `amendment on ${awardId} with no changes`,
      severity: 'warn',
    });
  }

  // The resulting term, checked here so the schema CHECK does not reach an
  // admin as an INTERNAL error from a constraint name.
  const nextStart = changes.find((c) => c.field === 'term_start')?.newValue ?? award.termStart;
  const nextEnd = changes.find((c) => c.field === 'term_end')?.newValue ?? award.termEnd;
  if (nextStart && nextEnd && nextEnd < nextStart) {
    throw new AppError('VALIDATION_FAILED', 'A grant term cannot end before it starts.', {
      internalMessage: `amendment term ${nextStart}..${nextEnd} on ${awardId}`,
      severity: 'warn',
      fieldErrors: [{ field: 'termEnd', message: 'This is before the term starts.' }],
    });
  }

  const now = nowIso();

  /*
   * THE AMENDMENT ROWS GO FIRST, and the ordering is load-bearing rather than
   * stylistic. 0024's triggers let the amount and the term move only when a
   * matching amendment row already exists stamped at this same instant; in a
   * D1 batch the statements run in order, so an UPDATE placed before its
   * INSERT is refused by the database. That is the guarantee: the columns
   * cannot move without the record, no matter what a future caller does.
   */
  const statements = changes.map((c) =>
    db
      .prepare(
        `INSERT INTO award_amendments
           (id, award_id, amended_at, amended_by, field_changed, old_value, new_value,
            reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(newId(), awardId, now, session.userId, c.field, c.oldValue, c.newValue, reason, now),
  );

  const sets = changes.map((c) => `${c.field} = ?`).join(', ');
  const binds = changes.map((c) =>
    c.field === 'awarded_amount_cents' ? Number(c.newValue) : c.newValue,
  );
  statements.push(
    db
      .prepare(
        `UPDATE awards SET ${sets}, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND status <> 'cancelled'
            ${input.expectedUpdatedAt !== undefined ? 'AND updated_at = ?' : ''}`,
      )
      .bind(
        ...binds,
        now,
        awardId,
        ...(input.expectedUpdatedAt !== undefined ? [input.expectedUpdatedAt] : []),
      ),
  );

  statements.push(
    auditStatement(
      db,
      ctx,
      {
        action: 'award.amended',
        entityType: 'award',
        entityId: awardId,
        before: Object.fromEntries(changes.map((c) => [c.field, c.oldValue])),
        after: {
          ...Object.fromEntries(changes.map((c) => [c.field, c.newValue])),
          reason,
          actor_user_id: session.userId,
        },
      },
      {
        guard: {
          sql: `EXISTS (SELECT 1 FROM awards WHERE id = ? AND updated_at = ?)`,
          binds: [awardId, now],
        },
      },
    ),
  );

  const results = await db.batch(statements);
  const write = results[changes.length];
  if ((write?.meta?.changes ?? 0) === 0) {
    // The re-asserted predicate did not match: cancelled, deleted, or moved
    // under us between the read and the write.
    throw new AppError('CONFLICT', 'Somebody else changed this award first.', {
      internalMessage: `amendment UPDATE on ${awardId} matched no row`,
      severity: 'warn',
    });
  }

  return { awardId, changed: changes.map((c) => c.field), updatedAt: now };
}
