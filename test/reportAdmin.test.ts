import { describe, it, expect } from 'vitest';
import {
  db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom, forceDueDate,
} from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { buildReportForm } from '../src/lib/reportForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { submitReport } from '../src/lib/reportSubmit';
import {
  reportPortfolio, readReportForStaff, acceptReport, requestReportRevisions, waiveReport,
  daysUntil, isOverdue, moveReportDueDate, dueDateHistory,
} from '../src/lib/reportAdmin';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Session } from '../src/types';

const day = (s: string) => `${s}T00:00:00.000Z`;
let seq = 0;

const METRICS = [
  ['individuals_served', 'How many individuals did this grant serve?', 'integer', 'people', 1, 10, null],
  ['funds_spent', 'How much of the grant has been spent?', 'currency', null, 1, 20, 'funds_spent_cents'],
] as const;

async function scenario(opts: { dueDate?: string } = {}) {
  const adminCtx = ctxFor(adminSession());
  const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `ra-${++seq}` });
  const now = nowIso();

  for (const [k, label, type, unit, required, order, promotes] of METRICS) {
    await db.prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
          status, promotes_to, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'active', ?,?,?)`,
    ).bind(newId(), p.programId, k, label, type, unit, required, order, promotes, now, now).run();
  }
  const form = await buildReportForm(db, adminCtx, { programId: p.programId });
  await db.prepare(`UPDATE form_definitions SET status='published', published_at=? WHERE id=?`)
    .bind(now, form.formDefinitionId).run();

  const orgId = newId();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, `Harbor Trust ${seq}`, String(870000000 + seq), now, now).run();

  const awardId = newId();
  await db.prepare(
    `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
       status, source_system, source_reference, term_start, term_end, created_at, updated_at)
     VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?,?,?)`,
  ).bind(awardId, orgId, p.programId, 2_500_000, now, `RA-${awardId.slice(0, 8)}`,
         day('2025-01-01'), day('2025-12-31'), now, now).run();
  await generateReportPeriods(db, adminCtx, awardId);

  const period = await db.prepare(`SELECT id FROM report_periods WHERE award_id=?`)
    .bind(awardId).first<{ id: string }>();
  if (opts.dueDate) {
    await forceDueDate(period!.id, opts.dueDate);
  }

  const userId = newId();
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
  ).bind(userId, `g${seq}-${newId().slice(0, 6)}@example.org`, orgId, now, now).run();
  const grantee: Session = {
    userId, email: `g${seq}@example.org`, role: 'grantee', organizationId: orgId,
  };

  const admin = adminSession();
  await db.prepare(
    `INSERT INTO users (id, email, role, is_active, created_at, updated_at)
     VALUES (?,?, 'admin', 1, ?, ?)`,
  ).bind(admin.userId, `a${seq}-${newId().slice(0, 6)}@example.org`, now, now).run();

  return {
    programId: p.programId, orgId, awardId, periodId: period!.id,
    grantee, granteeCtx: ctxFor(grantee), admin, adminCtx: ctxFor(admin),
  };
}

const ANSWERS = {
  narrative: 'We ran a summer reading programme across three branch libraries.',
  metric_individuals_served: '412',
  metric_funds_spent: '$18,750.25',
};

const file = (s: Awaited<ReturnType<typeof scenario>>) =>
  submitReport(db, s.granteeCtx, s.grantee, s.periodId, ANSWERS);

// ---------------------------------------------------------------------------
describe('who may look and who may decide', () => {
  it('lets a reviewer read the portfolio but not decide anything', async () => {
    // Reviewers are staff and this is not scored work, so reading it is fine.
    // Deciding whether a nonprofit has met an obligation is not theirs.
    const s = await scenario();
    await file(s);
    const reviewer = reviewerSession();
    await expect(reportPortfolio(db, reviewer)).resolves.toBeTruthy();
    await expect(readReportForStaff(db, reviewer, s.periodId)).resolves.toBeTruthy();

    for (const act of [
      acceptReport(db, s.adminCtx, reviewer, s.periodId),
      requestReportRevisions(db, s.adminCtx, reviewer, s.periodId, 'Please break out the spend.'),
      waiveReport(db, s.adminCtx, reviewer, s.periodId, 'Grant returned unspent.'),
    ]) {
      await expect(act).rejects.toMatchObject({ httpStatus: 403 });
    }
  });

  it('refuses an external role outright, read included', async () => {
    const s = await scenario();
    await file(s);
    await expect(reportPortfolio(db, s.grantee)).rejects.toMatchObject({ httpStatus: 403 });
    await expect(readReportForStaff(db, s.grantee, s.periodId))
      .rejects.toMatchObject({ httpStatus: 403 });
    await expect(readReportForStaff(db, applicantSession(s.orgId), s.periodId))
      .rejects.toMatchObject({ httpStatus: 403 });
  });
});

// ---------------------------------------------------------------------------
describe('what is outstanding across the portfolio', () => {
  it('lists every obligation with the organization that owes it', async () => {
    const s = await scenario();
    const { rows, total } = await reportPortfolio(db, s.admin, { organizationId: s.orgId });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      reportPeriodId: s.periodId,
      organizationName: `Harbor Trust ${seq}`,
      programName: INSPIRE_CHANGE.name,
      status: 'scheduled',
      awardedAmountCents: 2_500_000,
      submittedAt: null,
    });
  });

  it('carries the filed figures onto the row, so the list answers the question', async () => {
    const s = await scenario();
    await file(s);
    const { rows } = await reportPortfolio(db, s.admin, { organizationId: s.orgId });
    expect(rows[0]).toMatchObject({ status: 'submitted', fundsSpentCents: 1_875_025 });
    expect(rows[0]!.submittedAt).not.toBeNull();
  });

  it('filters by status and by program', async () => {
    const a = await scenario();
    const b = await scenario();
    await file(a);

    const submitted = await reportPortfolio(db, a.admin, { status: 'submitted' });
    expect(submitted.rows.map((r) => r.reportPeriodId)).toContain(a.periodId);
    expect(submitted.rows.map((r) => r.reportPeriodId)).not.toContain(b.periodId);

    const byProgram = await reportPortfolio(db, a.admin, { programId: b.programId });
    expect(byProgram.rows.map((r) => r.reportPeriodId)).toEqual([b.periodId]);
  });

  it('counts a report late only when it is late AND unfiled', async () => {
    // A report filed a week late and now sitting with staff is OUR queue, not
    // the grantee's failure. A compliance view that keeps it red is one staff
    // learn to ignore.
    const s = await scenario({ dueDate: day('2020-01-01') });
    let { rows } = await reportPortfolio(db, s.admin, { organizationId: s.orgId });
    expect(rows[0]!.overdue).toBe(true);

    await file(s);
    ({ rows } = await reportPortfolio(db, s.admin, { organizationId: s.orgId }));
    expect(rows[0]!.overdue).toBe(false);
  });

  it('narrows to what is actually late when asked', async () => {
    const late = await scenario({ dueDate: day('2020-01-01') });
    const soon = await scenario({ dueDate: day('2099-01-01') });
    const { rows } = await reportPortfolio(db, late.admin, { overdueOnly: true });
    const ids = rows.map((r) => r.reportPeriodId);
    expect(ids).toContain(late.periodId);
    expect(ids).not.toContain(soon.periodId);
  });

  it('never returns more than it was asked for', async () => {
    // Two scenarios, because storage is isolated per test: with one, a broken
    // limit and a working one both return a single row and the test proves
    // nothing.
    const a = await scenario();
    await scenario();
    const all = await reportPortfolio(db, a.admin, {});
    expect(all.rows.length).toBeGreaterThan(1);
    const { rows, total } = await reportPortfolio(db, a.admin, { limit: 1 });
    expect(rows).toHaveLength(1);
    // The total still counts everything, so a pager knows there is more.
    expect(total).toBe(all.total);
  });

  it('lists a revised report once, showing the latest attempt', async () => {
    // A plain join on report_submissions multiplies a period by its attempts,
    // so a report sent back twice appears three times on the compliance desk --
    // and the figures shown are whichever attempt the join happened to return.
    const s = await scenario();
    await submitReport(db, s.granteeCtx, s.grantee, s.periodId, {
      ...ANSWERS, metric_funds_spent: '$1.00',
    });
    await requestReportRevisions(db, s.adminCtx, s.admin, s.periodId,
      'That spend figure looks like a typo.');
    await file(s);

    const { rows } = await reportPortfolio(db, s.admin, { organizationId: s.orgId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fundsSpentCents).toBe(1_875_025);
  });
});

// ---------------------------------------------------------------------------
describe('reading one filed report', () => {
  it('shows the answers and the metrics as sentences, not as columns', async () => {
    const s = await scenario();
    await file(s);
    const out = await readReportForStaff(db, s.admin, s.periodId);

    expect(out.award).toMatchObject({
      organizationName: `Harbor Trust ${seq}`, awardedAmountCents: 2_500_000,
    });
    expect(out.submissions).toHaveLength(1);
    const sub = out.submissions[0]!;

    const narrative = sub.answers.find((a) => a.fieldKey === 'narrative');
    expect(narrative!.display).toContain('summer reading');

    // Cents become dollars exactly once, on the way to a screen.
    const money = sub.answers.find((a) => a.fieldKey === 'metric_funds_spent');
    expect(money!.display).toBe('$18,750.25');
    expect(sub.fundsSpentCents).toBe(1_875_025);

    expect(sub.metrics.map((m) => [m.metricKey, m.display])).toEqual([
      ['individuals_served', '412 people'],
      ['funds_spent', '$18,750.25'],
    ]);
  });

  it('names who filed it', async () => {
    const s = await scenario();
    await file(s);
    const out = await readReportForStaff(db, s.admin, s.periodId);
    expect(out.submissions[0]!.submittedBy).toContain('@example.org');
  });

  it('keeps every attempt, newest first', async () => {
    const s = await scenario();
    await file(s);
    await requestReportRevisions(db, s.adminCtx, s.admin, s.periodId,
      'Please break the spend out by site.');
    await file(s);

    const out = await readReportForStaff(db, s.admin, s.periodId);
    expect(out.submissions).toHaveLength(2);
    expect(out.submissions[0]!.submittedAt >= out.submissions[1]!.submittedAt).toBe(true);
    // What was asked stays attached to the attempt it was asked about.
    expect(out.submissions[1]!.adminFeedback).toContain('by site');
    expect(out.submissions[0]!.adminFeedback).toBeNull();
  });

  it('refuses a report period that does not exist', async () => {
    const s = await scenario();
    await expect(readReportForStaff(db, s.admin, 'nope'))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('reads a period nobody has filed against yet', async () => {
    const s = await scenario();
    const out = await readReportForStaff(db, s.admin, s.periodId);
    expect(out.submissions).toEqual([]);
    expect(out.period.status).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------
describe('accepting', () => {
  it('stamps the submission, closes the period and audits it', async () => {
    const s = await scenario();
    await file(s);
    const out = await acceptReport(db, s.adminCtx, s.admin, s.periodId);

    const sub = await db.prepare(
      `SELECT accepted_at, accepted_by FROM report_submissions WHERE id=?`,
    ).bind(out.reportSubmissionId).first<Record<string, unknown>>();
    expect(sub).toMatchObject({ accepted_by: s.admin.userId });
    expect(sub!.accepted_at).not.toBeNull();

    expect(await db.prepare(`SELECT status FROM report_periods WHERE id=?`)
      .bind(s.periodId).first<{ status: string }>()).toMatchObject({ status: 'accepted' });

    const audit = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='report.accepted' AND entity_id=?`,
    ).bind(out.reportSubmissionId).first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });

  it('refuses to accept a report nobody has filed', async () => {
    const s = await scenario();
    const err = await appErrorFrom(acceptReport(db, s.adminCtx, s.admin, s.periodId));
    expect(err.publicMessage).toContain('cannot be accepted');
  });

  it('is terminal: the database refuses to reopen it', async () => {
    const s = await scenario();
    await file(s);
    await acceptReport(db, s.adminCtx, s.admin, s.periodId);
    await expect(
      db.prepare(`UPDATE report_periods SET status='open' WHERE id=?`).bind(s.periodId).run(),
    ).rejects.toThrow(/cannot be reopened/);
  });

  it('accepts once when two admins click at the same time', async () => {
    const s = await scenario();
    await file(s);
    const results = await Promise.allSettled([
      acceptReport(db, s.adminCtx, s.admin, s.periodId),
      acceptReport(db, s.adminCtx, s.admin, s.periodId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const audit = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='report.accepted'
        AND json_extract(after_json,'$.report_period_id')=?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('sending one back', () => {
  it('requires an explanation a grantee can act on', async () => {
    const s = await scenario();
    await file(s);
    for (const note of ['', '   ', 'no', 'fix it']) {
      const err = await appErrorFrom(
        requestReportRevisions(db, s.adminCtx, s.admin, s.periodId, note));
      expect(err.code, note).toBe('VALIDATION_FAILED');
    }
    // And nothing moved.
    expect(await db.prepare(`SELECT status FROM report_periods WHERE id=?`)
      .bind(s.periodId).first<{ status: string }>()).toMatchObject({ status: 'submitted' });
  });

  it('writes the feedback where the grantee reads it, and reopens the report', async () => {
    const s = await scenario();
    await file(s);
    const out = await requestReportRevisions(db, s.adminCtx, s.admin, s.periodId,
      'Please break the spend out by site.');

    const sub = await db.prepare(`SELECT admin_feedback FROM report_submissions WHERE id=?`)
      .bind(out.reportSubmissionId).first<{ admin_feedback: string }>();
    expect(sub!.admin_feedback).toBe('Please break the spend out by site.');
    expect(await db.prepare(`SELECT status FROM report_periods WHERE id=?`)
      .bind(s.periodId).first<{ status: string }>())
      .toMatchObject({ status: 'revisions_requested' });
  });

  it('keeps the feedback text out of the audit row', async () => {
    // The feedback lives on the submission, where the grantee reads it. The
    // audit records that it was sent, not a second copy of it.
    const s = await scenario();
    await file(s);
    await requestReportRevisions(db, s.adminCtx, s.admin, s.periodId,
      'Please break the spend out by site.');
    const row = await db.prepare(
      `SELECT after_json FROM audit_log WHERE action='report.revisions_requested'`,
    ).first<{ after_json: string }>();
    expect(row!.after_json).not.toContain('by site');
    expect(JSON.parse(row!.after_json).feedback_characters).toBe(35);
  });

  it('lets the grantee file again, as a new submission', async () => {
    const s = await scenario();
    await file(s);
    await requestReportRevisions(db, s.adminCtx, s.admin, s.periodId,
      'Please break the spend out by site.');
    await file(s);
    const n = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_submissions WHERE report_period_id=?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it('cannot send back a report that was already accepted', async () => {
    const s = await scenario();
    await file(s);
    await acceptReport(db, s.adminCtx, s.admin, s.periodId);
    const err = await appErrorFrom(
      requestReportRevisions(db, s.adminCtx, s.admin, s.periodId, 'Actually, one more thing.'));
    expect(err.publicMessage).toContain('cannot be sent back');
  });
});

// ---------------------------------------------------------------------------
describe('waiving', () => {
  it('needs a reason, because the schema and the practice both require one', async () => {
    const s = await scenario();
    const err = await appErrorFrom(waiveReport(db, s.adminCtx, s.admin, s.periodId, ''));
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('records the reason on the row and in the audit trail', async () => {
    const s = await scenario();
    await waiveReport(db, s.adminCtx, s.admin, s.periodId, 'Grant returned unspent in March.');
    const row = await db.prepare(
      `SELECT status, waived_reason FROM report_periods WHERE id=?`,
    ).bind(s.periodId).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      status: 'waived', waived_reason: 'Grant returned unspent in March.',
    });
    const audit = await db.prepare(
      `SELECT after_json FROM audit_log WHERE action='report.waived' AND entity_id=?`,
    ).bind(s.periodId).first<{ after_json: string }>();
    expect(JSON.parse(audit!.after_json).reason).toBe('Grant returned unspent in March.');
  });

  it('cannot waive something already decided', async () => {
    const s = await scenario();
    await file(s);
    await acceptReport(db, s.adminCtx, s.admin, s.periodId);
    const err = await appErrorFrom(
      waiveReport(db, s.adminCtx, s.admin, s.periodId, 'Changed our minds.'));
    expect(err.publicMessage).toContain('already accepted');
  });
});

// ---------------------------------------------------------------------------
describe('how late is late, on the staff side', () => {
  it('counts whole calendar days', () => {
    expect(daysUntil(day('2026-03-31'), day('2026-03-01'))).toBe(30);
    expect(daysUntil(day('2026-03-01'), day('2026-03-31'))).toBe(-30);
    expect(daysUntil(day('2026-03-01'), day('2026-03-01'))).toBe(0);
  });

  it('is not overdue on the due date itself', () => {
    expect(isOverdue('open', day('2026-03-01'), day('2026-03-01'))).toBe(false);
    expect(isOverdue('open', day('2026-03-01'), day('2026-03-02'))).toBe(true);
  });

  it('is never overdue once it is out of the hands that owe it', () => {
    // `now` is explicit rather than defaulted: a pure function that reads the
    // wall clock behind its caller is one whose tests pass on a Tuesday.
    const now = day('2026-03-01');
    for (const status of ['submitted', 'accepted', 'waived']) {
      expect(isOverdue(status, day('2020-01-01'), now), status).toBe(false);
    }
    for (const status of ['scheduled', 'open', 'revisions_requested']) {
      expect(isOverdue(status, day('2020-01-01'), now), status).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
/*
 * MOVING A DUE DATE.
 *
 * Six statements in this codebase wrote to `report_periods` and not one
 * touched `due_date`. Staff could accept a report, ask for revisions, or waive
 * it -- but a nonprofit asking for two more weeks had no answer anybody could
 * give, and the only remedy was editing production by hand. It also made the
 * update request a one-way door: thirteen obligations against a date typed
 * once, uncorrectable.
 *
 * The tests that matter most here are the ones about the DATABASE rather than
 * the library, because the library is not the only possible caller. A guard
 * that only exists in TypeScript guards only the path somebody remembered.
 */
describe('moving a report due date', () => {
  const future = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  const period = async (id: string) =>
    (await db
      .prepare(
        `SELECT due_date AS dueDate, status, reminder_count AS reminders,
                reminder_last_sent_at AS lastSent
           FROM report_periods WHERE id = ?`,
      )
      .bind(id)
      .first<{ dueDate: string; status: string; reminders: number; lastSent: string | null }>())!;

  const amendments = async (id: string) =>
    (await db
      .prepare(`SELECT COUNT(*) AS n FROM report_period_amendments WHERE report_period_id = ?`)
      .bind(id)
      .first<{ n: number }>())!.n;

  it('moves it, records the move, and writes an audit row', async () => {
    const s = await scenario();
    const was = (await period(s.periodId)).dueDate;

    const moved = await moveReportDueDate(
      db, s.adminCtx, s.admin, s.periodId, future(30),
      'They asked for two more weeks to get the figures from their programme team.',
    );

    expect(moved.previousDueDate).toBe(was);
    expect(moved.dueDate).toBe(future(30));
    expect((await period(s.periodId)).dueDate).toBe(future(30));

    const history = await dueDateHistory(db, s.periodId);
    expect(history).toHaveLength(1);
    expect(history[0]!.oldValue).toBe(was);
    expect(history[0]!.newValue).toBe(future(30));
    expect(history[0]!.reason).toContain('two more weeks');
    // The actor, by email rather than an id nobody can read.
    expect(history[0]!.amendedBy).toContain('@');

    const audit = await db
      .prepare(
        `SELECT after_json AS after FROM audit_log
          WHERE action = 'report_period.due_date_moved' AND entity_id = ?`,
      )
      .bind(s.periodId)
      .first<{ after: string }>();
    expect(audit, 'an audit row was written').toBeTruthy();
    expect(JSON.parse(audit!.after).dueDate).toBe(future(30));
  });

  it('keeps both moves when a date is extended twice', async () => {
    const s = await scenario();
    await moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, future(20), 'First extension.');
    await moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, future(40), 'Second extension.');

    const history = await dueDateHistory(db, s.periodId);
    /*
     * TWO ROWS, NOT ONE OVERWRITTEN. This is the whole reason the amendment is
     * a table rather than columns on the period: columns would have lost the
     * first reason to anything readable, leaving it only in audit_log, which
     * has no read surface in the product.
     */
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.reason)).toEqual(['First extension.', 'Second extension.']);
    expect(history[1]!.oldValue).toBe(history[0]!.newValue);
  });

  it('leaves the record of chases already made alone', async () => {
    const s = await scenario();
    const now = nowIso();
    await db
      .prepare(
        `UPDATE report_periods SET reminder_count = 3, reminder_last_sent_at = ? WHERE id = ?`,
      )
      .bind(now, s.periodId)
      .run();

    await moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, future(30), 'Extended.');

    const after = await period(s.periodId);
    // Three reminders sent before the extension were still sent. The ladder
    // re-arms against the new date on its own, because isReminderDay reads the
    // due date rather than a counter.
    expect(after.reminders).toBe(3);
    expect(after.lastSent).toBe(now);
  });

  it('refuses a date in the past, which is a born-overdue obligation', async () => {
    const s = await scenario();
    const e = await appErrorFrom(
      moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, future(-1), 'Backdating it.'),
    );
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.publicMessage).toBe('A due date has to be in the future.');
    expect(await amendments(s.periodId), 'nothing recorded').toBe(0);
  });

  it('refuses today, because a deadline due today cannot be moved to today', async () => {
    const s = await scenario();
    const today = new Date().toISOString().slice(0, 10);
    const e = await appErrorFrom(
      moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, today, 'Moving it to today.'),
    );
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.publicMessage).toBe('A due date has to be in the future.');
  });

  it('refuses a move with no reason, because the reason is the content', async () => {
    const s = await scenario();
    const e = await appErrorFrom(
      moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, future(30), '   '),
    );
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.publicMessage).toBe('Say why this date is moving.');
    expect(e.fieldErrors?.[0]?.field).toBe('reason');
    expect(await amendments(s.periodId)).toBe(0);
  });

  it('refuses a date that is not a date', async () => {
    const s = await scenario();
    const e = await appErrorFrom(
      moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, '31/12/2026', 'Extended.'),
    );
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.publicMessage).toBe('Enter the new due date as YYYY-MM-DD.');
  });

  it('refuses a move to the date it already has', async () => {
    const s = await scenario();
    const current = (await period(s.periodId)).dueDate;
    const e = await appErrorFrom(
      moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, current.slice(0, 10), 'No change.'),
    );
    expect(e.code).toBe('VALIDATION_FAILED');
  });

  it('refuses to move a settled deadline, and the database refuses too', async () => {
    const s = await scenario({ dueDate: day('2026-01-31') });
    await file(s);
    await acceptReport(db, s.adminCtx, s.admin, s.periodId);

    const e = await appErrorFrom(
      moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, future(30), 'Reopening it.'),
    );
    expect(e.code).toBe('CONFLICT');
    expect(e.publicMessage).toContain('keeps the date it was held to');

    /*
     * AND NOT ONLY IN THE LIBRARY. A fixture writing the amendment correctly
     * must still be refused on an accepted report, because the date is part of
     * what the grantee was held to and an acceptance is already on the row.
     */
    await expect(forceDueDate(s.periodId, future(30))).rejects.toThrow(
      /accepted or waived keeps the date it was held to/,
    );
  });

  it('refuses a reviewer and an applicant', async () => {
    const s = await scenario();
    const reviewer = await appErrorFrom(
      moveReportDueDate(db, s.adminCtx, reviewerSession(), s.periodId, future(30), 'Extended.'),
    );
    expect(reviewer.code).toBe('FORBIDDEN');
    expect(reviewer.httpStatus).toBe(403);

    const applicant = await appErrorFrom(
      moveReportDueDate(
        db, s.adminCtx, applicantSession(s.orgId), s.periodId, future(30), 'Extended.',
      ),
    );
    expect(applicant.code).toBe('FORBIDDEN');
    expect(await amendments(s.periodId)).toBe(0);
  });

  it('answers 404 for a report that is not there', async () => {
    const s = await scenario();
    const e = await appErrorFrom(
      moveReportDueDate(db, s.adminCtx, s.admin, newId(), future(30), 'Extended.'),
    );
    expect(e.code).toBe('NOT_FOUND');
    expect(e.httpStatus).toBe(404);
  });

  // -- what the database guarantees, whatever the caller does ---------------

  it('refuses a bare UPDATE with no amendment at all', async () => {
    const s = await scenario();
    await expect(
      db
        .prepare(`UPDATE report_periods SET due_date = ?, updated_at = ? WHERE id = ?`)
        .bind(future(30), nowIso(), s.periodId)
        .run(),
    ).rejects.toThrow(/changes through an amendment, not an update/);
    // And the date did not move.
    expect((await period(s.periodId)).dueDate).not.toBe(future(30));
  });

  it('refuses an amendment row stamped at a different instant', async () => {
    const s = await scenario();
    const was = (await period(s.periodId)).dueDate;
    const stale = new Date(Date.now() - 60_000).toISOString();
    const actor = await db
      .prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)
      .first<{ id: string }>();

    await db
      .prepare(
        `INSERT INTO report_period_amendments
           (id, report_period_id, amended_at, amended_by, field_changed,
            old_value, new_value, reason, created_at)
         VALUES (?,?,?,?, 'due_date', ?,?, 'Stale.', ?)`,
      )
      .bind(newId(), s.periodId, stale, actor!.id, was, future(30), stale)
      .run();

    /*
     * The amendment exists and describes exactly this move, but is stamped an
     * minute earlier. Refused, so a row left over from an earlier extension
     * cannot wave a later one through.
     */
    await expect(
      db
        .prepare(`UPDATE report_periods SET due_date = ?, updated_at = ? WHERE id = ?`)
        .bind(future(30), nowIso(), s.periodId)
        .run(),
    ).rejects.toThrow(/changes through an amendment, not an update/);
  });

  it('will not let an amendment be rewritten or removed', async () => {
    const s = await scenario();
    await moveReportDueDate(db, s.adminCtx, s.admin, s.periodId, future(30), 'Extended.');
    const row = (await dueDateHistory(db, s.periodId))[0]!;

    await expect(
      db
        .prepare(`UPDATE report_period_amendments SET reason = 'Something else' WHERE id = ?`)
        .bind(row.id)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`DELETE FROM report_period_amendments WHERE id = ?`).bind(row.id).run(),
    ).rejects.toThrow(/append-only/);
  });

  it('will not record an amendment with no reason', async () => {
    const s = await scenario();
    const actor = await db
      .prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)
      .first<{ id: string }>();
    const now = nowIso();
    await expect(
      db
        .prepare(
          `INSERT INTO report_period_amendments
             (id, report_period_id, amended_at, amended_by, field_changed,
              old_value, new_value, reason, created_at)
           VALUES (?,?,?,?, 'due_date', '2026-01-01','2026-02-01', '   ', ?)`,
        )
        .bind(newId(), s.periodId, now, actor!.id, now)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
