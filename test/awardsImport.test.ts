import { describe, it, expect } from 'vitest';
import { parseAwardsCsv, parseImportDate, formatAwardReport } from '../src/import/awards';
// Imported as text rather than read from disk: these tests run inside workerd,
// which has no filesystem. Importing it means the TEMPLATE ITSELF is under
// test -- if the file the Foundation is told to fill stops parsing, this fails.
import TEMPLATE from '../docs/awards-import-template.csv?raw';

/**
 * Everything here is invented. The real file never comes to me: the Foundation
 * fills the template and runs the import locally, so these fixtures are the
 * only awards this code is ever tested against.
 */
const HEADER =
  'external_reference,organization_name,ein,program_slug,fiscal_year,awarded_amount,' +
  'awarded_date,announcement_date,term_start,term_end,is_multi_year,parent_external_reference,' +
  'agreement_signed_date,w9_received_date,media_release_date,grantee_contact_name,' +
  'grantee_contact_email,grantee_contact_phone,status,notes';

const ROW =
  'IC-2025-001,Bayou Reach Collective,00-1234567,inspire-change,2025,25000,2025-03-14,' +
  '2025-03-20,2025-04-01,2026-03-31,no,,2025-03-28,2025-03-28,2025-03-28,Dana Okonkwo,' +
  'dana@example-bayoureach.org,713-555-0123,completed,';

const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
/** Replace one column in the sample row, by header name. */
const withCol = (column: string, value: string, base = ROW) => {
  const cols = HEADER.split(',');
  const i = cols.indexOf(column);
  if (i < 0) throw new Error(`no such column ${column}`);
  const parts = base.split(',');
  parts[i] = value;
  return parts.join(',');
};

