import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { dataHealth, ROWS_PER_CHECK, UNCLAIMED_AFTER_DAYS } from '../src/lib/dataHealth';
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
