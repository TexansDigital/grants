import { describe, it, expect } from 'vitest';
import { parseMetricsCsv, parseYesNo, formatMetricReport } from '../src/import/metrics';

const HEADER = 'metric_key,label,help_text,metric_type,unit,is_required,sort_order,promotes_to';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const one = (row: string) => parseMetricsCsv(csv(row));

describe('reading a metrics file', () => {
  it('reads the template the Foundation was given', () => {
    const result = parseMetricsCsv(csv(
      'individuals_served,How many individuals did this grant serve?,"Unique individuals, not visits.",integer,people,yes,10,',
      'funds_spent,How much has been spent?,,currency,,yes,20,funds_spent_cents',
      'volunteer_hours,Volunteer hours contributed,Leave blank if you do not track this.,decimal,hours,no,30,',
      'served_basis,What does that number count?,,text,,no,40,',
    ));
    expect(result.ok).toBe(true);
    expect(result.metrics.map((m) => m.metricKey)).toEqual([
      'individuals_served', 'funds_spent', 'volunteer_hours', 'served_basis',
    ]);
    expect(result.metrics[0]).toMatchObject({
      label: 'How many individuals did this grant serve?',
      helpText: 'Unique individuals, not visits.',
      metricType: 'integer',
      unit: 'people',
      isRequired: true,
      sortOrder: 10,
      promotesTo: null,
    });
    expect(result.metrics[1]!.promotesTo).toBe('funds_spent_cents');
  });

  it('needs only a key, a question and a type', () => {
    const result = parseMetricsCsv('metric_key,label,metric_type\nmeals_served,How many meals?,integer');
    expect(result.ok).toBe(true);
    expect(result.metrics[0]).toMatchObject({
      metricKey: 'meals_served', isRequired: false, unit: null, helpText: null, sortOrder: 10,
    });
  });

  it('says which required column is missing rather than failing per row', () => {
    const result = parseMetricsCsv('metric_key,label\nmeals_served,How many meals?');
    expect(result.ok).toBe(false);
    expect(result.metrics).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('metric_type');
  });

  it('reports a column it does not understand instead of silently dropping it', () => {
    const result = parseMetricsCsv(
      'metric_key,label,metric_type,rollup_formula\nmeals,How many?,integer,SUM',
    );
    expect(result.unknownColumns).toEqual(['rollup_formula']);
    // Still usable. An extra column in somebody's working sheet is not a fault.
    expect(result.ok).toBe(true);
  });

  it('accepts a tab-separated export', () => {
    const result = parseMetricsCsv('metric_key\tlabel\tmetric_type\nmeals\tHow many?\tinteger');
    expect(result.ok).toBe(true);
    expect(result.metrics[0]!.metricKey).toBe('meals');
  });
});

describe('the key, which is the identity that survives a rewording', () => {
  it('refuses a key that will not be typable next year', () => {
    for (const bad of ['Individuals Served', 'individuals-served', '2_served', 'ind.served', '']) {
      const r = one(`${bad},How many?,,integer,,,,`);
      expect(r.ok, bad).toBe(false);
      expect(r.issues[0]!.column).toBe('metric_key');
    }
  });

  it('lower-cases a key rather than refusing it', () => {
    // A key typed in caps is a formatting slip, not a different metric.
    const r = one('INDIVIDUALS_SERVED,How many?,,integer,,,,');
    expect(r.ok).toBe(true);
    expect(r.metrics[0]!.metricKey).toBe('individuals_served');
  });

  it('catches the same key twice in one file, naming the earlier row', () => {
    const r = parseMetricsCsv(csv(
      'served,How many?,,integer,,,,',
      'served,How many again?,,integer,,,,',
    ));
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('row 2');
  });
});

