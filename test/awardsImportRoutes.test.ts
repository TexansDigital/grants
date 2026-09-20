import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import {
  previewAwardImport,
  runAwardImport,
  MAX_CSV_BYTES,
} from '../src/lib/awardsImportRoutes';
import { generateMissingReportPeriods } from '../src/lib/reportPeriods';
import { dataHealth } from '../src/lib/dataHealth';
import { newId } from '../src/lib/ids';

const admin = adminSession();
const ctx = () => ctxFor(admin);

const HEADERS =
  'external_reference,organization_name,ein,program_slug,awarded_amount,awarded_date,' +
  'term_start,term_end,grantee_contact_name,grantee_contact_email,status';

/** Invented nonprofits and invented EINs, per CLAUDE.md. */
const row = (over: Partial<Record<string, string>> = {}) => {
  const r: Record<string, string> = {
    external_reference: 'IC-2026-001',
    organization_name: 'Bayou Reach Collective',
    ein: '00-1234567',
    program_slug: 'ic-import',
    awarded_amount: '25000',
    awarded_date: '2026-03-14',
    term_start: '2026-04-01',
    term_end: '2027-03-31',
    grantee_contact_name: 'Dana Okonkwo',
    grantee_contact_email: 'dana@example-bayoureach.org',
    status: 'active',
    ...over,
  };
  return HEADERS.split(',')
    .map((h) => r[h] ?? '')
    .join(',');
};

const csv = (...rows: string[]) => [HEADERS, ...rows].join('\n');

const seed = () => seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: 'ic-import' });

