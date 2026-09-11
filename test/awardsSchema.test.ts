import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * Migration 0012, exercised as behaviour rather than read as SQL.
 *
 * Every constraint here exists to stop a specific thing going wrong with other
 * organizations' money, so each one gets a test that fails when it is removed.
 */

let n = 0;
async function fixture() {
  const ctx = ctxFor(adminSession());
  const program = await seedProgram(db, ctx, { ...INSPIRE_CHANGE, slug: `aw-${++n}` });
  const org = await seedOrganization(db, ctx, {
    ...ORG_FIXTURES[0]!,
    ein: String(700000000 + n),
    legalName: `Awarded Org ${n}`,
    email: `grantee-${n}@example-awarded.org`,
  });
  return { programId: program.programId, organizationId: org.organizationId, userId: org.userId };
}

const insertAward = async (over: Record<string, unknown> = {}) => {
  const f = await fixture();
  const now = nowIso();
  const row: Record<string, unknown> = {
    id: newId(),
    application_id: null,
    organization_id: f.organizationId,
    program_id: f.programId,
    awarded_amount_cents: 2_500_000,
    awarded_at: now,
    status: 'active',
    source_system: 'formstack',
    source_reference: `entry-${newId()}`,
    created_at: now,
    updated_at: now,
    ...over,
  };
  const cols = Object.keys(row);
  await db
    .prepare(
      `INSERT INTO awards (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
    .bind(...cols.map((c) => row[c] as never))
    .run();
  return { ...f, awardId: row.id as string, sourceReference: row.source_reference as string };
};

const fails = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the database to refuse this');
};

// ---------------------------------------------------------------------------
describe('an award can exist without an application', () => {
  it('accepts a grant made before this platform existed', async () => {
    // THE decision this migration turns on. Two years of grants have no
    // application row here and never will.
    const a = await insertAward();
    const row = await db.prepare(`SELECT application_id, source_system FROM awards WHERE id=?`)
      .bind(a.awardId).first<{ application_id: string | null; source_system: string }>();
    expect(row!.application_id).toBeNull();
    expect(row!.source_system).toBe('formstack');
  });

  it('refuses an award that is traceable to nothing at all', async () => {
    // Neither an application nor a stated source: nobody could ever answer
    // "where did this grant come from".
    const msg = await fails(() => insertAward({ source_system: null, source_reference: null }));
    expect(msg).toMatch(/CONSTRAINT/i);
  });

  it('refuses a source reference with no source system', async () => {
    const msg = await fails(() => insertAward({ source_system: null }));
    expect(msg).toMatch(/CONSTRAINT/i);
  });
});

describe('importing the same file twice does not award anybody twice', () => {
  it('refuses a duplicate source reference', async () => {
    const first = await insertAward();
    const msg = await fails(() =>
      insertAward({ source_system: 'formstack', source_reference: first.sourceReference }),
    );
    expect(msg).toMatch(/UNIQUE/i);
  });

  it('lets the same reference exist under a different source system', async () => {
    // A spreadsheet row and a Formstack entry may legitimately share an id.
    const first = await insertAward();
    await expect(
      insertAward({ source_system: 'spreadsheet', source_reference: first.sourceReference }),
    ).resolves.toBeDefined();
  });

  it('refuses two awards against one application', async () => {
    const f = await fixture();
    const cycleId = (await db.prepare(`SELECT id FROM cycles WHERE program_id=? LIMIT 1`)
      .bind(f.programId).first<{ id: string }>())!.id;
    const stageId = (await db.prepare(`SELECT id FROM program_stages WHERE program_id=? LIMIT 1`)
      .bind(f.programId).first<{ id: string }>())!.id;
    const formId = (await db.prepare(`SELECT id FROM form_definitions WHERE program_id=? LIMIT 1`)
      .bind(f.programId).first<{ id: string }>())!.id;
    const appId = newId();
    const now = nowIso();
    // submitted_at is required for a submitted application -- a CHECK on
    // applications, not something this migration relaxed.
    await db.prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, created_at, updated_at) VALUES (?,?,?,?,?,'submitted',?,?,?)`,
    ).bind(appId, cycleId, stageId, f.organizationId, formId, now, now, now).run();

    const write = () =>
      db.prepare(
        `INSERT INTO awards (id, application_id, organization_id, program_id,
           awarded_amount_cents, awarded_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'active',?,?)`,
      ).bind(newId(), appId, f.organizationId, f.programId, 1000, now, now, now).run();

    await write();
    expect(await fails(write)).toMatch(/UNIQUE/i);
  });
});

