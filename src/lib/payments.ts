/**
 * The payment ledger.
 *
 * WHAT THIS IS NOT, first, because it is the thing most easily misread.
 * CLAUDE.md: "The system does not disburse money. It records schedules and
 * status. Disbursement stays with finance." Nothing in this file moves a cent.
 * It records what was agreed, what finance says has gone out, and the gap --
 * which is the question the dashboard has been unable to answer since it was
 * built, and announces on every screen.
 *
 * SO THE VOCABULARY IS DELIBERATE. A payment is `scheduled` when the Foundation
 * has agreed it and `paid` when FINANCE SAYS SO. Marking one paid here is an
 * admin recording somebody else's fact, and the reference number is what makes
 * that fact checkable against the system that actually moved the money.
 *
 * MONEY IS INTEGER CENTS throughout, and a schedule is the place a rounding
 * error hides best: three instalments of a $25,000 grant are 833333, 833333
 * and 833334 cents, and any code that divides by three in dollars loses a cent
 * that nobody can find because it is a cent.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { MAX_CENTS } from './money';

export interface PaymentRow {
  id: string;
  awardId: string;
  amountCents: number;
  scheduledDate: string;
  paidDate: string | null;
  status: string;
  method: string | null;
  referenceNumber: string | null;
  note: string | null;
}

export interface AwardLedger {
  awardId: string;
  organizationName: string;
  awardedAmountCents: number;
  scheduledCents: number;
  paidCents: number;
  /** Awarded minus scheduled. Negative when a schedule overruns the award. */
  unscheduledCents: number;
  payments: PaymentRow[];
}

function assertAdmin(session: Session): void {
  // Grantees see their award, not the Foundation's payment machinery: when a
  // cheque was cut and under what reference is internal bookkeeping, and a
  // grantee reading a "paid" date the bank has not honoured yet would chase it.
  if (session.role !== 'admin') throw notFound('award');
}

function checkAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_CENTS) {
    throw new AppError('VALIDATION_FAILED', 'That is not an amount we can schedule.', {
      internalMessage: `payment amount rejected: ${String(amountCents)}`,
      severity: 'warn',
      fieldErrors: [{ field: 'amountCents', message: 'Enter a whole amount in dollars.' }],
    });
  }
}

/**
 * Every payment against one award, with the totals that matter.
 *
 * CANCELLED PAYMENTS ARE LISTED BUT NOT COUNTED. "We promised this and then
 * did not" is a question somebody asks, and a row that disappears cannot
 * answer it -- but a cancelled instalment is not scheduled money either.
 */
export async function awardLedger(
  db: D1Database,
  session: Session,
  awardId: string,
): Promise<AwardLedger> {
  assertAdmin(session);
  const award = await db
    .prepare(
      `SELECT w.id, w.awarded_amount_cents AS awardedAmountCents, o.legal_name AS organizationName
         FROM awards w
         JOIN organizations o ON o.id = w.organization_id
        WHERE w.id = ? AND w.deleted_at IS NULL`,
    )
    .bind(awardId)
    .first<{ id: string; awardedAmountCents: number; organizationName: string }>();
  if (!award) throw notFound('award');

  const { results } = await db
    .prepare(
      `SELECT id, award_id AS awardId, amount_cents AS amountCents,
              scheduled_date AS scheduledDate, paid_date AS paidDate, status,
              method, reference_number AS referenceNumber, note
         FROM payments
        WHERE award_id = ? AND deleted_at IS NULL
        ORDER BY scheduled_date, created_at`,
    )
    .bind(awardId)
    .all<PaymentRow>();

  const payments = results ?? [];
  const live = payments.filter((p) => p.status !== 'cancelled');
  const scheduledCents = live.reduce((t, p) => t + p.amountCents, 0);
  const paidCents = live
    .filter((p) => p.status === 'paid')
    .reduce((t, p) => t + p.amountCents, 0);

  return {
    awardId,
    organizationName: award.organizationName,
    awardedAmountCents: award.awardedAmountCents,
    scheduledCents,
    paidCents,
    unscheduledCents: award.awardedAmountCents - scheduledCents,
    payments,
  };
}

/**
 * Schedule one payment.
 *
 * OVER-SCHEDULING IS REFUSED. Instalments summing to more than the award is
 * always an error -- a typed extra zero, or a second person adding a schedule
 * that already existed -- and the consequence is a payment run that pays a
 * grantee more than the Foundation agreed. An amendment raises the award
 * first; this does not quietly allow it.
 */