// ---------------------------------------------------------------------------
describe('who may import awards', () => {
  it('refuses a reviewer on the preview', async () => {
    const e = await appErrorFrom(
      previewAwardImport(db, reviewerSession(), { csv: csv(row()) }),
    );
    expect(e.code).toBe('FORBIDDEN');
  });

  it('refuses a reviewer on the import itself', async () => {
    const e = await appErrorFrom(
      runAwardImport(db, ctx(), reviewerSession(), { csv: csv(row()) }),
    );
    expect(e.code).toBe('FORBIDDEN');
  });

  it('refuses an applicant', async () => {
    const e = await appErrorFrom(
      runAwardImport(db, ctx(), applicantSession(newId()), { csv: csv(row()) }),
    );
    expect(e.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
describe('what the file has to be', () => {
  it('refuses an empty one', async () => {
    const e = await appErrorFrom(previewAwardImport(db, admin, { csv: '   ' }));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.publicMessage).toContain('nothing in that file');
  });

  it('refuses a missing csv field', async () => {
    const e = await appErrorFrom(previewAwardImport(db, admin, {}));
    expect(e.code).toBe('VALIDATION_FAILED');
  });

  /*
   * Measured in BYTES, not characters. A file of accented organization names
   * is longer in UTF-8 than its length suggests, and the limit exists to cap
   * the payload.
   */
  it('refuses one over the size limit, measured in bytes', async () => {
    const wide = 'é'.repeat(MAX_CSV_BYTES / 2 + 10); // 2 bytes each
    expect(wide.length).toBeLessThan(MAX_CSV_BYTES);
    const e = await appErrorFrom(previewAwardImport(db, admin, { csv: wide }));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.publicMessage).toContain('KB');
  });
});

// ---------------------------------------------------------------------------
describe('the preview', () => {
  it('writes nothing', async () => {
    await seed();
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM awards`).first<{ n: number }>();
    await previewAwardImport(db, admin, { csv: csv(row()) });
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM awards`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('says what would be created, and what it would create alongside', async () => {
    await seed();
    const out = await previewAwardImport(db, admin, { csv: csv(row()) });

    expect(out.parse.ok).toBe(true);
    expect(out.parse.rows).toBe(1);
    expect(out.plan?.ok).toBe(true);
    expect(out.plan?.summary.toCreate).toBe(1);
    expect(out.plan?.summary.organizationsToCreate).toBe(1);
    expect(out.plan?.summary.usersToCreate).toBe(1);
    expect(out.plan?.rows[0]).toMatchObject({
      reference: 'IC-2026-001',
      organization: 'Bayou Reach Collective',
      kind: 'create',
      createsOrganization: true,
      createsUser: true,
    });
  });

  it('carries the amount as integer cents', async () => {
    await seed();
    const out = await previewAwardImport(db, admin, { csv: csv(row({ awarded_amount: '19999.99' })) });
    expect(out.plan?.rows[0]?.amountCents).toBe(1_999_999);
    expect(out.plan?.summary.totalCents).toBe(1_999_999);
  });

  /*
   * The point of planning a partly-broken file. Showing "one would import, one
   * is unreadable" in a single pass is what lets somebody fix the second row;
   * refusing to plan until the file is perfect finds the problems one round
   * trip at a time.
   */
  it('still plans the good rows when some are broken', async () => {
    await seed();
    const out = await previewAwardImport(db, admin, {
      csv: csv(row(), row({ external_reference: 'IC-2026-002', awarded_amount: 'not a number' })),
    });

    expect(out.parse.ok).toBe(false);
    expect(out.parse.issues.length).toBeGreaterThan(0);
    expect(out.plan).not.toBeNull();
    expect(out.plan?.summary.toCreate).toBe(1);
  });

  it('names columns it does not understand rather than silently dropping them', async () => {
    await seed();
    const out = await previewAwardImport(db, admin, {
      csv: [`${HEADERS},favourite_colour`, `${row()},blue`].join('\n'),
    });
    expect(out.parse.unknownColumns).toContain('favourite_colour');
  });

  it('plans nothing when no row parsed at all', async () => {
    const out = await previewAwardImport(db, admin, { csv: 'nonsense\n1,2,3' });
    expect(out.plan).toBeNull();
    expect(out.parse.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the import', () => {
  it('creates the award, the organization and the sign-in', async () => {
    await seed();
    const out = await runAwardImport(db, ctx(), admin, { csv: csv(row()) });
    expect(out).toMatchObject({
      awardsCreated: 1,
      organizationsCreated: 1,
      usersCreated: 1,
      skipped: 0,
    });

    const award = await db
      .prepare(`SELECT organization_id, awarded_amount_cents, source_system, source_reference
                  FROM awards WHERE source_reference = ?`)
      .bind('IC-2026-001')
      .first<{ organization_id: string; awarded_amount_cents: number; source_system: string }>();
    expect(award?.awarded_amount_cents).toBe(2_500_000);
    expect(award?.source_system).toBe('spreadsheet');
  });

  it('is a no-op on a second run of the same file', async () => {
    await seed();
    await runAwardImport(db, ctx(), admin, { csv: csv(row()) });
    const again = await runAwardImport(db, ctx(), admin, { csv: csv(row()) });
    expect(again).toMatchObject({ awardsCreated: 0, organizationsCreated: 0, skipped: 1 });
  });

  it('resolves two rows for one nonprofit to a single organization', async () => {
    await seed();
    await runAwardImport(db, ctx(), admin, {
      csv: csv(
        row(),
        row({ external_reference: 'IC-2027-001', awarded_date: '2027-03-14' }),
      ),
    });
    const orgs = await db
      .prepare(`SELECT COUNT(*) AS n FROM organizations WHERE legal_name = ?`)
      .bind('Bayou Reach Collective')
      .first<{ n: number }>();
    expect(orgs?.n).toBe(1);
  });

  it('refuses a file with unreadable rows rather than importing the rest', async () => {
    await seed();
    const e = await appErrorFrom(
      runAwardImport(db, ctx(), admin, {
        csv: csv(row(), row({ external_reference: 'IC-2026-002', awarded_amount: 'oops' })),
      }),
    );
    expect(e.code).toBe('VALIDATION_FAILED');

    const n = await db.prepare(`SELECT COUNT(*) AS n FROM awards`).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('refuses a file naming a program that does not exist', async () => {
    await seed();
    const e = await appErrorFrom(
      runAwardImport(db, ctx(), admin, { csv: csv(row({ program_slug: 'no-such-program' })) }),
    );
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.publicMessage).toContain('cannot be imported');
  });

  it('refuses a file with no rows', async () => {
    const e = await appErrorFrom(runAwardImport(db, ctx(), admin, { csv: HEADERS }));
    expect(e.code).toBe('VALIDATION_FAILED');
  });

  it('audits what it created', async () => {
    await seed();
    await runAwardImport(db, ctx(), admin, { csv: csv(row()) });
    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'award'`)
      .first<{ n: number }>();
    expect(rows?.n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('the whole path to a grantee being able to file', () => {
  /*
   * The reason both of these were built today. An imported award with a term
   * and no report periods is a grant nobody will ever be asked about -- the
   * portal lists periods and so does the compliance desk, and an award with
   * none appears in neither. This walks import -> health notices -> generate
   * -> health clean, because each piece passing its own tests did not mean
   * the path existed.
   */
  it('imports, is noticed as unreportable, and is fixed', async () => {
    await seed();

    await runAwardImport(db, ctx(), admin, {
      csv: csv(row(), row({ external_reference: 'IC-2026-002', ein: '00-7654321',
                            organization_name: 'Third Ward Futures Alliance',
                            grantee_contact_email: 'marcus@example-twfa.org' })),
    });

    const noticed = await dataHealth(db, admin);
    expect(noticed.checks.find((c) => c.key === 'award_no_report_periods')?.count).toBe(2);

    const generated = await generateMissingReportPeriods(db, ctx(), admin);
    expect(generated.periodsCreated).toBe(2);

    const clean = await dataHealth(db, admin);
    expect(clean.checks.find((c) => c.key === 'award_no_report_periods')?.count).toBe(0);

    // And the obligations really exist, against the imported awards.
    const periods = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM report_periods rp
           JOIN awards a ON a.id = rp.award_id
          WHERE a.source_system = 'spreadsheet'`,
      )
      .first<{ n: number }>();
    expect(periods?.n).toBe(2);
  });
});
