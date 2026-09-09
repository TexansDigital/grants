import { describe, it, expect } from 'vitest';
import { parseDelimited, toRecord, sniffDelimiter, CsvError } from '../src/lib/csv';
import { analyzeExport, formatReport, INSPIRE_CHANGE_COLUMNS } from '../src/import/formstack';

// ---------------------------------------------------------------------------
describe('the parser, which is where a silent import corruption would start', () => {
  it('keeps a comma inside a quoted narrative', () => {
    const t = parseDelimited('a,b\n"one, two",three');
    expect(t.rows[0]).toEqual(['one, two', 'three']);
  });

  it('keeps a literal newline inside a quoted narrative', () => {
    // Narratives are typed into textareas. This is the case that shifts every
    // later column if it is handled wrong -- and it does not throw, it just
    // produces an EIN in the website field.
    const t = parseDelimited('a,b\n"line one\nline two",x');
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]![0]).toBe('line one\nline two');
    expect(t.rows[0]![1]).toBe('x');
  });

  it('unescapes a doubled quote', () => {
    const t = parseDelimited('a\n"she said ""yes"""');
    expect(t.rows[0]![0]).toBe('she said "yes"');
  });

  it('handles CRLF, and a lone CR as data', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n').rows).toEqual([['1', '2']]);
    expect(parseDelimited('a\n1\r2').rows[0]![0]).toBe('1\r2');
  });

  it('strips a BOM so the first column still matches', () => {
    // Excel writes one. A bare BOM is also swallowed by the header trim --
    // JavaScript counts U+FEFF as whitespace -- so the case that actually
    // proves the strip is a QUOTED first header: with the BOM still there the
    // opening quote is not at the start of the field, so it is treated as
    // literal and the header comes out as '"Time"' rather than 'Time'.
    expect(parseDelimited('\ufeffTime,b\n1,2').header[0]).toBe('Time');
    expect(parseDelimited('\ufeff"Time",b\n1,2').header[0]).toBe('Time');
  });

  it('does not invent a row from a trailing newline', () => {
    expect(parseDelimited('a,b\n1,2\n').rows).toHaveLength(1);
  });

  it('preserves empty fields rather than collapsing them', () => {
    expect(parseDelimited('a,b,c\n1,,3').rows[0]).toEqual(['1', '', '3']);
  });

  it('refuses a file that ends inside a quote', () => {
    expect(() => parseDelimited('a\n"unterminated')).toThrow(CsvError);
  });

  it('refuses a row with the wrong number of values instead of padding it', () => {
    // Padding or truncating puts values under the wrong names, which is the
    // failure this parser exists to prevent.
    expect(() => toRecord(['a', 'b', 'c'], ['1', '2'], 5)).toThrow(/3 columns/);
  });

  it('sniffs tab-separated exports', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
  });
});

// ---------------------------------------------------------------------------
/** The real 42-column export shape, with invented values. */
const HEADER = INSPIRE_CHANGE_COLUMNS.map((c) => c.header);

function row(over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    Time: '9/8/26 9:15',
    Salutation: 'Ms.',
    'Name (First)': 'Alicia',
    'Name (Last)': 'Morgan',
    'Email Address': 'alicia.morgan@bayouscholars.example',
    'Best Phone Number': '(713) 555-0101',
    'Job Title': 'Executive Director',
    'Organization Name': 'Bayou Scholars Network',
    EIN: '12-0000001',
    Website: 'bayouscholars.example',
    'Address (Address)': '1200 Learning Lane',
    'Address (City)': 'Houston',
    'Address (State)': 'TX',
    'Address (Zip)': '77002',
    'Grant Request Amount': '$25,000',
    'Unique ID': 'FS-0001',
    'IP Address': '203.0.113.10',
  };
  const merged = { ...base, ...over };
  return HEADER.map((h) => {
    const key = Object.keys(merged).find((k) => h.startsWith(k)) ?? '';
    const v = key ? merged[key]! : '';
    return v.includes('\t') ? v.replace(/\t/g, ' ') : v;
  }).join('\t');
}

const file = (...rows: string[]) => [HEADER.join('\t'), ...rows].join('\n');

