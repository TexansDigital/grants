import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import {
  dataHealth, ROWS_PER_CHECK, UNCLAIMED_AFTER_DAYS, storageUsage, STORAGE_WATCH_USD,
  TEST_DATA_PATTERNS,
} from '../src/lib/dataHealth';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

let seq = 0;
const admin = adminSession();
const ctx = () => ctxFor(admin);
const day = (s: string) => `${s}T00:00:00.000Z`;

const program = () => seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `dh-${++seq}` });

/** Invented names and invented EINs, per CLAUDE.md. Never production rows. */
async function org(over: {
  name?: string;
  ein?: string | null;
  verifiedAt?: string | null;
  verifiedName?: string | null;
} = {}) {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations
         (id, legal_name, ein, ein_verified_at, ein_verified_name, status, created_at, updated_at)
       VALUES (?,?,?,?,?,'active',?,?)`,
    )
    .bind(
      id,
      over.name ?? `Cypress Creek Literacy ${++seq}`,
      over.ein === undefined ? String(780000000 + ++seq) : over.ein,
      over.verifiedAt === undefined ? day('2026-01-15') : over.verifiedAt,
      over.verifiedName ?? null,
      now,
      now,
    )
    .run();
  return id;
}

async function award(
  organizationId: string,
  programId: string,
  over: {
    status?: string;
    w9?: string | null;
    agreement?: string | null;
    media?: string | null;
    termStart?: string | null;
    termEnd?: string | null;
    applicationId?: string | null;
    cents?: number;
  } = {},
) {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO awards
         (id, application_id, organization_id, program_id, awarded_amount_cents, awarded_at,
          agreement_signed_at, w9_received_at, media_release_at, term_start, term_end,
          status, source_system, source_reference, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      over.applicationId ?? null,
      organizationId,
      programId,
      over.cents ?? 2_500_000,
      day('2026-03-04'),
      // `over.w9 ?? default` would be the DEFAULT when w9 is null, because ??
      // falls through on null as well as undefined -- so `{ w9: null }` would
      // quietly set a date and the test would assert against an untouched row.
      // Only undefined means "unspecified" here.
      over.agreement === undefined ? day('2026-03-10') : over.agreement,
      over.w9 === undefined ? day('2026-03-10') : over.w9,
      over.media === undefined ? day('2026-03-10') : over.media,
      over.termStart === undefined ? day('2026-04-01') : over.termStart,
      over.termEnd === undefined ? day('2027-03-31') : over.termEnd,
      over.status ?? 'active',
      // The schema insists an award declares where it came from when it has no
      // application behind it: application_id IS NOT NULL OR source_system IS
      // NOT NULL. That is what makes `award_no_application` answerable.
      over.applicationId ? null : 'spreadsheet',
      over.applicationId ? null : `FY26-${id.slice(0, 8)}`,
      now,
      now,
    )
    .run();
  return id;
}

async function reportPeriod(awardId: string, over: { formId?: string | null; status?: string } = {}) {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO report_periods
         (id, award_id, form_definition_id, label, period_type, due_date, status, created_at, updated_at)
       VALUES (?,?,?,'Final report','final',?,?,?,?)`,
    )
    .bind(id, awardId, over.formId ?? null, day('2027-04-30'), over.status ?? 'scheduled', now, now)
    .run();
  return id;
}

/**
 * An award that trips no check at all.
 *
 * The plain `award()` above has term dates and no report periods, which is
 * itself a finding -- correctly, it is the "nobody will ever be asked" check.
 * Tests about TOTALS need a baseline that is silent, so they can break one
 * thing and count it.
 */
async function silentAward(
  p: Awaited<ReturnType<typeof seedProgram>>,
  organizationId: string,
  over: Parameters<typeof award>[2] = {},
) {
  const id = await award(organizationId, p.programId, over);
  await reportPeriod(id, { formId: Object.values(p.formDefinitionIds)[0]! });
  return id;
}

/** A submitted application, which is what puts an organization "in play". */
async function submittedApplication(
  organizationId: string,
  p: Awaited<ReturnType<typeof seedProgram>>,
) {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?, 'submitted', ?,?,?)`,
    )
    .bind(
      id,
      Object.values(p.cycleIds)[0]!,
      Object.values(p.stageIds)[0]!,
      organizationId,
      Object.values(p.formDefinitionIds)[0]!,
      now,
      now,
      now,
    )
    .run();
  return id;
}

/**
 * `claimedBy` must be a REAL application id: 0004 carries a trigger refusing an
 * attachment whose parent_type is 'application' and whose parent does not
 * exist. An invented id fails at insert, not at assert.
 */
async function attachment(
  organizationId: string | null,
  uploadedAt: string,
  claimedBy: string | null = null,
) {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO attachments
         (id, parent_type, parent_id, organization_id, r2_key, filename, mime_type,
          size_bytes, uploaded_at)
       VALUES (?,'application',?,?,?,'budget.pdf','application/pdf',1024,?)`,
    )
    .bind(id, claimedBy, organizationId, `org/x/${id}`, uploadedAt)
    .run();
  return id;
}