describe('the rest of a row', () => {
  it('names the metric types it accepts', () => {
    const r = one('served,How many?,,number,,,,');
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('integer, currency, decimal, text');
  });

  it('refuses a question nobody can answer', () => {
    expect(one('served,,,integer,,,,').ok).toBe(false);
  });

  it('reads yes and no the several ways a spreadsheet writes them', () => {
    expect(parseYesNo('Yes')).toBe(true);
    expect(parseYesNo('TRUE')).toBe(true);
    expect(parseYesNo('1')).toBe(true);
    expect(parseYesNo('required')).toBe(true);
    expect(parseYesNo('no')).toBe(false);
    expect(parseYesNo('0')).toBe(false);
    expect(parseYesNo('optional')).toBe(false);
    expect(parseYesNo('')).toBeNull();
    expect(parseYesNo('maybe')).toBeNull();
  });

  it('refuses an unreadable required flag rather than defaulting it to optional', () => {
    // Defaulting silently turns a metric the program needs into one it asks
    // for politely, and nobody finds out until the reports come back empty.
    const r = one('served,How many?,,integer,,maybe,,');
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.column).toBe('is_required');
  });

  it('numbers the metrics in file order when no order is given', () => {
    const r = parseMetricsCsv(csv(
      'first,One?,,integer,,,,',
      'second,Two?,,integer,,,,',
      'third,Three?,,integer,,,,',
    ));
    // Spaced by ten, so a metric can be inserted between two without
    // renumbering the whole sheet.
    expect(r.metrics.map((m) => m.sortOrder)).toEqual([10, 20, 30]);
  });

  it('warns about a duplicated order rather than pretending it is fine', () => {
    const r = parseMetricsCsv(csv(
      'first,One?,,integer,,,5,',
      'second,Two?,,integer,,,5,',
    ));
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('alphabetical order');
  });

  it('refuses an order that is not a whole number', () => {
    expect(one('served,How many?,,integer,,,ten,').ok).toBe(false);
  });
});

describe('the funds-spent claim', () => {
  it('refuses a target it does not know', () => {
    const r = one('served,How many?,,currency,,,,total_awarded_cents');
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('funds_spent_cents');
  });

  it('refuses a non-currency metric claiming the money column', () => {
    // The schema refuses this too. Naming the row is the point of doing it here
    // as well: a constraint violation tells an admin nothing about which line
    // of their spreadsheet to fix.
    const r = one('spent_words,How much?,,text,,,,funds_spent_cents');
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('Only a currency metric');
  });

  it('refuses two metrics claiming it, naming the first', () => {
    const r = parseMetricsCsv(csv(
      'spent,How much?,,currency,,,10,funds_spent_cents',
      'also_spent,How much really?,,currency,,,20,funds_spent_cents',
    ));
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('Row 2');
  });

  it('is happy with no metric claiming it at all', () => {
    const r = one('served,How many?,,integer,,,,');
    expect(r.ok).toBe(true);
    expect(r.metrics[0]!.promotesTo).toBeNull();
  });
});

describe('files that are not quite files', () => {
  it('ignores a blank line left by a hand-edited sheet', () => {
    const r = parseMetricsCsv(csv('served,How many?,,integer,,,,', ',,,,,,,'));
    expect(r.ok).toBe(true);
    expect(r.metrics).toHaveLength(1);
  });

  it('says so when the file has a header and nothing else', () => {
    const r = parseMetricsCsv(HEADER);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('no metrics');
  });

  it('reports an unclosed quote as a file problem, not forty row problems', () => {
    const r = parseMetricsCsv(csv('served,"How many?,,integer,,,,'));
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.message).toContain('quote');
  });

  it('reports a row with the wrong number of values', () => {
    const r = parseMetricsCsv(csv('served,How many?,integer'));
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('3 values');
  });
});

describe('the report an admin reads', () => {
  it('lists what was read and what is wrong with it', () => {
    const r = parseMetricsCsv(csv(
      'served,How many?,,integer,people,yes,10,',
      'BAD KEY,How many?,,integer,,,20,',
    ));
    const text = formatMetricReport(r);
    expect(text).toContain('served (integer, people, required)');
    expect(text).toContain('row 3');
    expect(text).toContain('Nothing was imported');
  });

  it('does not claim anything is wrong when nothing is', () => {
    const text = formatMetricReport(one('served,How many?,,integer,,,,'));
    expect(text).not.toContain('Nothing was imported');
    expect(text).toContain('1 metric(s) read.');
  });
});
