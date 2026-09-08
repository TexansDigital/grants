import { describe, it, expect } from 'vitest';
import readXlsx from 'read-excel-file/web-worker';
import { buildXlsx } from './xlsxFixture';

/**
 * Feasibility and behaviour of server-side .xlsx parsing inside workerd.
 *
 * Rubrics are uploaded as CSV or XLSX and parsed on the server. This file pins
 * the parser choice and the shape it returns, so Phase 1b builds on measured
 * behaviour rather than an assumption.
 *
 * Why not SheetJS: npm's `xlsx` is frozen at 0.18.5 and carries two HIGH
 * advisories (prototype pollution CVE-2023-30533, and a ReDoS). The fixes exist
 * only in 0.19.3+, which SheetJS publishes from their own CDN rather than npm,
 * so there is no registry upgrade path. Parsing admin-uploaded files with a
 * known-vulnerable parser is not a trade worth making for a once-a-cycle action.
 */
describe('server-side xlsx parsing', () => {
  it('parses a rubric-shaped sheet inside the Workers runtime', async () => {
    const bytes = buildXlsx([
      ['Criterion', 'Description', 'Weight', 'Max score'],
      ['Community need', 'Clear, evidenced need', 30, 5],
      ['Measurable outcomes', 'Outcomes are specific', 40, 5],
      ['Organizational capacity', 'Can deliver', 30, 5],
    ]);

    const sheets = (await readXlsx(bytes.buffer as never)) as unknown as {
      sheet: string;
      data: (string | number)[][];
    }[];

    expect(sheets).toHaveLength(1);
    const rows = sheets[0]!.data;
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual(['Criterion', 'Description', 'Weight', 'Max score']);
  });

  it('preserves numbers as numbers, so weights never arrive as strings', async () => {
    const bytes = buildXlsx([
      ['Criterion', 'Weight', 'Max score'],
      ['Community need', 30, 5],
    ]);
    const sheets = (await readXlsx(bytes.buffer as never)) as unknown as {
      data: (string | number)[][];
    }[];
    const row = sheets[0]!.data[1]!;

    // A weight arriving as the string "30" would silently break weighted
    // scoring later, so the type is asserted, not assumed.
    expect(typeof row[1]).toBe('number');
    expect(row[1]).toBe(30);
    expect(typeof row[2]).toBe('number');
  });

  it('handles XML-hostile characters in a criterion label', async () => {
    const bytes = buildXlsx([
      ['Criterion', 'Weight'],
      ['Need & "impact" <measured>', 25],
    ]);
    const sheets = (await readXlsx(bytes.buffer as never)) as unknown as {
      data: (string | number)[][];
    }[];
    expect(sheets[0]!.data[1]![0]).toBe('Need & "impact" <measured>');
  });

  it('rejects a file that is not a spreadsheet', async () => {
    const notXlsx = new TextEncoder().encode('this is not a zip archive at all');
    await expect(readXlsx(notXlsx.buffer as never)).rejects.toBeTruthy();
  });
});