describe('money, and the record of it', () => {
  it('refuses a float, a non-integral string, and a negative amount', async () => {
    for (const bad of [2500.5, '2500.5', 'abc', -1]) {
      expect(await fails(() => insertAward({ awarded_amount_cents: bad })), String(bad))
        .toMatch(/CONSTRAINT/i);
    }
  });

  it('converts a string that IS an integer, rather than refusing it', async () => {
    /*
     * MEASURED, not assumed, and worth stating plainly because the obvious
     * reading of `typeof(x) = 'integer'` is that it rejects every string.
     *
     * SQLite applies INTEGER column affinity BEFORE the CHECK runs, and that
     * conversion happens only when it is lossless. So '2500000' is stored as
     * the integer 2500000 and passes; '2500.5' and 'abc' cannot be converted
     * losslessly, stay TEXT, and are refused. The guard's real job -- no float,
     * no unparseable value, nothing negative ever reaching a money column --
     * holds. What it does NOT do is reject a numeric string, and the value that
     * lands is a genuine integer, so nothing is lost.
     */
    const a = await insertAward({ awarded_amount_cents: '2500000' });
    const row = await db.prepare(`SELECT awarded_amount_cents AS c, typeof(awarded_amount_cents) AS t
                                    FROM awards WHERE id=?`)
      .bind(a.awardId).first<{ c: number; t: string }>();
    expect(row!.t).toBe('integer');
    expect(row!.c).toBe(2_500_000);
  });

  it('refuses an amount edited in place', async () => {
    // An overwritten amount leaves no record that it changed. Phase 4 adds
    // amendments; until then this is a conversation, not an UPDATE.
    const a = await insertAward();
    const msg = await fails(() =>
      db.prepare(`UPDATE awards SET awarded_amount_cents=? WHERE id=?`)
        .bind(9_900_000, a.awardId).run(),
    );
    expect(msg).toMatch(/amendment/i);
  });

  it('allows an update that leaves the amount alone', async () => {
    // The guard must not freeze the whole row: accepting an award, recording a
    // W-9 and closing a term are all ordinary updates.
    const a = await insertAward();
    await expect(
      db.prepare(`UPDATE awards SET status='completed', w9_received_at=?, updated_at=? WHERE id=?`)
        .bind(nowIso(), nowIso(), a.awardId).run(),
    ).resolves.toBeDefined();
  });

  it('refuses a hard delete', async () => {
    const a = await insertAward();
    expect(await fails(() => db.prepare(`DELETE FROM awards WHERE id=?`).bind(a.awardId).run()))
      .toMatch(/soft-deleted/i);
  });

  it('refuses a term that ends before it starts', async () => {
    const msg = await fails(() =>
      insertAward({ term_start: '2026-01-01T00:00:00.000Z', term_end: '2025-01-01T00:00:00.000Z' }),
    );
    expect(msg).toMatch(/CONSTRAINT/i);
  });

  it('refuses an award that is its own parent', async () => {
    const id = newId();
    expect(await fails(() => insertAward({ id, parent_award_id: id }))).toMatch(/CONSTRAINT/i);
  });
});