const check = (report: Awaited<ReturnType<typeof dataHealth>>, key: string) => {
  const found = report.checks.find((c) => c.key === key);
  if (!found) throw new Error(`no check named ${key}`);
  return found;
};

// ---------------------------------------------------------------------------
describe('who may read it', () => {
  it('refuses a reviewer', async () => {
    const e = await appErrorFrom(dataHealth(db, reviewerSession()));
    expect(e.code).toBe('FORBIDDEN');
    expect(e.httpStatus).toBe(403);
  });

  it('refuses an applicant', async () => {
    const e = await appErrorFrom(dataHealth(db, applicantSession(newId())));
    expect(e.code).toBe('FORBIDDEN');
  });

  it('lets an admin through', async () => {
    const report = await dataHealth(db, admin);
    expect(report.checks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('the shape of the report', () => {
  it('keeps checks that found nothing, so clean is distinguishable from not-run', async () => {
    const report = await dataHealth(db, admin);
    const w9 = check(report, 'award_no_w9');
    expect(w9.count).toBe(0);
    expect(w9.rows).toEqual([]);
    // The label and guidance are still there to read.
    expect(w9.label.length).toBeGreaterThan(0);
    expect(w9.guidance.length).toBeGreaterThan(0);
  });

  it('puts blocking first and informational last', async () => {
    const report = await dataHealth(db, admin);
    const rank = { blocking: 0, attention: 1, informational: 2 } as const;
    const seen = report.checks.map((c) => rank[c.severity]);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('reports the time it was generated', async () => {
    const report = await dataHealth(db, admin, { now: day('2026-06-01') });
    expect(report.generatedAt).toBe(day('2026-06-01'));
  });
});

// ---------------------------------------------------------------------------
describe('award paperwork', () => {
  it('flags an active grant with no W-9, and leaves a complete one alone', async () => {
    const p = await program();
    const missing = await org();
    const complete = await org();
    const bad = await award(missing, p.programId, { w9: null });
    await award(complete, p.programId);

    const c = check(await dataHealth(db, admin), 'award_no_w9');
    expect(c.count).toBe(1);
    expect(c.rows.map((r) => r.id)).toEqual([bad]);
    expect(c.rows[0]!.kind).toBe('award');
  });

  it('carries the amount as integer cents, not a formatted string', async () => {
    const p = await program();
    const o = await org();
    await award(o, p.programId, { w9: null, cents: 2_500_000 });

    const row = check(await dataHealth(db, admin), 'award_no_w9').rows[0]!;
    expect(row.amountCents).toBe(2_500_000);
    expect(typeof row.amountCents).toBe('number');
  });

  it('ignores a pending grant, which has no paperwork yet by definition', async () => {
    const p = await program();
    const o = await org();
    await award(o, p.programId, { status: 'pending', w9: null, agreement: null });

    const report = await dataHealth(db, admin);
    expect(check(report, 'award_no_w9').count).toBe(0);
    expect(check(report, 'award_no_agreement').count).toBe(0);
  });

  it('ignores a soft-deleted grant', async () => {
    const p = await program();
    const o = await org();
    const id = await award(o, p.programId, { w9: null });
    await db.prepare(`UPDATE awards SET deleted_at = ? WHERE id = ?`).bind(nowIso(), id).run();

    expect(check(await dataHealth(db, admin), 'award_no_w9').count).toBe(0);
  });

  it('separates the agreement and media-release checks by severity', async () => {
    const report = await dataHealth(db, admin);
    expect(check(report, 'award_no_agreement').severity).toBe('blocking');
    expect(check(report, 'award_no_media_release').severity).toBe('attention');
  });
});

// ---------------------------------------------------------------------------
describe('obligations nobody will ever be asked for', () => {
  it('flags a termed grant with no report periods', async () => {
    const p = await program();
    const silent = await org();
    const fine = await org();
    const bad = await award(silent, p.programId);
    const good = await award(fine, p.programId);
    await reportPeriod(good);

    const c = check(await dataHealth(db, admin), 'award_no_report_periods');
    expect(c.count).toBe(1);
    expect(c.rows.map((r) => r.id)).toEqual([bad]);
  });

  it('does not flag a grant with no term, which is the other check', async () => {
    const p = await program();
    const o = await org();
    await award(o, p.programId, { termStart: null, termEnd: null });

    const report = await dataHealth(db, admin);
    expect(check(report, 'award_no_report_periods').count).toBe(0);
    expect(check(report, 'award_no_term').count).toBe(1);
  });

  it('needs BOTH term dates before it expects report periods', async () => {
    // Half a term is not a term: period generation needs a start and an end,
    // so a grant with one of them is the no-term finding, not the silent one.
    const p = await program();
    const halfTermed = await org();
    await award(halfTermed, p.programId, { termEnd: null });

    const report = await dataHealth(db, admin);
    expect(check(report, 'award_no_report_periods').count).toBe(0);
    expect(check(report, 'award_no_term').count).toBe(1);
  });

  it('counts a soft-deleted report period as no period at all', async () => {
    const p = await program();
    const o = await org();
    const a = await award(o, p.programId);
    const rp = await reportPeriod(a);
    await db.prepare(`UPDATE report_periods SET deleted_at = ? WHERE id = ?`).bind(nowIso(), rp).run();

    expect(check(await dataHealth(db, admin), 'award_no_report_periods').count).toBe(1);
  });

  it('flags a report period with no form, because the grantee cannot file', async () => {
    const p = await program();
    const o = await org({ name: 'Third Ward Music Project' });
    const a = await award(o, p.programId);
    const rp = await reportPeriod(a, { formId: null });

    const c = check(await dataHealth(db, admin), 'report_period_no_form');
    expect(c.count).toBe(1);
    expect(c.rows[0]!.id).toBe(rp);
    expect(c.rows[0]!.title).toBe('Third Ward Music Project');
    expect(c.rows[0]!.kind).toBe('report_period');
  });

  it('leaves an accepted period alone even with no form', async () => {
    const p = await program();
    const o = await org();
    const a = await award(o, p.programId);
    await reportPeriod(a, { formId: null, status: 'accepted' });

    expect(check(await dataHealth(db, admin), 'report_period_no_form').count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('EIN state', () => {
  it('ignores an organization that has never submitted or been awarded', async () => {
    await org({ ein: null });
    expect(check(await dataHealth(db, admin), 'organization_no_ein').count).toBe(0);
  });

  it('flags one that has submitted an application', async () => {
    const p = await program();
    const o = await org({ ein: null });
    await submittedApplication(o, p);

    const c = check(await dataHealth(db, admin), 'organization_no_ein');
    expect(c.count).toBe(1);
    expect(c.rows[0]!.id).toBe(o);
  });

  it('flags one that holds a grant', async () => {
    const p = await program();
    const o = await org({ ein: null });
    await award(o, p.programId);

    expect(check(await dataHealth(db, admin), 'organization_no_ein').count).toBe(1);
  });

  it('does not count a DRAFT application as being in play', async () => {
    const p = await program();
    const o = await org({ ein: null });
    const id = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, created_at, updated_at)
         VALUES (?,?,?,?,?, 'draft', ?,?)`,
      )
      .bind(
        id,
        Object.values(p.cycleIds)[0]!,
        Object.values(p.stageIds)[0]!,
        o,
        Object.values(p.formDefinitionIds)[0]!,
        now,
        now,
      )
      .run();

    expect(check(await dataHealth(db, admin), 'organization_no_ein').count).toBe(0);
  });

  it('flags an unverified EIN separately from a missing one', async () => {
    const p = await program();
    const noEin = await org({ ein: null });
    const unverified = await org({ ein: '781234567', verifiedAt: null });
    await award(noEin, p.programId);
    await award(unverified, p.programId);

    const report = await dataHealth(db, admin);
    expect(check(report, 'organization_no_ein').rows.map((r) => r.id)).toEqual([noEin]);
    expect(check(report, 'ein_unverified').rows.map((r) => r.id)).toEqual([unverified]);
  });

  it('does not flag a verified EIN as unverified', async () => {
    const p = await program();
    const o = await org({ ein: '781234500', verifiedAt: day('2026-01-02'), verifiedName: null });
    await award(o, p.programId);

    expect(check(await dataHealth(db, admin), 'ein_unverified').count).toBe(0);
  });

  it('flags a name that differs from the IRS record, ignoring case and spacing', async () => {
    const p = await program();
    const same = await org({ name: 'Harbor Light Arts', verifiedName: '  harbor light ARTS ' });
    const different = await org({ name: 'Bayou Bridge Youth', verifiedName: 'Bayou Bridge Youth Services' });
    await award(same, p.programId);
    await award(different, p.programId);

    const c = check(await dataHealth(db, admin), 'ein_name_mismatch');
    expect(c.count).toBe(1);
    expect(c.rows[0]!.id).toBe(different);
    expect(c.rows[0]!.detail).toContain('Bayou Bridge Youth Services');
  });

  it('says nothing when the IRS name was never fetched', async () => {
    const p = await program();
    const o = await org({ verifiedName: null });
    await award(o, p.programId);

    expect(check(await dataHealth(db, admin), 'ein_name_mismatch').count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('unclaimed uploads', () => {
  it('ignores a recent one, because a draft is legitimately open', async () => {
    const o = await org();
    await attachment(o, nowIso());
    expect(check(await dataHealth(db, admin), 'unclaimed_attachments').count).toBe(0);
  });

  it('flags one older than the window', async () => {
    const o = await org();
    const old = new Date(Date.now() - (UNCLAIMED_AFTER_DAYS + 1) * 86400_000).toISOString();
    const id = await attachment(o, old);

    const c = check(await dataHealth(db, admin), 'unclaimed_attachments');
    expect(c.count).toBe(1);
    expect(c.rows[0]!.id).toBe(id);
    expect(c.rows[0]!.kind).toBe('attachment');
  });

  it('ignores one that was claimed by a submit', async () => {
    const p = await program();
    const o = await org();
    const applicationId = await submittedApplication(o, p);
    const old = new Date(Date.now() - (UNCLAIMED_AFTER_DAYS + 1) * 86400_000).toISOString();
    await attachment(o, old, applicationId);

    expect(check(await dataHealth(db, admin), 'unclaimed_attachments').count).toBe(0);
  });

  it('measures the window from the supplied clock, not the wall clock', async () => {
    const o = await org();
    await attachment(o, day('2026-01-01'));
    // Two days after the upload: inside the window, so not yet a finding.
    const early = await dataHealth(db, admin, { now: day('2026-01-03') });
    expect(check(early, 'unclaimed_attachments').count).toBe(0);
    // Thirty days after: outside it.
    const late = await dataHealth(db, admin, { now: day('2026-01-31') });
    expect(check(late, 'unclaimed_attachments').count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('imported history', () => {
  it('reports a grant with no application as informational, not a fault', async () => {
    const p = await program();
    const o = await org();
    await award(o, p.programId, { applicationId: null });

    const c = check(await dataHealth(db, admin), 'award_no_application');
    expect(c.count).toBe(1);
    expect(c.severity).toBe('informational');
  });
});

// ---------------------------------------------------------------------------
describe('counts and truncation', () => {
  /*
   * The window function is the thing being pinned. COUNT(*) OVER () is
   * evaluated before LIMIT, so every row carries the size of the FULL result
   * set. Get that wrong and the header reads "3 blocking" over a list of
   * fifty, which is worse than no header at all.
   */
  it('counts every match even when only a page of rows comes back', async () => {
    const p = await program();
    const n = ROWS_PER_CHECK + 3;
    for (let i = 0; i < n; i += 1) {
      const o = await org({ name: `Overflow Org ${i}` });
      await award(o, p.programId, { w9: null });
    }

    const c = check(await dataHealth(db, admin), 'award_no_w9');
    expect(c.count).toBe(n);
    expect(c.rows.length).toBe(ROWS_PER_CHECK);
    expect(c.truncated).toBe(true);
  });

  it('does not claim truncation when everything fits', async () => {
    const p = await program();
    const o = await org();
    await award(o, p.programId, { w9: null });

    const c = check(await dataHealth(db, admin), 'award_no_w9');
    expect(c.truncated).toBe(false);
    expect(c.rows.length).toBe(c.count);
  });

  it('totals the severities across checks', async () => {
    const p = await program();
    const o = await org();
    // One award trips w9, agreement (blocking) and media release (attention),
    // and nothing else.
    await silentAward(p, o, { w9: null, agreement: null, media: null });

    const report = await dataHealth(db, admin);
    expect(report.blocking).toBe(2);
    expect(report.attention).toBe(1);
  });

  it('leaves informational findings out of both totals', async () => {
    const p = await program();
    const o = await org();
    await silentAward(p, o, { applicationId: null });

    const report = await dataHealth(db, admin);
    expect(report.blocking).toBe(0);
    expect(report.attention).toBe(0);
    expect(check(report, 'award_no_application').count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('duplicates come from the merge tool, not a second copy of its rules', () => {
  it('reports the same groups the merge screen would', async () => {
    await org({ name: 'Gulf Coast Readers', ein: '782222222' });
    await org({ name: 'Gulf Coast Readers Inc', ein: '782222222' });

    const c = check(await dataHealth(db, admin), 'duplicate_organizations');
    expect(c.count).toBe(1);
    expect(c.severity).toBe('informational');
    expect(c.rows[0]!.detail).toContain('782222222');
    expect(c.rows[0]!.title).toContain('Gulf Coast Readers');
  });
});

describe('what R2 is holding, and what it costs', () => {
  async function withFiles(files: { parent: string; bytes: number; purged?: boolean; mime?: string; dueAt?: string | null }[]) {
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?, 'active', ?, ?)`,
    ).bind(orgId, `Storage Org ${crypto.randomUUID().slice(0, 6)}`,
           String(970000000 + Math.floor(Math.random() * 9999)), now, now).run();
    for (const f of files) {
      const id = newId();
      await db.prepare(
        `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
           filename, mime_type, size_bytes, uploaded_at, purged_at, purge_due_at)
         VALUES (?,?,NULL,?,?,?,?,?,?,?,?)`,
      ).bind(id, f.parent, orgId, `k/${id}`, `${id}.pdf`,
             f.mime ?? 'application/pdf', f.bytes, now,
             f.purged ? now : null, f.dueAt ?? null).run();
    }
    return orgId;
  }

  it('counts what is there and not what was destroyed', async () => {
    await withFiles([
      { parent: 'application', bytes: 10_000_000 },
      { parent: 'application', bytes: 5_000_000, purged: true },
    ]);
    const usage = await storageUsage(db, adminSession());
    // A purged row survives so the record of what was uploaded survives; the
    // bytes do not, and counting them would overstate the bill forever.
    expect(usage.byParent.find((p) => p.parentType === 'application')?.bytes)
      .toBe(10_000_000);
  });

  it('separates the part nothing ever deletes', async () => {
    /*
     * Retention destroys APPLICATION documents 90 days after a decision.
     * Report attachments -- now including video -- have no clock at all, so
     * they are the line that grows without bound and the one worth watching.
     */
    await withFiles([
      { parent: 'application', bytes: 1_000_000 },
      { parent: 'report_submission', bytes: 200_000_000 },
    ]);
    const usage = await storageUsage(db, adminSession());
    expect(usage.unretainedBytes).toBeGreaterThanOrEqual(200_000_000);
    expect(usage.totalBytes).toBeGreaterThan(usage.unretainedBytes);
  });

  it('is a number to look at, not an alarm that fires at this scale', async () => {
    await withFiles([{ parent: 'report_submission', bytes: 200_000_000 }]);
    const usage = await storageUsage(db, adminSession());
    // 200 MB is a third of a cent a month. $5 is 333 GB, roughly sixteen
    // hundred full-size videos, which is not a figure reached by accident.
    expect(usage.estimatedMonthlyUsd).toBeLessThan(STORAGE_WATCH_USD);
    expect(usage.overWatchThreshold).toBe(false);
  });

  it('flags it once the estimate actually passes the figure', async () => {
    const big = 400 * 1024 ** 3; // 400 GB, comfortably past 333
    await withFiles([{ parent: 'report_submission', bytes: big }]);
    const usage = await storageUsage(db, adminSession());
    expect(usage.overWatchThreshold).toBe(true);
    expect(usage.estimatedMonthlyUsd).toBeGreaterThan(STORAGE_WATCH_USD);
  });

  it('is admin only, like everything else on this screen', async () => {
    await expect(storageUsage(db, reviewerSession())).rejects.toThrow();
  });
});

describe('what the storage figure actually counts', () => {
  async function put(rows: { parent: string; bytes: number; mime?: string; dueAt?: string | null }[]) {
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, `Media Org ${crypto.randomUUID().slice(0, 6)}`,
           String(960000000 + Math.floor(Math.random() * 9999)), now, now).run();
    for (const r of rows) {
      const id = newId();
      await db.prepare(
        `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
           filename, mime_type, size_bytes, uploaded_at, purge_due_at)
         VALUES (?,?,NULL,?,?,?,?,?,?,?)`,
      ).bind(id, r.parent, orgId, `k/${id}`, `${id}.bin`,
             r.mime ?? 'application/pdf', r.bytes, now, r.dueAt ?? null).run();
    }
  }

  it('stops calling a report document unretained once it has a deletion date', async () => {
    /*
     * This read the parent type and called every report attachment unretained.
     * That was true while report files had no retention path at all, and stops
     * being true the moment a window is configured -- at which point the figure
     * would overstate the permanent footprint forever, which is the opposite of
     * what somebody watching a bill wants.
     */
    const before = (await storageUsage(db, adminSession())).unretainedBytes;
    await put([
      { parent: 'report_submission', bytes: 1_000_000, dueAt: '2027-01-01T00:00:00.000Z' },
      { parent: 'report_submission', bytes: 4_000_000, dueAt: null },
    ]);
    const usage = await storageUsage(db, adminSession());
    expect(usage.unretainedBytes - before).toBe(4_000_000);
  });

  it('counts a photograph as unretained, because nothing will ever delete it', async () => {
    const before = (await storageUsage(db, adminSession())).unretainedBytes;
    await put([{ parent: 'report_submission', bytes: 3_000_000, mime: 'image/heic' }]);
    expect((await storageUsage(db, adminSession())).unretainedBytes - before).toBe(3_000_000);
  });

  it('reports media separately, because video is what fills a bucket', async () => {
    const before = await storageUsage(db, adminSession());
    await put([
      { parent: 'report_submission', bytes: 180_000_000, mime: 'video/mp4' },
      { parent: 'report_submission', bytes: 6_000_000, mime: 'image/jpeg' },
      { parent: 'report_submission', bytes: 500_000, mime: 'application/pdf' },
    ]);
    const after = await storageUsage(db, adminSession());
    // The PDF is not media, and counting it here would blur the one number
    // that answers what a decision about video would actually save.
    expect(after.mediaBytes - before.mediaBytes).toBe(186_000_000);
    expect(after.mediaFiles - before.mediaFiles).toBe(2);
  });
});

// ---------------------------------------------------------------------------
/**
 * A nonprofit we tried to email and could not reach.
 *
 * WHY THIS CHECK EXISTS. `email_messages` has recorded `failed` with the
 * provider's error code since migration 0007, and until now NOTHING in this
 * system read that table — not a screen, not a job, not a check. A grantee
 * whose magic link bounced was recorded correctly and surfaced nowhere: they
 * are told "a link is on its way", the report goes overdue, the nightly
 * reminder bounces identically, and the compliance desk shows a red row
 * nobody caused.
 */
describe('grantees we could not reach', () => {
  /** A grantee account on an organization, and one message to it. */
  async function mailTo(opts: {
    organizationId: string;
    status: 'sent' | 'failed' | 'suppressed';
    createdAt: string;
    email?: string;
  }): Promise<string> {
    const now = nowIso();
    const email = opts.email ?? `grantee-${++seq}@example.org`;
    const existing = await db
      .prepare(`SELECT id FROM users WHERE email = ? AND deleted_at IS NULL`)
      .bind(email)
      .first<{ id: string }>();
    if (!existing) {
      await db
        .prepare(
          `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
           VALUES (?,?,'grantee',?,1,?,?)`,
        )
        .bind(newId(), email, opts.organizationId, now, now)
        .run();
    }
    await db
      .prepare(
        `INSERT INTO email_messages
           (id, idempotency_key, template_key, to_email, subject, status,
            error_code, sent_at, created_at, updated_at)
         VALUES (?,?,'sign_in_link',?,'Your sign-in link',?,?,?,?,?)`,
      )
      .bind(
        newId(), `k-${newId()}`, email, opts.status,
        opts.status === 'failed' ? 'bounced' : null,
        opts.status === 'sent' ? opts.createdAt : null,
        opts.createdAt, now,
      )
      .run();
    return email;
  }

  it('names an organization whose last message was refused', async () => {
    const p = await program();
    const o = await org({ name: 'Bayou Harbor Trust' });
    await award(o, p.programId, {});
    await mailTo({ organizationId: o, status: 'failed', createdAt: day('2026-10-01') });

    const c = check(await dataHealth(db, admin), 'email_undeliverable');
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]?.title).toContain('Bayou Harbor Trust');
    // The address and the provider's reason, so it can be acted on without
    // opening anything.
    expect(c.rows[0]?.detail).toContain('bounced');
    expect(c.severity).toBe('blocking');
  });

  /*
   * THE CASE THAT MUST NOT FIRE. A bounce followed by a successful send is a
   * solved problem — a corrected address, a mailbox emptied. Listing it would
   * teach somebody to ignore the check, which is worse than not having one.
   */
  it('says nothing once something has got through since', async () => {
    const p = await program();
    const o = await org({ name: 'Harrisburg Arts' });
    await award(o, p.programId, {});
    const email = await mailTo({
      organizationId: o, status: 'failed', createdAt: day('2026-10-01'),
    });
    await mailTo({
      organizationId: o, status: 'sent', createdAt: day('2026-10-02'), email,
    });

    expect(check(await dataHealth(db, admin), 'email_undeliverable').rows).toHaveLength(0);
  });

  it('is not triggered by a message that was never sent on purpose', async () => {
    const p = await program();
    const o = await org({ name: 'Clear Creek Fund' });
    await award(o, p.programId, {});
    // `suppressed` means no provider is configured — the ordinary state in
    // preview. It is not evidence that anybody is unreachable.
    await mailTo({ organizationId: o, status: 'suppressed', createdAt: day('2026-10-01') });

    expect(check(await dataHealth(db, admin), 'email_undeliverable').rows).toHaveLength(0);
  });

  it('reads as clean rather than missing when nobody has bounced', async () => {
    const c = check(await dataHealth(db, admin), 'email_undeliverable');
    expect(c.rows).toHaveLength(0);
    expect(c.label).toContain('could not reach');
  });
});

// ---------------------------------------------------------------------------
/**
 * What the system wrote down about itself.
 *
 * `error_log` had twelve write sites and zero reads. Nothing queried it — not
 * a screen, not a job, not an export — so every diagnosis in it was written
 * carefully and seen by nobody: a cron job that died, a reminder a provider
 * refused, a financial statement that could not be destroyed on its retention
 * date.
 *
 * The sharpest case was self-inflicted. A fix landed earlier the same day
 * logged REPORT_REMINDER_NOT_DELIVERED so a bounced reminder would stop being
 * invisible — into this table. It moved the problem from "not recorded" to
 * "recorded where nobody looks", and was reported as fixed.
 */
describe('errors the system recorded', () => {
  async function logged(opts: {
    code: string;
    severity?: 'warn' | 'error' | 'fatal';
    message?: string;
    agoDays?: number;
  }): Promise<void> {
    const at = new Date(Date.now() - (opts.agoDays ?? 0) * 86_400_000).toISOString();
    await db
      .prepare(
        `INSERT INTO error_log (id, severity, code, message, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .bind(newId(), opts.severity ?? 'error', opts.code, opts.message ?? 'something broke', at)
      .run();
  }

  it('names a code, how many times, and the newest message', async () => {
    await logged({ code: 'CRON_FAILED', message: 'older', agoDays: 2 });
    await logged({ code: 'CRON_FAILED', message: 'the most recent one' });

    const c = check(await dataHealth(db, admin), 'recorded_errors');
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]?.title).toBe('CRON_FAILED');
    expect(c.rows[0]?.detail).toContain('2 times');
    // The newest message, not whichever the grouping happened to pick.
    expect(c.rows[0]?.detail).toContain('the most recent one');
  });

  it('points at no record, because an error code is not a row', async () => {
    await logged({ code: 'RETENTION_PURGE_FAILED' });
    const c = check(await dataHealth(db, admin), 'recorded_errors');
    // `system` is what stops the UI printing "RETENTI" as though it were an id
    // somebody could look up.
    expect(c.rows[0]?.kind).toBe('system');
  });

  /*
   * A warn is left out deliberately. REPORT_REMINDER_NO_CONTACT is a warn and
   * is already a visible state on the organization page; repeating it here
   * would make the list long enough to stop being read.
   */
  it('leaves out a warning that is already visible elsewhere', async () => {
    await logged({ code: 'REPORT_REMINDER_NO_CONTACT', severity: 'warn' });
    expect(check(await dataHealth(db, admin), 'recorded_errors').rows).toHaveLength(0);
  });

  it('asks whether something is failing now, not what ever went wrong', async () => {
    await logged({ code: 'ANCIENT_FAILURE', agoDays: 30 });
    expect(check(await dataHealth(db, admin), 'recorded_errors').rows).toHaveLength(0);
  });

  it('surfaces the two that were written to it and never read', async () => {
    // Both of these existed and reached nobody: one logged by the reminder job
    // when a provider refuses a message, one by the retention pass when a file
    // past its date cannot be destroyed.
    await logged({ code: 'REPORT_REMINDER_NOT_DELIVERED' });
    await logged({ code: 'RETENTION_PURGE_FAILED' });

    const codes = check(await dataHealth(db, admin), 'recorded_errors').rows.map((r) => r.title);
    expect(codes).toContain('REPORT_REMINDER_NOT_DELIVERED');
    expect(codes).toContain('RETENTION_PURGE_FAILED');
  });

  it('reads as clean rather than missing when nothing has failed', async () => {
    const c = check(await dataHealth(db, admin), 'recorded_errors');
    expect(c.rows).toHaveLength(0);
    expect(c.severity).toBe('attention');
  });
});

// ---------------------------------------------------------------------------
/*
 * THE GUARD FOR TEST ROWS LEFT IN PRODUCTION.
 *
 * Two awards created by hand while walking the flow -- an end-to-end claim
 * test and a demo CSV row -- sat in production for days. Nothing read for
 * them, and "ask past grantees for an update" would have counted one of them
 * as a nonprofit to email.
 *
 * These tests assert the specific count and the specific id, not just that
 * something was flagged: a check that fires on everything is as useless as one
 * that fires on nothing, and the false-positive case below is the half that
 * matters. "Democracy Now" is a real charity name and must not be flagged.
 */
describe('test rows left in the database', () => {
  /** An award with a chosen source_reference, which `award()` does not expose. */
  async function referenced(organizationId: string, programId: string, reference: string) {
    const id = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO awards
           (id, organization_id, program_id, awarded_amount_cents, awarded_at,
            status, source_system, source_reference, created_at, updated_at)
         VALUES (?,?,?,?,?, 'completed', 'spreadsheet', ?, ?, ?)`,
      )
      .bind(id, organizationId, programId, 10_000, day('2026-03-04'), reference, now, now)
      .run();
    return id;
  }

  it('flags the reference the end-to-end test wrote', async () => {
    const p = await program();
    const o = await org({ name: 'Cypress Creek Literacy Council' });
    const id = await referenced(o, p.programId, 'TEST-2026-001');

    const c = check(await dataHealth(db, admin), 'test_data_present');
    expect(c.count).toBe(1);
    expect(c.rows.map((r) => r.id)).toEqual([id]);
    expect(c.rows[0]!.detail).toBe('reference TEST-2026-001');
    expect(c.severity).toBe('blocking');
  });

  it('flags the reference the demo loader wrote', async () => {
    const p = await program();
    const o = await org({ name: 'Bayou Reach Collective' });
    const id = await referenced(o, p.programId, 'DEMO-01');

    const c = check(await dataHealth(db, admin), 'test_data_present');
    expect(c.rows.map((r) => r.id)).toEqual([id]);
  });

  it('flags an organization named as not real, whatever its reference', async () => {
    const p = await program();
    const o = await org({ name: 'Demo Nonprofit (not a real grantee)' });
    const id = await referenced(o, p.programId, 'IC-2025-099');

    const c = check(await dataHealth(db, admin), 'test_data_present');
    expect(c.count).toBe(1);
    expect(c.rows.map((r) => r.id)).toEqual([id]);
    // The reference is real-looking, so the detail must say what actually matched.
    expect(c.rows[0]!.detail).toBe('reference IC-2025-099');
  });

  it('leaves a real grant alone, including one whose name merely contains "demo"', async () => {
    const p = await program();
    const real = await org({ name: 'Democracy Now Houston' });
    const latest = await org({ name: 'Attestation Testing Services of Texas' });
    await referenced(real, p.programId, 'IC-2025-001');
    await referenced(latest, p.programId, 'IC-2025-002');

    const c = check(await dataHealth(db, admin), 'test_data_present');
    expect(c.count).toBe(0);
    expect(c.rows).toEqual([]);
  });

  it('stops flagging once the row is soft-deleted, which is how cleanup clears it', async () => {
    const p = await program();
    const o = await org({ name: 'Steward End To End Test Org' });
    const id = await referenced(o, p.programId, 'TEST-2026-002');

    expect(check(await dataHealth(db, admin), 'test_data_present').count).toBe(1);

    await db
      .prepare(`UPDATE awards SET deleted_at = ?, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), nowIso(), id)
      .run();

    const c = check(await dataHealth(db, admin), 'test_data_present');
    expect(c.count).toBe(0);
  });

  it('matches the reference without regard to case', async () => {
    const p = await program();
    const o = await org({ name: 'Third Ward Futures' });
    const id = await referenced(o, p.programId, 'test-2026-003');

    const c = check(await dataHealth(db, admin), 'test_data_present');
    expect(c.rows.map((r) => r.id)).toEqual([id]);
  });

  it('pins the patterns, so widening one is a deliberate edit', () => {
    expect(TEST_DATA_PATTERNS.reference).toEqual(['TEST-%', 'DEMO-%', '%-TEST', '%-DEMO']);
    expect(TEST_DATA_PATTERNS.name).toEqual([
      '%not a real%',
      '%test org%',
      '%demo nonprofit%',
      '%sample nonprofit%',
    ]);
    // '%demo%' would flag "Democracy Now". The narrowness is the point.
    expect(TEST_DATA_PATTERNS.name).not.toContain('%demo%');
    expect(TEST_DATA_PATTERNS.name).not.toContain('%test%');
  });
});
