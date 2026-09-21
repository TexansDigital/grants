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