// ---------------------------------------------------------------------------
describe('reading a file of past awards', () => {
  it('reads the template the Foundation is given', () => {
    // The template in docs/ is the contract. If it stops parsing, the
    // instructions and the code have drifted apart.
    const result = parseAwardsCsv(TEMPLATE);
    expect(result.issues, formatAwardReport(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.awards).toHaveLength(4);
    expect(result.awards[0]!.externalReference).toBe('IC-2025-001');
    // $19,999.99 keeps its cents all the way through.
    expect(result.awards[3]!.awardedAmountCents).toBe(1_999_999);
  });

  it('stores money as integer cents', () => {
    // Quoted where the value contains a comma, which is how a spreadsheet
    // writes it -- an unquoted $25,000 is two CSV fields and a broken row.
    for (const [written, cents] of [
      ['25000', 2_500_000], ['"$25,000"', 2_500_000],
      ['19999.99', 1_999_999], ['"$1,234.50"', 123_450],
    ] as const) {
      const r = parseAwardsCsv(csv(withCol('awarded_amount', written)));
      expect(r.awards[0]!.awardedAmountCents, written).toBe(cents);
      expect(Number.isInteger(r.awards[0]!.awardedAmountCents)).toBe(true);
    }
  });

  it('normalizes an EIN however it was typed', () => {
    for (const written of ['00-1234567', '001234567', '00 1234567', ' 00-123-4567 ']) {
      const r = parseAwardsCsv(csv(withCol('ein', written)));
      expect(r.awards[0]!.ein, written).toBe('001234567');
    }
  });

  it('ignores columns it does not know, rather than refusing the file', () => {
    // Somebody's spreadsheet will have a Notes2 column. That is not a reason to
    // reject two years of records.
    const r = parseAwardsCsv([`${HEADER},internal_tracking_code`, `${ROW},XYZ-1`].join('\n'));
    expect(r.ok).toBe(true);
    expect(r.unknownColumns).toEqual(['internal_tracking_code']);
  });

  it('matches headers whatever the casing', () => {
    const shouty = HEADER.toUpperCase();
    const r = parseAwardsCsv([shouty, ROW].join('\n'));
    expect(r.ok, formatAwardReport(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('dates, which a spreadsheet writes several ways', () => {
  it('accepts ISO and US order, at UTC midnight', () => {
    expect(parseImportDate('2025-03-14')).toBe('2025-03-14T00:00:00.000Z');
    expect(parseImportDate('3/14/2025')).toBe('2025-03-14T00:00:00.000Z');
    // Midnight UTC, not Central: these are dates, and a timezone-shifted
    // midnight makes every one of them a day out somewhere.
    expect(parseImportDate('2025-03-14')).toMatch(/T00:00:00\.000Z$/);
  });

  it('refuses a date that does not exist rather than rolling it forward', () => {
    // new Date(2025, 1, 31) is 3 March. Accepting that would put a plausible
    // wrong date on a financial record.
    expect(parseImportDate('2025-02-31')).toBeNull();
    expect(parseImportDate('2025-13-01')).toBeNull();
    expect(parseImportDate('2025-00-10')).toBeNull();
  });

  it('refuses anything it cannot read, rather than guessing', () => {
    for (const bad of ['14 March 2025', '2025/03/14', 'March 14', '14-03-2025', 'yesterday']) {
      expect(parseImportDate(bad), bad).toBeNull();
    }
  });

  it('treats a blank optional date as absent, and a broken one as a problem', () => {
    expect(parseAwardsCsv(csv(withCol('w9_received_date', ''))).ok).toBe(true);
    const broken = parseAwardsCsv(csv(withCol('w9_received_date', '31/31/2025')));
    expect(broken.ok).toBe(false);
    expect(broken.issues[0]!.column).toBe('w9_received_date');
  });
});

// ---------------------------------------------------------------------------
describe('what it refuses, and how it says so', () => {
  const problems = (row: string) => parseAwardsCsv(csv(row)).issues;

  it('names the row and the column, because the person is looking at a spreadsheet', () => {
    const issues = problems(withCol('ein', '12345'));
    expect(issues[0]!.rowNumber, 'row 2 is the first data row').toBe(2);
    expect(issues[0]!.column).toBe('ein');
    expect(issues[0]!.message).toMatch(/nine-digit/);
  });

  it('says what a missing contact email actually costs', () => {
    // Not "this field is required". Without it that grantee cannot sign in at
    // all -- there is no password and no other route in.
    expect(problems(withCol('grantee_contact_email', ''))[0]!.message)
      .toMatch(/cannot sign in to report/);
  });

  it('catches a duplicate reference inside one file', () => {
    // The unique index catches a second RUN. It cannot see two identical rows
    // in one spreadsheet, which is a data-entry error worth naming.
    const r = parseAwardsCsv(csv(ROW, ROW));
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/already used on row 2/);
  });

  it('catches a term that ends before it starts', () => {
    const r = parseAwardsCsv(csv(withCol('term_end', '2024-01-01')));
    expect(r.issues.some((i) => i.column === 'term_end')).toBe(true);
  });

  it('catches an award that is its own parent', () => {
    const r = parseAwardsCsv(csv(withCol('parent_external_reference', 'IC-2025-001')));
    expect(r.issues[0]!.message).toMatch(/its own parent/);
  });

  it('accepts a parent listed LATER in the file', () => {
    // A spreadsheet sorted by anything but date routinely puts year two first.
    const yearTwo = withCol('parent_external_reference', 'IC-2025-001',
      withCol('external_reference', 'IC-2026-014'));
    const r = parseAwardsCsv(csv(yearTwo, ROW));
    expect(r.ok, formatAwardReport(r)).toBe(true);
  });

  it('accepts a parent that is not in the file at all', () => {
    // It may already be imported. That is a foreign key's question, not this
    // file's, and guessing here would refuse a legitimate second-year row.
    const r = parseAwardsCsv(csv(withCol('parent_external_reference', 'IC-2019-THINGS')));
    expect(r.ok).toBe(true);
  });

  it('refuses zero and negative amounts', () => {
    for (const bad of ['0', '$0.00', '-5000']) {
      expect(parseAwardsCsv(csv(withCol('awarded_amount', bad))).ok, bad).toBe(false);
    }
  });

  it('reports EVERY problem, not the first', () => {
    // Somebody fixing a spreadsheet wants the whole list, not ten round trips.
    const bad = withCol('ein', 'nope', withCol('awarded_date', 'someday',
      withCol('grantee_contact_email', '')));
    const issues = problems(bad);
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(new Set(issues.map((i) => i.column))).toEqual(
      new Set(['ein', 'awarded_date', 'grantee_contact_email']),
    );
  });

  it('reports a missing column once, not once per row', () => {
    const header = HEADER.split(',').filter((c) => c !== 'ein').join(',');
    const row = ROW.split(',').filter((_, i) => i !== HEADER.split(',').indexOf('ein')).join(',');
    const r = parseAwardsCsv([header, row, row, row].join('\n'));
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.message).toMatch(/missing a required column: ein/);
    expect(r.awards).toHaveLength(0);
  });

  it('imports nothing when anything is wrong', () => {
    // A half-applied import of financial records is worse than none.
    const r = parseAwardsCsv(csv(ROW, withCol('ein', 'bad')));
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the report a human reads before running it for real', () => {
  it('totals the money and counts the organizations', () => {
    const out = formatAwardReport(parseAwardsCsv(TEMPLATE));
    expect(out).toMatch(/Awards read: 4/);
    expect(out).toMatch(/Total awarded: \$194,999\.99/);
    // Three EINs across four awards: one organization holds two years.
    expect(out).toMatch(/Distinct organizations \(by EIN\): 3/);
    expect(out).toMatch(/No problems found/);
  });

  it('warns when term dates are missing, because report dates come from them', () => {
    const out = formatAwardReport(parseAwardsCsv(csv(withCol('term_start', ''))));
    expect(out).toMatch(/no term dates.*by hand/s);
  });

  it('leads with the problems when there are any', () => {
    const out = formatAwardReport(parseAwardsCsv(csv(withCol('ein', 'x'))));
    expect(out).toMatch(/nothing will be imported until these are fixed/);
    expect(out).toMatch(/row 2 \(ein\)/);
  });
});
