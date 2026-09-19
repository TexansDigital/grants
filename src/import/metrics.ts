/**
 * Parsing a file of impact metrics.
 *
 * Same contract as awards.ts, for the same reasons: CSV text in, rows and
 * problems out, no database, whole file or none of it. The parsing rules are
 * where almost every mistake lives, and a pure function can be argued with
 * against fifty malformed rows in a second.
 *
 * WHAT A METRIC IS, restated because it is what these rules protect. A metric
 * definition is what a program asks its grantees to count, and its `metric_key`
 * is the identity that ties this year's answer to last year's. Get the key
 * wrong and the aggregation splits in two, silently, and the first anyone knows
 * is a board report with half the numbers.
 *
 * So the key is the one field with no tolerance at all: lower-case, digits and
 * underscores, and it must be the same string next year. A label can be
 * reworded whenever; a key cannot.
 */

import { parseDelimited, sniffDelimiter, toRecord, CsvError } from '../lib/csv';

export const REQUIRED_COLUMNS = ['metric_key', 'label', 'metric_type'] as const;

export const OPTIONAL_COLUMNS = [
  'help_text',
  'unit',
  'is_required',
  'sort_order',
  /**
   * The one metric whose answer is promoted onto report_submissions. Optional
   * and usually absent: not every funder asks a grantee to account for spend on
   * the report itself.
   */
  'promotes_to',
] as const;

export const METRIC_TYPES = ['integer', 'currency', 'decimal', 'text'] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

/** A key must survive being the same string next year. */
const METRIC_KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;

export interface ParsedMetric {
  metricKey: string;
  label: string;
  helpText: string | null;
  metricType: MetricType;
  unit: string | null;
  isRequired: boolean;
  sortOrder: number;
  promotesTo: 'funds_spent_cents' | null;
  /** 1-based line in the file, so a message names the row a human can see. */
  rowNumber: number;
}

export interface MetricIssue {
  rowNumber: number;
  column: string | null;
  message: string;
}

export interface MetricParseResult {
  metrics: ParsedMetric[];
  issues: MetricIssue[];
  /** Headers present in the file that this importer ignores. */
  unknownColumns: string[];
  ok: boolean;
}

const key = (header: string): string => header.trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Read a yes/no column the way a spreadsheet actually contains one.
 *
 * Returns null when the value is not recognisable, so the caller can say so
 * rather than defaulting a required metric to optional.
 */
export function parseYesNo(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  if (['yes', 'y', 'true', '1', 'required'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'optional'].includes(s)) return false;
  return null;
}