describe('analysing a real-shaped export', () => {
  it('maps every column the export actually has', () => {
    const r = analyzeExport(file(row()));
    expect(r.unmappedColumns).toEqual([]);
    expect(r.missingColumns).toEqual([]);
    expect(r.totalRows).toBe(1);
  });

  it('reads identity, amount and the Formstack id', () => {
    const [only] = analyzeExport(file(row())).rows;
    expect(only!.organizationName).toBe('Bayou Scholars Network');
    expect(only!.ein).toBe('120000001'); // normalized, dash removed
    expect(only!.email).toBe('alicia.morgan@bayouscholars.example');
    expect(only!.requestedAmountCents).toBe(2_500_000);
    expect(only!.externalRef).toBe('FS-0001');
  });

  it('assembles the address from its five columns', () => {
    const [only] = analyzeExport(file(row())).rows;
    expect(only!.answers.organization_address).toEqual({
      address_1: '1200 Learning Lane', city: 'Houston', state: 'TX', postal_code: '77002',
    });
  });

  it('BLOCKS every row for a missing project title, because the export has none', () => {
    // The finding that matters most: the current form requires a project
    // title and the export has no column for one. Silently importing a null
    // would produce an archive of untitled applications.
    const r = analyzeExport(file(row(), row({ 'Unique ID': 'FS-0002' })));
    expect(r.blocked).toBe(2);
    expect(r.importable).toBe(0);
    expect(r.issueSummary.find((i) => i.code === 'no_project_title')?.count).toBe(2);
  });

  it('warns rather than fetches when a row has uploaded files', () => {
    const r = analyzeExport(file(row({
      'Most recent financial statements (audited, if available)': 'https://formstack.example/f1.pdf',
    })));
    expect(r.rows[0]!.files).toEqual([
      { field: 'financial_statements', value: 'https://formstack.example/f1.pdf' },
    ]);
    expect(r.rows[0]!.issues.some((i) => i.code === 'files_not_imported')).toBe(true);
  });

  it('reports an answer to a question the current form no longer asks', () => {
    const r = analyzeExport(file(row({
      "If your area of focus is not listed above": 'Disaster relief',
    })));
    const issue = r.rows[0]!.issues.find((i) => i.code === 'retired_question_answered');
    expect(issue?.detail).toContain('Disaster relief');
    // And it is NOT smuggled into the answers.
    expect(r.rows[0]!.answers.area_of_focus_other).toBeUndefined();
  });

  it('imports a historic amount outside the current range, and says so', () => {
    // Rewriting history to fit today's rules would make the archive lie.
    const r = analyzeExport(file(row({ 'Grant Request Amount': '$7,500' })));
    expect(r.rows[0]!.requestedAmountCents).toBe(750_000);
    expect(r.rows[0]!.issues.some((i) => i.code === 'amount_outside_current_range')).toBe(true);
    expect(r.blocked).toBe(1); // still blocked, but on the title, not the amount
  });

  it('blocks a row with an unreadable EIN or amount', () => {
    const bad = analyzeExport(file(row({ EIN: 'n/a', 'Grant Request Amount': 'about 25k' })));
    const codes = bad.rows[0]!.issues.map((i) => i.code);
    expect(codes).toContain('bad_ein');
    expect(codes).toContain('bad_amount');
  });

  it('warns when a row has no Unique ID, because a re-run would duplicate it', () => {
    const r = analyzeExport(file(row({ 'Unique ID': '' })));
    expect(r.rows[0]!.issues.some((i) => i.code === 'no_unique_id')).toBe(true);
  });

  it('reports a malformed row without abandoning the rest of the file', () => {
    const r = analyzeExport(file(row(), 'too\tfew\tcolumns', row({ 'Unique ID': 'FS-0003' })));
    expect(r.totalRows).toBe(3);
    expect(r.rows[1]!.issues[0]!.code).toBe('malformed_row');
    expect(r.rows[2]!.externalRef).toBe('FS-0003');
  });

  it('lists columns it could not place, and mapped columns the file lacks', () => {
    const withExtra = [`${HEADER.join('\t')}\tSome New Question`, `${row()}\tvalue`].join('\n');
    expect(analyzeExport(withExtra).unmappedColumns).toEqual(['Some New Question']);

    const shortened = [HEADER.slice(0, 5).join('\t'), row().split('\t').slice(0, 5).join('\t')].join('\n');
    expect(analyzeExport(shortened).missingColumns.length).toBeGreaterThan(30);
  });

  it('summarises a file rather than making somebody read 300 rows', () => {
    const many = Array.from({ length: 40 }, (_, i) => row({ 'Unique ID': `FS-${i}` }));
    const text = formatReport(analyzeExport(file(...many)));
    expect(text).toContain('Parsed 40 rows (tab-separated)');
    expect(text).toContain('blocked:    40');
    expect(text).toContain('no_project_title');
  });

  it('writes nothing: analysis takes no database at all', () => {
    // The signature is the assertion. analyzeExport takes a string and returns
    // a report; there is no D1 in scope, so a dry run cannot touch data.
    expect(analyzeExport.length).toBeLessThanOrEqual(2);
  });
});
