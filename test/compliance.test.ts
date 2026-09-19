import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import {
  checkCompliance, assertCompliant, complianceMessage, type OverdueReport,
} from '../src/lib/compliance';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

const day = (s: string) => `${s}T00:00:00.000Z`;
const NOW = day('2026-06-01');
let seq = 0;

/** A program with a policy, an organization, and a report period in some state. */
async function scenario(opts: {
  policy?: 'block' | 'warn' | 'ignore';
  dueDate?: string;
  status?: string;
  /** Owe the report to a DIFFERENT program than the one being applied to. */
  owedElsewhere?: boolean;
} = {}) {
  const ctx = ctxFor(adminSession());
  const now = nowIso();
  const applyingTo = await seedProgram(db, ctx, {
    ...INSPIRE_CHANGE,
    slug: `cmp-${++seq}`,
    compliancePolicy: opts.policy ?? 'block',
  });
  const owing = opts.owedElsewhere
    ? await seedProgram(db, ctx, {
        ...INSPIRE_CHANGE, slug: `cmp-other-${seq}`, name: 'Community Fund',
      })
    : applyingTo;

  const orgId = newId();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, `Owing Trust ${seq}`, String(820000000 + seq), now, now).run();

  const awardId = newId();
  await db.prepare(
    `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
       status, source_system, source_reference, created_at, updated_at)
     VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?)`,
  ).bind(awardId, orgId, owing.programId, 2_500_000, now, `CMP-${awardId.slice(0, 8)}`,
         now, now).run();

  const periodId = newId();
  await db.prepare(
    `INSERT INTO report_periods (id, award_id, label, period_type, due_date, status,
       waived_reason, created_at, updated_at)
     VALUES (?,?,'Final report','final',?,?,?,?,?)`,
  ).bind(
    periodId, awardId, opts.dueDate ?? day('2026-01-01'), opts.status ?? 'open',
    opts.status === 'waived' ? 'Grant returned.' : null, now, now,
  ).run();

  return { programId: applyingTo.programId, orgId, awardId, periodId, ctx };
}