export function parseMetricsCsv(input: string): MetricParseResult {
  const issues: MetricIssue[] = [];
  const metrics: ParsedMetric[] = [];

  let table;
  try {
    table = parseDelimited(input, sniffDelimiter(input));
  } catch (err) {
    const e = err as CsvError;
    return {
      metrics: [],
      issues: [{ rowNumber: e.line || 1, column: null, message: e.message }],
      unknownColumns: [],
      ok: false,
    };
  }

  const headerKeys = table.header.map(key);
  const known = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
  const unknownColumns = table.header.filter((h) => !known.has(key(h)));

  const missing = REQUIRED_COLUMNS.filter((c) => !headerKeys.includes(c));
  if (missing.length > 0) {
    // No point reporting forty row errors when the header is wrong.
    return {
      metrics: [],
      issues: missing.map((c) => ({
        rowNumber: 1,
        column: c,
        message: `The file is missing a required column: ${c}`,
      })),
      unknownColumns,
      ok: false,
    };
  }

  const seenKeys = new Map<string, number>();
  const seenOrders = new Map<number, number>();
  let claimedFundsSpent: number | null = null;

  table.rows.forEach((row, i) => {
    // Row 1 is the header, so the first metric is row 2 -- which is what the
    // person looking at their spreadsheet sees.
    const rowNumber = i + 2;
    const add = (column: string | null, message: string) =>
      issues.push({ rowNumber, column, message });

    let record: Record<string, string>;
    try {
      record = toRecord(headerKeys, row, rowNumber);
    } catch (err) {
      add(null, err instanceof Error ? err.message : String(err));
      return;
    }
    const get = (c: string) => (record[c] ?? '').trim();

    // A wholly blank line at the end of a hand-edited file is not an error.
    if (Object.values(record).every((v) => v.trim() === '')) return;

    const metricKey = get('metric_key').toLowerCase();
    if (!metricKey) {
      add('metric_key', 'Every metric needs a key.');
    } else if (!METRIC_KEY_RE.test(metricKey)) {
      add(
        'metric_key',
        `"${get('metric_key')}" is not usable as a key. Use lower-case letters, ` +
          'digits and underscores, starting with a letter — for example individuals_served.',
      );
    } else if (seenKeys.has(metricKey)) {
      add('metric_key', `Key "${metricKey}" is already used on row ${seenKeys.get(metricKey)}.`);
    } else {
      seenKeys.set(metricKey, rowNumber);
    }

    const label = get('label');
    if (!label) {
      add('label', 'A metric needs a question a grantee can answer.');
    } else if (label.length > 300) {
      add('label', `This question is ${label.length} characters. Keep it under 300.`);
    }

    const rawType = get('metric_type').toLowerCase();
    if (!(METRIC_TYPES as readonly string[]).includes(rawType)) {
      add(
        'metric_type',
        `"${get('metric_type')}" is not a metric type. Use one of: ${METRIC_TYPES.join(', ')}.`,
      );
    }
    const metricType = rawType as MetricType;

    let isRequired = false;
    if (headerKeys.includes('is_required')) {
      const parsed = parseYesNo(get('is_required'));
      if (parsed === null && get('is_required') !== '') {
        add('is_required', `"${get('is_required')}" is not yes or no.`);
      }
      isRequired = parsed ?? false;
    }

    // Default to the file's own order, spaced so an admin can insert a metric
    // between two without renumbering the sheet.
    let sortOrder = (i + 1) * 10;
    const rawOrder = get('sort_order');
    if (rawOrder !== '') {
      if (!/^\d{1,6}$/.test(rawOrder)) {
        add('sort_order', `"${rawOrder}" is not a whole number.`);
      } else {
        sortOrder = Number(rawOrder);
        const clash = seenOrders.get(sortOrder);
        if (clash !== undefined) {
          // Not an error: the order is broken deterministically by key. Said
          // out loud so nobody is surprised by where the question landed.
          add(
            'sort_order',
            `Order ${sortOrder} is also used on row ${clash}. These two will be ` +
              'asked in alphabetical order of their keys.',
          );
        } else {
          seenOrders.set(sortOrder, rowNumber);
        }
      }
    }

    let promotesTo: 'funds_spent_cents' | null = null;
    const rawPromotes = get('promotes_to').toLowerCase();
    if (rawPromotes !== '') {
      if (rawPromotes !== 'funds_spent_cents') {
        add(
          'promotes_to',
          `"${get('promotes_to')}" is not a promotion target. The only one is funds_spent_cents.`,
        );
      } else if (metricType !== 'currency') {
        // The schema refuses this too. Saying it here names the row.
        add(
          'promotes_to',
          'Only a currency metric can be the funds-spent figure. ' +
            `This one is a ${rawType || 'blank'} metric.`,
        );
      } else if (claimedFundsSpent !== null) {
        add(
          'promotes_to',
          `Row ${claimedFundsSpent} already claims funds_spent_cents. Only one metric can.`,
        );
      } else {
        claimedFundsSpent = rowNumber;
        promotesTo = 'funds_spent_cents';
      }
    }

    metrics.push({
      metricKey,
      label,
      helpText: get('help_text') || null,
      metricType,
      unit: get('unit') || null,
      isRequired,
      sortOrder,
      promotesTo,
      rowNumber,
    });
  });

  if (metrics.length === 0 && issues.length === 0) {
    issues.push({ rowNumber: 1, column: null, message: 'The file has a header and no metrics.' });
  }

  return { metrics, issues, unknownColumns, ok: issues.length === 0 };
}

/** The parse result as something an admin can read in a terminal. */
export function formatMetricReport(result: MetricParseResult): string {
  const lines: string[] = [];
  lines.push(`${result.metrics.length} metric(s) read.`);
  if (result.unknownColumns.length > 0) {
    lines.push(`Ignored columns: ${result.unknownColumns.join(', ')}`);
  }
  for (const m of result.metrics) {
    const bits: string[] = [m.metricType];
    if (m.unit) bits.push(m.unit);
    if (m.isRequired) bits.push('required');
    if (m.promotesTo) bits.push('funds spent');
    lines.push(`  ${String(m.sortOrder).padStart(4)}  ${m.metricKey} (${bits.join(', ')})`);
  }
  if (result.issues.length > 0) {
    lines.push('', `${result.issues.length} problem(s):`);
    for (const p of result.issues) {
      lines.push(`  row ${p.rowNumber}${p.column ? ` (${p.column})` : ''}: ${p.message}`);
    }
    lines.push('', 'Nothing was imported. Fix the file and run it again.');
  }
  return lines.join('\n');
}