export async function schedulePayment(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  awardId: string,
  input: { amountCents: number; scheduledDate: string; method?: string | null; note?: string | null },
): Promise<PaymentRow> {
  assertAdmin(session);
  checkAmount(input.amountCents);

  const when = (input.scheduledDate ?? '').trim();
  if (!when || !Number.isFinite(Date.parse(when))) {
    throw new AppError('VALIDATION_FAILED', 'That is not a date we can read.', {
      internalMessage: `unparseable scheduled_date ${when}`,
      severity: 'warn',
      fieldErrors: [{ field: 'scheduledDate', message: 'Choose the date it is due.' }],
    });
  }

  const ledger = await awardLedger(db, session, awardId);
  const after = ledger.scheduledCents + input.amountCents;
  if (after > ledger.awardedAmountCents) {
    throw new AppError(
      'CONFLICT',
      'That would schedule more than this award is for.',
      {
        internalMessage:
          `scheduling ${input.amountCents} would take ${ledger.awardId} to ${after} ` +
          `against ${ledger.awardedAmountCents}`,
        severity: 'warn',
        fieldErrors: [
          {
            field: 'amountCents',
            message:
              'The schedule already covers this award. Amend the award if the amount ' +
              'has changed.',
          },
        ],
      },
    );
  }

  const id = newId();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO payments (id, award_id, amount_cents, scheduled_date, status,
           method, note, created_at, updated_at)
         VALUES (?,?,?,?, 'scheduled', ?, ?, ?, ?)`,
      )
      .bind(
        id, awardId, input.amountCents, when,
        (input.method ?? '')?.toString().trim() || null,
        (input.note ?? '')?.toString().trim() || null,
        now, now,
      ),
    auditStatement(db, ctx, {
      action: 'payment.scheduled',
      entityType: 'payment',
      entityId: id,
      after: {
        award_id: awardId,
        amount_cents: input.amountCents,
        scheduled_date: when,
        status: 'scheduled',
        actor_user_id: session.userId,
      },
    }),
  ]);

  return {
    id, awardId, amountCents: input.amountCents, scheduledDate: when,
    paidDate: null, status: 'scheduled',
    method: (input.method ?? '')?.toString().trim() || null,
    referenceNumber: null,
    note: (input.note ?? '')?.toString().trim() || null,
  };
}

/**
 * Record that finance paid it.
 *
 * THE REFERENCE IS REQUIRED. "Paid" with nothing to look it up by is a claim
 * this system cannot support when a grantee says the money never arrived, and
 * that conversation is exactly when somebody opens this screen.
 *
 * SETTLED AFTERWARDS. A paid payment cannot be re-paid or have its amount
 * changed -- the schema refuses the second -- because both rewrite a figure
 * finance has already sent and the disbursed total with it. A genuine
 * correction is a new row.
 */
export async function recordPayment(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  paymentId: string,
  input: { paidDate: string; referenceNumber: string; method?: string | null },
): Promise<PaymentRow> {
  assertAdmin(session);

  const reference = (input.referenceNumber ?? '').trim();
  if (!reference) {
    throw new AppError('VALIDATION_FAILED', 'Record the payment reference.', {
      internalMessage: 'payment recorded with no reference',
      severity: 'warn',
      fieldErrors: [
        {
          field: 'referenceNumber',
          message:
            'The cheque number or transfer reference. It is what answers a grantee who ' +
            'says the money has not arrived.',
        },
      ],
    });
  }
  const paid = (input.paidDate ?? '').trim();
  if (!paid || !Number.isFinite(Date.parse(paid))) {
    throw new AppError('VALIDATION_FAILED', 'That is not a date we can read.', {
      internalMessage: `unparseable paid_date ${paid}`,
      severity: 'warn',
      fieldErrors: [{ field: 'paidDate', message: 'Choose the date it went out.' }],
    });
  }

  const row = await db
    .prepare(
      `SELECT id, award_id AS awardId, amount_cents AS amountCents,
              scheduled_date AS scheduledDate, status
         FROM payments WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(paymentId)
    .first<{ id: string; awardId: string; amountCents: number; scheduledDate: string; status: string }>();
  if (!row) throw notFound('payment');
  if (row.status !== 'scheduled') {
    throw new AppError('CONFLICT', `This payment is already ${row.status}.`, {
      internalMessage: `recordPayment on ${paymentId} in status ${row.status}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE payments
            SET status = 'paid', paid_date = ?, reference_number = ?,
                method = COALESCE(?, method), updated_at = ?
          WHERE id = ? AND status = 'scheduled' AND deleted_at IS NULL`,
      )
      .bind(paid, reference, (input.method ?? '')?.toString().trim() || null, now, paymentId),
    auditStatement(db, ctx, {
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: paymentId,
      before: { status: 'scheduled', paid_date: null },
      after: {
        status: 'paid',
        paid_date: paid,
        reference_number: reference,
        amount_cents: row.amountCents,
        award_id: row.awardId,
        actor_user_id: session.userId,
      },
    }),
  ]);

  return {
    id: paymentId, awardId: row.awardId, amountCents: row.amountCents,
    scheduledDate: row.scheduledDate, paidDate: paid, status: 'paid',
    method: (input.method ?? '')?.toString().trim() || null,
    referenceNumber: reference, note: null,
  };
}

