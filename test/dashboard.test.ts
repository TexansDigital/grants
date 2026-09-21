/**
 * The numbers, and the award record they are built from.
 *
 * WHO THESE PROTECT. CLAUDE.md: "Executives never log in, so the export is the
 * product for them and must stand alone." Nobody from this project is in the
 * room when a board reads these figures, so every way they can mislead is a
 * way they WILL mislead:
 *
 *   - a cancelled grant counted as a commitment,
 *   - abandoned drafts counted as applications, making the funded rate look
 *     worse every year the form gets easier to start,
 *   - unreviewed impact numbers presented as checked,
 *   - a total with no range behind it, hiding one grant that is most of it,
 *   - and a percentage rounded early, so a column no longer sums.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import { createAwardFromDecision, budgetByProgram } from '../src/lib/awards';
import {
  awardTotals, applicationFunnel, reportCompliance, impactMetrics,
  buildDashboard, dashboardCsv, formatRate,
} from '../src/lib/dashboard';
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
    .bind(id, `dash-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);

async function program(fiscalYear = 2026, budgetCents: number | null = null) {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `dash-${++n}` });
  await db
    .prepare(`UPDATE programs SET fiscal_year = ?, total_budget_cents = ? WHERE id = ?`)
    .bind(fiscalYear, budgetCents, p.programId)
    .run();
  return { programId: p.programId, cycleId: Object.values(p.cycleIds)[0]!, formId: p.formDefinitionIds.application! };
}

async function submitted(
  c: { cycleId: string; formId: string },
  opts: { draft?: boolean } = {},
) {
  const orgId = newId();
  const applicationId = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Body ${++n}`, String(940000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, project_title, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, ?, ?, ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(
      applicationId, c.cycleId, orgId,
      opts.draft ? 'draft' : 'submitted',
      opts.draft ? null : now,
      `Project ${n}`, now, now, c.formId,
    )
    .run();
  return { applicationId, orgId };
}

// ---------------------------------------------------------------------------

describe('creating the award record', () => {
  it('uses the DECISION date, not today', async () => {
    /*
     * THE BUG THIS PREVENTS. The award record is often created weeks after the
     * decision -- once finance has settled the number. Dating it "now" would
     * put a December decision in the next fiscal year on every total this
     * dashboard builds, and nobody would spot it until a year-end figure
     * disagreed with the minutes.
     */
    const p = await program();
    const a = await submitted(p);
    const decidedAt = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await db
      .prepare(`UPDATE applications SET status='awarded', decided_at=?, decided_by=? WHERE id=?`)
      .bind(decidedAt, admin.userId, a.applicationId)
      .run();

    const result = await createAwardFromDecision(db, ctx(), admin, a.applicationId, {
      awardedAmountCents: 2_500_000,
    });
    const row = await db
      .prepare(`SELECT awarded_at AS at, status FROM awards WHERE id = ?`)
      .bind(result.awardId)
      .first<{ at: string; status: string }>();
    expect(row?.at).toBe(decidedAt);
    // Decided, not yet accepted. W-9 and the media release come at acceptance.
    expect(row?.status).toBe('pending');
  });

  it('refuses a second award on the same application', async () => {
    // A double-click, or two people working the same list. Either way the
    // committed total is twice what the Foundation agreed.
    const p = await program();
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    await createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: 100_000 });
    expect(
      (await appErrorFrom(
        createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: 100_000 }),
      )).code,
    ).toBe('CONFLICT');
  });

  it('refuses an application that was declined or undecided', async () => {
    const p = await program();
    const undecided = await submitted(p);
    expect(
      (await appErrorFrom(
        createAwardFromDecision(db, ctx(), admin, undecided.applicationId, { awardedAmountCents: 1 }),
      )).code,
    ).toBe('CONFLICT');

    const declined = await submitted(p);
    await decideApplication(db, ctx(), admin, declined.applicationId, {
      status: 'declined', notes: 'Not this cycle.',
    });
    expect(
      (await appErrorFrom(
        createAwardFromDecision(db, ctx(), admin, declined.applicationId, { awardedAmountCents: 1 }),
      )).code,
    ).toBe('CONFLICT');
  });

  it('refuses a float, a zero and a misplaced decimal', async () => {
    const p = await program();
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    for (const bad of [2500.5, 0, -100, 99_999_999_999]) {
      const err = await appErrorFrom(
        createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: bad }),
      );
      expect(err.code, `amount ${bad}`).toMatch(/VALIDATION_FAILED|INTERNAL/);
    }
  });

  it('refuses a term that ends before it starts, in words', async () => {
    // The column CHECKs it too, but a RAISE(ABORT) reaches an admin as an
    // INTERNAL error rather than as "check these two dates".
    const p = await program();
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    const err = await appErrorFrom(
      createAwardFromDecision(db, ctx(), admin, a.applicationId, {
        awardedAmountCents: 100_000,
        termStart: '2027-01-01T00:00:00.000Z',
        termEnd: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.fieldErrors?.[0]?.field).toBe('termEnd');
  });

  it('refuses a renewal pointing at another organization', async () => {
    const p = await program();
    const first = await submitted(p);
    await decideApplication(db, ctx(), admin, first.applicationId, { status: 'awarded' });
    const parent = await createAwardFromDecision(db, ctx(), admin, first.applicationId, {
      awardedAmountCents: 100_000,
    });

    const other = await submitted(p);
    await decideApplication(db, ctx(), admin, other.applicationId, { status: 'awarded' });
    const err = await appErrorFrom(
      createAwardFromDecision(db, ctx(), admin, other.applicationId, {
        awardedAmountCents: 100_000, parentAwardId: parent.awardId,
      }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a reviewer', async () => {
    const p = await program();
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    expect(
      (await appErrorFrom(
        createAwardFromDecision(db, ctx(), reviewerSession(newId()), a.applicationId, {
          awardedAmountCents: 100_000,
        }),
      )).code,
    ).toBe('NOT_FOUND');
  });
});

describe('what the totals exclude', () => {
  it('leaves out a cancelled award and keeps a pending one', async () => {
    /*
     * A rescinded grant is not a commitment. Money offered and not yet
     * accepted IS one -- the Foundation cannot offer it to somebody else.
     */
    const p = await program();
    const live = await submitted(p);
    const dead = await submitted(p);
    for (const a of [live, dead]) {
      await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    }
    await createAwardFromDecision(db, ctx(), admin, live.applicationId, { awardedAmountCents: 2_500_000 });
    const cancelled = await createAwardFromDecision(db, ctx(), admin, dead.applicationId, {
      awardedAmountCents: 9_900_000,
    });
    await db
      .prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`)
      .bind(cancelled.awardId)
      .run();

    const rows = (await awardTotals(db, admin)).filter((r) => r.programId === p.programId);
    const total = rows.reduce((t, r) => t + r.committedCents, 0);
    expect(total).toBe(2_500_000);
    expect(rows.reduce((t, r) => t + r.awards, 0)).toBe(1);
  });

  it('carries the range alongside the total', async () => {
    /*
     * Forty $25,000 grants and thirty-nine $10,000 grants plus one $600,000
     * grant have similar totals and are completely different programs. A board
     * reading only the total learns the wrong thing.
     */
    const p = await program();
    for (const cents of [1_000_000, 60_000_000, 2_500_000]) {
      const a = await submitted(p);
      await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
      await createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: cents });
    }
    const row = (await awardTotals(db, admin)).find((r) => r.programId === p.programId)!;
    expect(row.committedCents).toBe(63_500_000);
    expect(row.smallestCents).toBe(1_000_000);
    expect(row.largestCents).toBe(60_000_000);
  });

  it('keeps money in integer cents all the way through', async () => {
    const p = await program();
    for (const cents of [333_333, 333_333, 333_334]) {
      const a = await submitted(p);
      await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
      await createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: cents });
    }
    const row = (await awardTotals(db, admin)).find((r) => r.programId === p.programId)!;
    // Exactly a million cents. Three values each rounded to dollars first
    // would give $9,999.99 or $10,000.02 depending on the rounding.
    expect(row.committedCents).toBe(1_000_000);
    expect(Number.isInteger(row.committedCents)).toBe(true);
  });
});

describe('the application funnel', () => {
  it('does not count an abandoned draft as received', async () => {
    /*
     * THE BUG THIS PREVENTS. Counting drafts makes the funded rate fall every
     * year the form gets easier to start -- so the better the intake gets, the
     * worse the program looks in a board pack.
     */
    const p = await program();
    await submitted(p);
    await submitted(p, { draft: true });
    await submitted(p, { draft: true });

    const row = (await applicationFunnel(db, admin)).find((r) => r.cycleId === p.cycleId)!;
    expect(row.received).toBe(1);
  });

  it('states the rate in basis points, not a rounded percentage', async () => {
    // 17 of 63 is 26.98%. A column of values each rounded to 27% no longer
    // sums to anything, which is the same reason money is in cents.
    const p = await program();
    const apps = [];
    for (let i = 0; i < 3; i += 1) apps.push(await submitted(p));
    await decideApplication(db, ctx(), admin, apps[0]!.applicationId, { status: 'awarded' });

    const row = (await applicationFunnel(db, admin)).find((r) => r.cycleId === p.cycleId)!;
    expect(row.successRateBp).toBe(3333);
    expect(Number.isInteger(row.successRateBp)).toBe(true);
    expect(formatRate(row.successRateBp)).toBe('33.3%');
    expect(formatRate(null)).toBe('');
  });

  it('is null rather than zero when nothing was received', async () => {
    // 0/0 is not a 0% success rate. It is no cycle yet.
    const p = await program();
    const row = (await applicationFunnel(db, admin)).find((r) => r.cycleId === p.cycleId)!;
    expect(row.received).toBe(0);
    expect(row.successRateBp).toBeNull();
  });
});

describe('report compliance', () => {
  async function awardWithPeriod(
    p: { programId: string; cycleId: string; formId: string },
    opts: { dueDaysAgo: number; status: string },
  ) {
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    const award = await createAwardFromDecision(db, ctx(), admin, a.applicationId, {
      awardedAmountCents: 100_000,
    });
    const now = nowIso();
    await db
      .prepare(
        // waived_reason is required by a CHECK: waiving a report is a
        // deliberate act with a reason, not a quiet delete.
        `INSERT INTO report_periods (id, award_id, label, period_type, due_date, status,
           waived_reason, created_at, updated_at)
         VALUES (?,?, 'Final report', 'final', ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(), award.awardId,
        new Date(Date.now() - opts.dueDaysAgo * 86_400_000).toISOString(),
        opts.status,
        opts.status === 'waived' ? 'Grant returned unspent.' : null,
        now, now,
      )
      .run();
    return award;
  }

  it('computes overdue from the due date rather than storing it', async () => {
    /*
     * A stored flag drifts the moment a nightly job does not run, and a
     * compliance figure that is quietly a day stale is one somebody acts on.
     */
    const p = await program();
    await awardWithPeriod(p, { dueDaysAgo: 30, status: 'open' });
    await awardWithPeriod(p, { dueDaysAgo: -30, status: 'open' });

    const row = (await reportCompliance(db, admin, nowIso())).find((r) => r.programId === p.programId)!;
    expect(row.overdue).toBe(1);
    expect(row.open).toBe(2);
  });

  it('counts a waived report as compliant', async () => {
    /*
     * Staff decided it was not required, with a reason attached. Counting that
     * as a failure would make the honest act look worse than quietly leaving
     * the period open.
     */
    const p = await program();
    await awardWithPeriod(p, { dueDaysAgo: 30, status: 'waived' });
    await awardWithPeriod(p, { dueDaysAgo: 30, status: 'accepted' });

    const row = (await reportCompliance(db, admin, nowIso())).find((r) => r.programId === p.programId)!;
    expect(row.overdue).toBe(0);
    expect(row.complianceRateBp).toBe(10000);
  });
});

describe('impact metrics', () => {
  it('counts only accepted reports, and says how many', async () => {
    /*
     * A submitted-but-unreviewed number has not been checked by anybody, and a
     * board figure built from unchecked numbers is one the Foundation will be
     * asked to defend. The denominator travels with the total because "4,200
     * people served" from six reports out of forty is a different sentence.
     */
    const p = await program();
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    const award = await createAwardFromDecision(db, ctx(), admin, a.applicationId, {
      awardedAmountCents: 100_000,
    });

    const now = nowIso();
    const metricId = newId();
    await db
      .prepare(
        `INSERT INTO metric_definitions (id, program_id, metric_key, label, metric_type,
           unit, is_required, sort_order, created_at, updated_at)
         VALUES (?,?, 'people_served', 'People served', 'integer', 'people', 1, 0, ?, ?)`,
      )
      .bind(metricId, p.programId, now, now)
      .run();

    // Two reports: one accepted, one merely submitted.
    for (const [i, accepted] of [true, false].entries()) {
      const periodId = newId();
      const submissionId = newId();
      await db
        .prepare(
          `INSERT INTO report_periods (id, award_id, label, period_type, due_date, status,
             created_at, updated_at)
           VALUES (?,?,?, 'interim', ?, ?, ?, ?)`,
        )
        .bind(periodId, award.awardId, `Report ${i}`, now, accepted ? 'accepted' : 'submitted', now, now)
        .run();
      await db
        .prepare(
          `INSERT INTO report_submissions (id, report_period_id, submitted_at, accepted_at,
             accepted_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(submissionId, periodId, now, accepted ? now : null, accepted ? admin.userId : null, now, now)
        .run();
      await db
        .prepare(
          `INSERT INTO metric_values (id, report_submission_id, metric_definition_id,
             value_int, created_at)
           VALUES (?,?,?,?,?)`,
        )
        .bind(newId(), submissionId, metricId, accepted ? 400 : 9999, now)
        .run();
    }

    const row = (await impactMetrics(db, admin)).find((r) => r.metricDefinitionId === metricId)!;
    expect(row.total).toBe(400);
    expect(row.reports).toBe(1);
  });

  it('never totals a written answer', async () => {
    // "Describe the populations served" has no sum, and a zero in that row
    // reads as "we served nobody".
    const p = await program();
    const now = nowIso();
    const metricId = newId();
    await db
      .prepare(
        `INSERT INTO metric_definitions (id, program_id, metric_key, label, metric_type,
           unit, is_required, sort_order, created_at, updated_at)
         VALUES (?,?, 'populations', 'Populations served', 'text', NULL, 0, 1, ?, ?)`,
      )
      .bind(metricId, p.programId, now, now)
      .run();
    // With an ACCEPTED value behind it, not merely an empty row -- an empty
    // metric would be null whatever the code did.
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    const award = await createAwardFromDecision(db, ctx(), admin, a.applicationId, {
      awardedAmountCents: 100_000,
    });
    const periodId = newId();
    const submissionId = newId();
    await db
      .prepare(
        `INSERT INTO report_periods (id, award_id, label, period_type, due_date, status,
           created_at, updated_at)
         VALUES (?,?, 'Final', 'final', ?, 'accepted', ?, ?)`,
      )
      .bind(periodId, award.awardId, now, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO report_submissions (id, report_period_id, submitted_at, accepted_at,
           accepted_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(submissionId, periodId, now, now, admin.userId, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO metric_values (id, report_submission_id, metric_definition_id,
           value_text, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .bind(newId(), submissionId, metricId, 'Youth aged 12-18 in Fort Bend County', now)
      .run();

    const row = (await impactMetrics(db, admin)).find((r) => r.metricDefinitionId === metricId)!;
    expect(row.total).toBeNull();
    expect(row.reports).toBe(1);
  });
});

describe('the budget flag', () => {
  it('flags a program whose commitments exceed its budget', async () => {
    const p = await program(2026, 3_000_000);
    for (const cents of [2_000_000, 1_500_000]) {
      const a = await submitted(p);
      await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
      await createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: cents });
    }
    const line = (await budgetByProgram(db, admin)).find((b) => b.programId === p.programId)!;
    expect(line.committedCents).toBe(3_500_000);
    expect(line.overBudget).toBe(true);
  });

  it('does not flag a program with no stated budget', async () => {
    // No budget is not a budget of zero.
    const p = await program(2026, null);
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    await createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: 500_000 });
    const line = (await budgetByProgram(db, admin)).find((b) => b.programId === p.programId)!;
    expect(line.overBudget).toBe(false);
  });
});

describe('the export, which is the product for executives', () => {
  it('carries the exclusion rules with the numbers, not in a covering email', async () => {
    /*
     * Nobody from this project is in the room when this is read. "Total
     * awarded" is not one number, it is a number plus a rule about cancelled
     * and pending grants, and the rule has to travel with it.
     */
    const p = await program();
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    await createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: 2_500_000 });

    const csv = dashboardCsv(await buildDashboard(db, admin, nowIso()));
    expect(csv).toContain('Cancelled awards are excluded');
    expect(csv).toContain('Drafts that were never submitted are not counted as received');
    expect(csv).toContain('Overdue means past its due date');
    expect(csv).toContain('Only accepted reports are counted');
  });

  it('says plainly what it cannot answer', async () => {
    // CLAUDE.md asks for committed versus disbursed. There is no payment
    // ledger, so the second half does not exist -- and showing committed
    // twice under two headings would be worse than saying so.
    const d = await buildDashboard(db, admin, nowIso());
    expect(d.notAvailable.some((s) => /Disbursement/.test(s))).toBe(true);
    expect(dashboardCsv(d)).toContain('Disbursement');
  });

  it('writes money formatted AND in raw cents', async () => {
    // A spreadsheet that only carries "$25,000.00" is one somebody re-types.
    const p = await program();
    const a = await submitted(p);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    await createAwardFromDecision(db, ctx(), admin, a.applicationId, { awardedAmountCents: 2_500_000 });

    const csv = dashboardCsv(await buildDashboard(db, admin, nowIso()));
    // Whole dollars in the reading column -- formatCents shows cents only
    // when there are any -- and the exact figure beside it.
    expect(csv).toContain('$25,000');
    expect(csv).toContain(',2500000,');
  });

  it('quotes a program name containing a comma', async () => {
    const p = await program();
    await db
      .prepare(`UPDATE programs SET name = ? WHERE id = ?`)
      .bind('Inspire Change, Houston', p.programId)
      .run();
    const csv = dashboardCsv(await buildDashboard(db, admin, nowIso()));
    expect(csv).toContain('"Inspire Change, Houston"');
  });

  it('refuses everyone but an admin', async () => {
    const reviewer = reviewerSession(newId());
    for (const call of [
      () => awardTotals(db, reviewer),
      () => applicationFunnel(db, reviewer),
      () => reportCompliance(db, reviewer, nowIso()),
      () => impactMetrics(db, reviewer),
      () => buildDashboard(db, reviewer, nowIso()),
      () => budgetByProgram(db, reviewer),
    ]) {
      expect((await appErrorFrom(call())).code).toBe('NOT_FOUND');
    }
  });
});