// ---------------------------------------------------------------------------
describe('who is blocked', () => {
  it('blocks an organization sitting on a report that is past due', async () => {
    const s = await scenario({ policy: 'block' });
    const out = await checkCompliance(db, s.programId, s.orgId, { now: NOW });
    expect(out.decision).toBe('block');
    expect(out.overdue.map((r) => r.reportPeriodId)).toEqual([s.periodId]);
    expect(out.message).toContain('Final report');
  });

  it('lets a report that is not yet due through', async () => {
    const s = await scenario({ policy: 'block', dueDate: day('2099-01-01') });
    expect((await checkCompliance(db, s.programId, s.orgId, { now: NOW })).decision).toBe('allow');
  });

  it('is not late on the due date itself', async () => {
    const s = await scenario({ policy: 'block', dueDate: NOW });
    expect((await checkCompliance(db, s.programId, s.orgId, { now: NOW })).decision).toBe('allow');
  });

  it('never blocks over a report already filed and waiting on us', async () => {
    // Our queue, not theirs. Refusing a nonprofit a grant cycle over a report
    // they already sent us would be indefensible.
    for (const status of ['submitted', 'accepted', 'waived']) {
      const s = await scenario({ policy: 'block', status, dueDate: day('2020-01-01') });
      const out = await checkCompliance(db, s.programId, s.orgId, { now: NOW });
      expect(out.decision, status).toBe('allow');
    }
  });

  it('blocks again once a report is sent back for changes', async () => {
    // Revisions requested puts it back in the grantee's hands.
    const s = await scenario({
      policy: 'block', status: 'revisions_requested', dueDate: day('2020-01-01'),
    });
    expect((await checkCompliance(db, s.programId, s.orgId, { now: NOW })).decision).toBe('block');
  });

  it('ignores an obligation on an award that was cancelled', async () => {
    const s = await scenario({ policy: 'block' });
    await db.prepare(`UPDATE awards SET status='cancelled' WHERE id=?`).bind(s.awardId).run();
    expect((await checkCompliance(db, s.programId, s.orgId, { now: NOW })).decision).toBe('allow');
  });

  it('ignores a soft-deleted obligation', async () => {
    const s = await scenario({ policy: 'block' });
    await db.prepare(`UPDATE report_periods SET deleted_at=? WHERE id=?`)
      .bind(nowIso(), s.periodId).run();
    expect((await checkCompliance(db, s.programId, s.orgId, { now: NOW })).decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
describe('whose policy decides', () => {
  it('warns instead of blocking when the program says warn', async () => {
    const s = await scenario({ policy: 'warn' });
    const out = await checkCompliance(db, s.programId, s.orgId, { now: NOW });
    expect(out.decision).toBe('warn');
    expect(out.overdue).toHaveLength(1);
    expect(out.message).toContain('You can still apply');
  });

  it('says nothing at all when the program says ignore', async () => {
    const s = await scenario({ policy: 'ignore' });
    const out = await checkCompliance(db, s.programId, s.orgId, { now: NOW });
    expect(out).toMatchObject({ decision: 'allow', overdue: [], message: null });
  });

  it('counts a report owed to a different program', async () => {
    // Owing the Foundation is owing the Foundation. A program that disagrees
    // sets `ignore`, which is what that setting is for.
    const s = await scenario({ policy: 'block', owedElsewhere: true });
    const out = await checkCompliance(db, s.programId, s.orgId, { now: NOW });
    expect(out.decision).toBe('block');
    expect(out.overdue[0]!.programName).toBe('Community Fund');
  });

  it('falls open, not shut, for a program it cannot read', async () => {
    // The failure mode of guessing `block` is an eligible nonprofit turned
    // away with no way to argue.
    const s = await scenario({ policy: 'block' });
    const out = await checkCompliance(db, 'no-such-program', s.orgId, { now: NOW });
    expect(out).toMatchObject({ policy: 'ignore', decision: 'allow' });
  });

  it('follows a merge rather than letting a duplicate row be the way around', async () => {
    const s = await scenario({ policy: 'block' });
    const now = nowIso();
    const duplicateId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, merged_into_id,
         created_at, updated_at)
       VALUES (?,?,?,'merged',?,?,?)`,
    ).bind(duplicateId, `Owing Trust ${seq} (dup)`, String(830000000 + seq), s.orgId, now, now)
      .run();

    const out = await checkCompliance(db, s.programId, duplicateId, { now: NOW });
    expect(out.decision).toBe('block');
    expect(out.overdue.map((r) => r.reportPeriodId)).toEqual([s.periodId]);
  });
});

// ---------------------------------------------------------------------------
describe('what the applicant is told', () => {
  const report = (over: Partial<OverdueReport> = {}): OverdueReport => ({
    reportPeriodId: 'r1',
    label: 'Final report',
    dueDate: day('2026-01-01'),
    daysLate: 151,
    programName: 'Inspire Change',
    ...over,
  });

  it('names the report, the program and the date', () => {
    const msg = complianceMessage([report()], 'block');
    expect(msg).toContain('Final report');
    expect(msg).toContain('Inspire Change');
    expect(msg).toContain('2026-01-01');
  });

  it('counts them when there is more than one', () => {
    const msg = complianceMessage([report(), report({ reportPeriodId: 'r2' })], 'block');
    expect(msg).toContain('2 grant reports');
  });

  it('says nothing when there is nothing to say', () => {
    expect(complianceMessage([], 'block')).toBeNull();
    expect(complianceMessage([report()], 'allow')).toBeNull();
  });

  it('offers a way to argue, because our records can be wrong', () => {
    expect(complianceMessage([report()], 'block')).toContain('if you think this is wrong');
  });
});

// ---------------------------------------------------------------------------
describe('refusing', () => {
  it('throws with the reason attached, never a bare refusal', async () => {
    const s = await scenario({ policy: 'block' });
    const err = await appErrorFrom(
      assertCompliant(db, s.programId, s.orgId, { now: NOW }));
    expect(err.httpStatus).toBe(409);
    expect(err.publicMessage).toContain('Final report');
    expect(err.context.overdue_report_period_ids).toEqual([s.periodId]);
  });

  it('returns the check rather than throwing when the policy only warns', async () => {
    const s = await scenario({ policy: 'warn' });
    const out = await assertCompliant(db, s.programId, s.orgId, { now: NOW });
    expect(out.decision).toBe('warn');
  });
});