/**
 * Cancel a scheduled payment, with a reason.
 *
 * NOT A DELETE. "We promised this and then did not" is the question an auditor
 * asks, and a deleted row cannot answer it. A cancelled payment stays listed
 * and stops counting towards the scheduled total, which frees the amount to be
 * scheduled again.
 */
export async function cancelPayment(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  paymentId: string,
  reason: string,
): Promise<{ paymentId: string; status: string }> {
  assertAdmin(session);
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 3) {
    throw new AppError('VALIDATION_FAILED', 'Say why this payment is not happening.', {
      internalMessage: 'payment cancelled with no reason',
      severity: 'warn',
      fieldErrors: [{ field: 'reason', message: 'A sentence is enough.' }],
    });
  }

  const row = await db
    .prepare(`SELECT id, status, award_id AS awardId FROM payments WHERE id = ? AND deleted_at IS NULL`)
    .bind(paymentId)
    .first<{ id: string; status: string; awardId: string }>();
  if (!row) throw notFound('payment');
  if (row.status !== 'scheduled') {
    // A paid payment is finance's record of money that left. Cancelling it
    // here would claim otherwise.
    throw new AppError('CONFLICT', `This payment is already ${row.status}.`, {
      internalMessage: `cancelPayment on ${paymentId} in status ${row.status}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE payments SET status = 'cancelled', note = ?, updated_at = ?
          WHERE id = ? AND status = 'scheduled' AND deleted_at IS NULL`,
      )
      .bind(trimmed, now, paymentId),
    auditStatement(db, ctx, {
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: paymentId,
      before: { status: 'scheduled' },
      after: { status: 'cancelled', note: trimmed, award_id: row.awardId, actor_user_id: session.userId },
    }),
  ]);

  return { paymentId, status: 'cancelled' };
}

export interface DisbursementLine {
  programId: string;
  programName: string;
  fiscalYear: number | null;
  committedCents: number;
  scheduledCents: number;
  paidCents: number;
}

/**
 * Committed, scheduled and paid, per program.
 *
 * THE NUMBER THE DASHBOARD HAS BEEN MISSING. CLAUDE.md asks for committed
 * versus disbursed and the dashboard has said, on every screen and in every
 * export, that it could not answer the second half.
 *
 * THREE NUMBERS, NOT TWO, because the gap between committed and paid is two
 * different problems wearing the same trousers: money nobody has scheduled yet
 * is a planning question, and money scheduled and not paid is a finance
 * question. A single "outstanding" figure sends the wrong person after it.
 */
export async function disbursementByProgram(
  db: D1Database,
  session: Session,
): Promise<DisbursementLine[]> {
  assertAdmin(session);
  const { results } = await db
    .prepare(
      `SELECT p.id AS programId, p.name AS programName, p.fiscal_year AS fiscalYear,
              COALESCE(SUM(w.awarded_amount_cents), 0) AS committedCents,
              COALESCE((
                SELECT SUM(pay.amount_cents) FROM payments pay
                  JOIN awards aw ON aw.id = pay.award_id
                 WHERE aw.program_id = p.id AND aw.deleted_at IS NULL
                   AND aw.status <> 'cancelled'
                   AND pay.deleted_at IS NULL AND pay.status <> 'cancelled'
              ), 0) AS scheduledCents,
              COALESCE((
                SELECT SUM(pay.amount_cents) FROM payments pay
                  JOIN awards aw ON aw.id = pay.award_id
                 WHERE aw.program_id = p.id AND aw.deleted_at IS NULL
                   -- NO STATUS FILTER HERE, unlike the two above, and it is
                   -- deliberate. Committed and scheduled are statements about
                   -- intent, and a rescinded award has none. A PAID payment
                   -- is a statement about money that left the building, and it
                   -- left
                   -- whatever happened to the award afterwards.
                   --
                   -- The consequence is that paid can exceed committed for a
                   -- program where a grant was paid and later rescinded. That
                   -- looks wrong on a dashboard and is true, and it is
                   -- precisely the case somebody should be able to see rather
                   -- than one the arithmetic should quietly absorb.
                   AND pay.deleted_at IS NULL AND pay.status = 'paid'
              ), 0) AS paidCents
         FROM programs p
         LEFT JOIN awards w
           ON w.program_id = p.id AND w.deleted_at IS NULL AND w.status <> 'cancelled'
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
        ORDER BY p.name`,
    )
    .all<DisbursementLine>();
  return results ?? [];
}