// ---------------------------------------------------------------------------
describe('report periods', () => {
  const period = async (over: Record<string, unknown> = {}) => {
    const a = await insertAward();
    const now = nowIso();
    const id = newId();
    const row: Record<string, unknown> = {
      id, award_id: a.awardId, label: 'Final report', period_type: 'final',
      due_date: '2027-01-31T00:00:00.000Z', status: 'scheduled',
      created_at: now, updated_at: now, ...over,
    };
    const cols = Object.keys(row);
    await db.prepare(
      `INSERT INTO report_periods (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).bind(...cols.map((c) => row[c] as never)).run();
    return { ...a, periodId: id };
  };

  it('requires a reason before a report can be waived', async () => {
    expect(await fails(() => period({ status: 'waived' }))).toMatch(/CONSTRAINT/i);
    await expect(period({ status: 'waived', waived_reason: 'Grant returned unspent' }))
      .resolves.toBeDefined();
  });

  it('will not reopen an accepted report', async () => {
    // Reopening would let a submission be replaced after staff signed it off,
    // with the acceptance still sitting on the row.
    const p = await period({ status: 'accepted' });
    const msg = await fails(() =>
      db.prepare(`UPDATE report_periods SET status='open' WHERE id=?`).bind(p.periodId).run(),
    );
    expect(msg).toMatch(/cannot be reopened/i);
  });

  it('refuses a hard delete', async () => {
    const p = await period();
    expect(await fails(() =>
      db.prepare(`DELETE FROM report_periods WHERE id=?`).bind(p.periodId).run(),
    )).toMatch(/soft-deleted/i);
  });
});

// ---------------------------------------------------------------------------
describe('what a grantee filed', () => {
  const submission = async (over: Record<string, unknown> = {}) => {
    const a = await insertAward();
    const now = nowIso();
    const periodId = newId();
    await db.prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, created_at, updated_at)
       VALUES (?,?,?,'final',?,?,?)`,
    ).bind(periodId, a.awardId, 'Final', '2027-01-31T00:00:00.000Z', now, now).run();

    const id = newId();
    const row: Record<string, unknown> = {
      id, report_period_id: periodId, submitted_by_user_id: a.userId, submitted_at: now,
      funds_spent_cents: 2_500_000, created_at: now, updated_at: now, ...over,
    };
    const cols = Object.keys(row);
    await db.prepare(
      `INSERT INTO report_submissions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).bind(...cols.map((c) => row[c] as never)).run();
    return { ...a, periodId, submissionId: id };
  };

  it('will not let a filed report be rewritten', async () => {
    // A correction is a NEW submission against the same period, so "what did
    // they tell us in March, before we asked for changes" stays answerable.
    const s = await submission();
    const msg = await fails(() =>
      db.prepare(`UPDATE report_submissions SET funds_spent_cents=? WHERE id=?`)
        .bind(1, s.submissionId).run(),
    );
    expect(msg).toMatch(/not rewritten/i);
  });

  it('still allows staff to add feedback and accept it', async () => {
    const s = await submission();
    await expect(
      db.prepare(
        `UPDATE report_submissions SET admin_feedback=?, accepted_at=?, accepted_by=?, updated_at=?
          WHERE id=?`,
      ).bind('Thank you.', nowIso(), s.userId, nowIso(), s.submissionId).run(),
    ).resolves.toBeDefined();
  });

  it('refuses an acceptance with nobody attached to it', async () => {
    const s = await submission();
    expect(await fails(() =>
      db.prepare(`UPDATE report_submissions SET accepted_at=? WHERE id=?`)
        .bind(nowIso(), s.submissionId).run(),
    )).toMatch(/CONSTRAINT/i);
  });

  it('refuses funds spent that is not integer cents', async () => {
    // Same affinity rule as awarded_amount_cents: a losslessly-integral string
    // converts, everything else is refused.
    for (const bad of [12.5, '12.5', 'abc', -1]) {
      expect(await fails(() => submission({ funds_spent_cents: bad })), String(bad))
        .toMatch(/CONSTRAINT/i);
    }
  });
});

// ---------------------------------------------------------------------------
describe('metrics', () => {
  const metric = async (over: Record<string, unknown> = {}) => {
    const f = await fixture();
    const now = nowIso();
    const id = newId();
    const row: Record<string, unknown> = {
      id, program_id: f.programId, metric_key: `people-${id.slice(0, 6)}`,
      label: 'Individuals served', metric_type: 'integer',
      created_at: now, updated_at: now, ...over,
    };
    const cols = Object.keys(row);
    await db.prepare(
      `INSERT INTO metric_definitions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).bind(...cols.map((c) => row[c] as never)).run();
    return { ...f, metricId: id };
  };

  it('refuses two metrics sharing a key in one program', async () => {
    const m = await metric();
    const key = (await db.prepare(`SELECT metric_key FROM metric_definitions WHERE id=?`)
      .bind(m.metricId).first<{ metric_key: string }>())!.metric_key;
    // Same program, same key.
    const now = nowIso();
    expect(await fails(() =>
      db.prepare(
        `INSERT INTO metric_definitions (id, program_id, metric_key, label, metric_type, created_at, updated_at)
         VALUES (?,?,?,?,'integer',?,?)`,
      ).bind(newId(), m.programId, key, 'Duplicate', now, now).run(),
    )).toMatch(/UNIQUE/i);
  });

  it('refuses a hard delete, because last year’s totals depend on it', async () => {
    const m = await metric();
    expect(await fails(() =>
      db.prepare(`DELETE FROM metric_definitions WHERE id=?`).bind(m.metricId).run(),
    )).toMatch(/retired, never removed/i);
  });

  it('stores exactly one kind of value per metric answer', async () => {
    // Two populated columns is a promotion bug, and a SUM that silently counts
    // only one of them.
    const m = await metric();
    const now = nowIso();
    const periodId = newId();
    const submissionId = newId();
    const a = await insertAward({ organization_id: m.organizationId, program_id: m.programId });
    await db.prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, created_at, updated_at)
       VALUES (?,?,?,'final',?,?,?)`,
    ).bind(periodId, a.awardId, 'Final', '2027-01-31T00:00:00.000Z', now, now).run();
    await db.prepare(
      `INSERT INTO report_submissions (id, report_period_id, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
    ).bind(submissionId, periodId, now, now, now).run();

    const write = (cols: Record<string, unknown>) => {
      const row = { id: newId(), report_submission_id: submissionId,
        metric_definition_id: m.metricId, created_at: now, ...cols };
      const k = Object.keys(row);
      return db.prepare(
        `INSERT INTO metric_values (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`,
      ).bind(...k.map((c) => (row as Record<string, unknown>)[c] as never)).run();
    };

    expect(await fails(() => write({ value_int: 400, value_text: 'four hundred' })))
      .toMatch(/CONSTRAINT/i);
    await expect(write({ value_int: 400 })).resolves.toBeDefined();
  });

  it('refuses two values for one metric on one submission', async () => {
    const m = await metric();
    const now = nowIso();
    const a = await insertAward({ organization_id: m.organizationId, program_id: m.programId });
    const periodId = newId();
    const submissionId = newId();
    await db.prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, created_at, updated_at)
       VALUES (?,?,?,'final',?,?,?)`,
    ).bind(periodId, a.awardId, 'Final', '2027-01-31T00:00:00.000Z', now, now).run();
    await db.prepare(
      `INSERT INTO report_submissions (id, report_period_id, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
    ).bind(submissionId, periodId, now, now, now).run();

    const write = () => db.prepare(
      `INSERT INTO metric_values (id, report_submission_id, metric_definition_id, value_int, created_at)
       VALUES (?,?,?,?,?)`,
    ).bind(newId(), submissionId, m.metricId, 400, now).run();

    await write();
    expect(await fails(write)).toMatch(/UNIQUE/i);
  });

  it('freezes a metric’s type once values have been reported against it', async () => {
    const m = await metric();
    // Free to change while nothing depends on it.
    await expect(
      db.prepare(`UPDATE metric_definitions SET metric_type='decimal' WHERE id=?`)
        .bind(m.metricId).run(),
    ).resolves.toBeDefined();

    const now = nowIso();
    const a = await insertAward({ organization_id: m.organizationId, program_id: m.programId });
    const periodId = newId();
    const submissionId = newId();
    await db.prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, created_at, updated_at)
       VALUES (?,?,?,'final',?,?,?)`,
    ).bind(periodId, a.awardId, 'Final', '2027-01-31T00:00:00.000Z', now, now).run();
    await db.prepare(
      `INSERT INTO report_submissions (id, report_period_id, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
    ).bind(submissionId, periodId, now, now, now).run();
    await db.prepare(
      `INSERT INTO metric_values (id, report_submission_id, metric_definition_id, value_real, created_at)
       VALUES (?,?,?,?,?)`,
    ).bind(newId(), submissionId, m.metricId, 4.5, now).run();

    // Now it would restate history.
    expect(await fails(() =>
      db.prepare(`UPDATE metric_definitions SET metric_type='integer' WHERE id=?`)
        .bind(m.metricId).run(),
    )).toMatch(/cannot change once values/i);
  });
});
