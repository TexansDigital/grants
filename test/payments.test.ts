/**
 * The payment ledger.
 *
 * WHAT IT IS NOT, first. CLAUDE.md: "The system does not disburse money. It
 * records schedules and status. Disbursement stays with finance." Nothing
 * under test here moves a cent. What is at risk is the record: a schedule that
 * promises more than the award, a "paid" nobody can look up when a grantee says
 * the money never arrived, a settled figure rewritten after finance sent it,
 * and a cancelled instalment that vanishes instead of being answerable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import { createAwardFromDecision } from '../src/lib/awards';
import {
  awardLedger, schedulePayment, recordPayment, cancelPayment, disbursementByProgram,
} from '../src/lib/payments';
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
    .bind(id, `pay-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString();

async function awarded(amountCents = 2_500_000) {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `pay-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const orgId = newId();
  const applicationId = newId();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Trustees ${n}`, String(980000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, project_title, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(applicationId, cycleId, orgId, now, `Project ${n}`, now, now, p.formDefinitionIds.application!)
    .run();
  await decideApplication(db, ctx(), admin, applicationId, { status: 'awarded' });
  const award = await createAwardFromDecision(db, ctx(), admin, applicationId, {
    awardedAmountCents: amountCents,
  });
  return { programId: p.programId, orgId, awardId: award.awardId, amountCents };
}

// ---------------------------------------------------------------------------

describe('scheduling', () => {
  it('keeps instalments in exact cents', async () => {
    /*
     * A SCHEDULE IS WHERE A ROUNDING ERROR HIDES BEST. Three instalments of a
     * $25,000 grant are 833333, 833333 and 833334 cents; any code that divides
     * by three in dollars loses a cent nobody can find, because it is a cent.
     */
    const a = await awarded(2_500_000);
    for (const cents of [833_333, 833_333, 833_334]) {
      await schedulePayment(db, ctx(), admin, a.awardId, {
        amountCents: cents, scheduledDate: day(30),
      });
    }
    const ledger = await awardLedger(db, admin, a.awardId);
    expect(ledger.scheduledCents).toBe(2_500_000);
    expect(ledger.unscheduledCents).toBe(0);
    expect(ledger.payments.length).toBe(3);
  });

  it('refuses a schedule that exceeds the award', async () => {
    /*
     * THE BUG THIS PREVENTS. Instalments summing to more than the award is
     * always an error -- a typed extra zero, or a second person adding a
     * schedule that already existed -- and the consequence is a payment run
     * that pays a grantee more than the Foundation agreed.
     */
    const a = await awarded(1_000_000);
    await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 800_000, scheduledDate: day(10),
    });
    const err = await appErrorFrom(
      schedulePayment(db, ctx(), admin, a.awardId, {
        amountCents: 300_000, scheduledDate: day(20),
      }),
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/more than this award is for/i);
    expect((await awardLedger(db, admin, a.awardId)).scheduledCents).toBe(800_000);
  });

  it('holds the ceiling in SQL, not only in the read before it', async () => {
    /*
     * THE RACE THIS CLOSES, reproduced by an adversarial review and not by
     * this suite. `awardLedger` is read, the sum is compared in JavaScript,
     * and the INSERT runs after an await. Two admins scheduling at the same
     * moment both passed: a $10,000 award ended with two $9,000 instalments,
     * an unscheduledCents of minus $8,000, and a payment run that would pay a
     * grantee $18,000.
     *
     * Simulated here by calling both WITHOUT awaiting in between, which is the
     * same interleaving the two requests produce.
     */
    const a = await awarded(1_000_000);
    const results = await Promise.allSettled([
      schedulePayment(db, ctx(), admin, a.awardId, {
        amountCents: 900_000, scheduledDate: day(10),
      }),
      schedulePayment(db, ctx(), admin, a.awardId, {
        amountCents: 900_000, scheduledDate: day(20),
      }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length, 'exactly one instalment should land').toBe(1);

    const ledger = await awardLedger(db, admin, a.awardId);
    expect(ledger.scheduledCents).toBe(900_000);
    // The number the module promises: never negative, because the award is
    // never over-scheduled.
    expect(ledger.unscheduledCents).toBeGreaterThanOrEqual(0);

    // And the loser wrote no audit row, so the log does not claim a payment
    // that does not exist.
    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log al
           JOIN payments p ON p.id = al.entity_id
          WHERE al.action = 'payment.scheduled' AND p.award_id = ?`,
      )
      .bind(a.awardId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('refuses a float, a zero and a date it cannot read', async () => {
    const a = await awarded();
    for (const cents of [2500.5, 0, -100]) {
      expect(
        (await appErrorFrom(
          schedulePayment(db, ctx(), admin, a.awardId, {
            amountCents: cents, scheduledDate: day(10),
          }),
        )).code,
      ).toBe('VALIDATION_FAILED');
    }
    expect(
      (await appErrorFrom(
        schedulePayment(db, ctx(), admin, a.awardId, {
          amountCents: 1000, scheduledDate: 'next Tuesday',
        }),
      )).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses an award that does not exist', async () => {
    expect(
      (await appErrorFrom(
        schedulePayment(db, ctx(), admin, newId(), {
          amountCents: 1000, scheduledDate: day(10),
        }),
      )).code,
    ).toBe('NOT_FOUND');
  });
});

describe('recording what finance paid', () => {
  it('requires a reference, because that is what answers a grantee', async () => {
    /*
     * "Paid" with nothing to look it up by is a claim this system cannot
     * support when a grantee says the money never arrived -- and that
     * conversation is exactly when somebody opens this screen.
     */
    const a = await awarded();
    const p = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 500_000, scheduledDate: day(5),
    });
    const err = await appErrorFrom(
      recordPayment(db, ctx(), admin, p.id, { paidDate: day(0), referenceNumber: '  ' }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.fieldErrors?.[0]?.field).toBe('referenceNumber');
    expect((await awardLedger(db, admin, a.awardId)).paidCents).toBe(0);
  });

  it('records it once and refuses a second time', async () => {
    const a = await awarded();
    const p = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 500_000, scheduledDate: day(5),
    });
    await recordPayment(db, ctx(), admin, p.id, {
      paidDate: day(0), referenceNumber: 'CHQ-10412',
    });
    expect((await awardLedger(db, admin, a.awardId)).paidCents).toBe(500_000);

    expect(
      (await appErrorFrom(
        recordPayment(db, ctx(), admin, p.id, { paidDate: day(0), referenceNumber: 'CHQ-10413' }),
      )).code,
    ).toBe('CONFLICT');
  });

  it('will not let a settled amount be rewritten, and the schema refuses it too', async () => {
    /*
     * Changing a paid amount rewrites a figure finance has already sent, and
     * the disbursed total with it. A genuine correction is a new row.
     */
    const a = await awarded();
    const p = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 500_000, scheduledDate: day(5),
    });
    await recordPayment(db, ctx(), admin, p.id, { paidDate: day(0), referenceNumber: 'CHQ-1' });

    await expect(
      db.prepare(`UPDATE payments SET amount_cents = 900000 WHERE id = ?`).bind(p.id).run(),
    ).rejects.toThrow();
  });

  it('is refused by the schema if paid has no date', async () => {
    // A payment marked paid with no date cannot answer "when", which is the
    // whole point of recording it.
    const a = await awarded();
    const p = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 500_000, scheduledDate: day(5),
    });
    await expect(
      db.prepare(`UPDATE payments SET status = 'paid' WHERE id = ?`).bind(p.id).run(),
    ).rejects.toThrow();
  });
});

describe('cancelling', () => {
  it('keeps the row, stops counting it, and frees the amount', async () => {
    /*
     * NOT A DELETE. "We promised this and then did not" is a question an
     * auditor asks, and a deleted row cannot answer it.
     */
    const a = await awarded(1_000_000);
    const p = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 1_000_000, scheduledDate: day(10),
    });
    await cancelPayment(db, ctx(), admin, p.id, 'Grant returned unspent.');

    const ledger = await awardLedger(db, admin, a.awardId);
    expect(ledger.payments.length).toBe(1);
    expect(ledger.payments[0]!.status).toBe('cancelled');
    expect(ledger.scheduledCents).toBe(0);
    expect(ledger.unscheduledCents).toBe(1_000_000);

    // And the freed amount can be scheduled again.
    await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 1_000_000, scheduledDate: day(40),
    });
    expect((await awardLedger(db, admin, a.awardId)).scheduledCents).toBe(1_000_000);
  });

  it('refuses without a reason, in the code and in the schema', async () => {
    const a = await awarded();
    const p = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 500_000, scheduledDate: day(5),
    });
    expect((await appErrorFrom(cancelPayment(db, ctx(), admin, p.id, ' '))).code)
      .toBe('VALIDATION_FAILED');

    await expect(
      db.prepare(`UPDATE payments SET status = 'cancelled' WHERE id = ?`).bind(p.id).run(),
    ).rejects.toThrow();
  });

  it('refuses to cancel a payment finance has already sent', async () => {
    // A paid payment is finance's record of money that left. Cancelling it
    // here would claim otherwise.
    const a = await awarded();
    const p = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 500_000, scheduledDate: day(5),
    });
    await recordPayment(db, ctx(), admin, p.id, { paidDate: day(0), referenceNumber: 'CHQ-1' });
    expect((await appErrorFrom(cancelPayment(db, ctx(), admin, p.id, 'oops'))).code)
      .toBe('CONFLICT');
  });
});

describe('committed versus disbursed', () => {
  it('reports three numbers, because the gap is two different problems', async () => {
    /*
     * Money nobody has scheduled is a planning question; money scheduled and
     * unpaid is a finance question. One "outstanding" figure sends the wrong
     * person after it.
     */
    const a = await awarded(3_000_000);
    const first = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 1_000_000, scheduledDate: day(5),
    });
    await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 1_000_000, scheduledDate: day(60),
    });
    await recordPayment(db, ctx(), admin, first.id, {
      paidDate: day(0), referenceNumber: 'CHQ-9',
    });

    const line = (await disbursementByProgram(db, admin)).find((r) => r.programId === a.programId)!;
    expect(line.committedCents).toBe(3_000_000);
    expect(line.scheduledCents).toBe(2_000_000);
    expect(line.paidCents).toBe(1_000_000);
  });

  it('drops a cancelled award from committed and scheduled', async () => {
    // Both are statements about intent, and a rescinded award has none.
    const a = await awarded(1_000_000);
    await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 1_000_000, scheduledDate: day(5),
    });
    await db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`).bind(a.awardId).run();

    const line = (await disbursementByProgram(db, admin)).find((r) => r.programId === a.programId)!;
    expect(line.committedCents).toBe(0);
    expect(line.scheduledCents).toBe(0);
    expect(line.paidCents).toBe(0);
  });

  it('keeps money that already left, even when the award was later rescinded', async () => {
    /*
     * THE ANOMALY THIS EXISTS TO SURFACE. A grant is paid, and then the award
     * is rescinded. `paid` is a statement about money that left the building,
     * and it left whatever happened to the award afterwards -- so dropping it
     * would understate what finance actually sent, and hide the one case
     * somebody most needs to see.
     *
     * The consequence is that paid can EXCEED committed for that program. That
     * looks wrong on a dashboard and is true. A first version of this filter
     * excluded cancelled awards from all three totals and a mutant survived,
     * because the only test had no paid payment on the cancelled award.
     */
    const a = await awarded(1_000_000);
    const p = await schedulePayment(db, ctx(), admin, a.awardId, {
      amountCents: 400_000, scheduledDate: day(-5),
    });
    await recordPayment(db, ctx(), admin, p.id, {
      paidDate: day(-4), referenceNumber: 'CHQ-77',
    });
    await db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`).bind(a.awardId).run();

    const line = (await disbursementByProgram(db, admin)).find((r) => r.programId === a.programId)!;
    expect(line.committedCents).toBe(0);
    expect(line.scheduledCents).toBe(0);
    expect(line.paidCents).toBe(400_000);
  });
});

describe('who may see any of it', () => {
  it('refuses a reviewer and a grantee', async () => {
    /*
     * ADMIN ONLY, INCLUDING THE READ. When a cheque was cut and under what
     * reference is internal bookkeeping, and a grantee reading a "paid" date
     * the bank has not honoured yet would chase it.
     */
    const a = await awarded();
    const grantee = applicantSession(a.orgId);
    for (const who of [reviewerSession(newId()), grantee]) {
      expect((await appErrorFrom(awardLedger(db, who, a.awardId))).code).toBe('NOT_FOUND');
      expect((await appErrorFrom(disbursementByProgram(db, who))).code).toBe('NOT_FOUND');
      expect(
        (await appErrorFrom(
          schedulePayment(db, ctx(), who, a.awardId, {
            amountCents: 1000, scheduledDate: day(5),
          }),
        )).code,
      ).toBe('NOT_FOUND');
    }
  });
});
