/**
 * Reading the historic Formstack export.
 *
 * DRY RUN ONLY, deliberately. This file analyses an export and reports what
 * WOULD happen. It writes nothing. The write path is separate and lands next,
 * because the first useful thing is an honest answer to "what does my real
 * data actually contain", produced without touching a database.
 *
 * WHY THE MAPPING IS BY HEADER TEXT. Formstack exports the QUESTION as the
 * column name, so the header is long English sentences rather than field keys.
 * Matching on position would break the first time somebody reorders a form;
 * matching on the question text breaks loudly and says which column it could
 * not place.
 *
 * THE EXPORT DOES NOT CONTAIN EVERYTHING THE FORM NEEDS. That is the finding
 * this file exists to surface, not to paper over:
 *
 *   * There is no project title column at all. The current form requires one.
 *   * "If your area of focus is not listed above" is a question the current
 *     form no longer asks -- the five focus areas have no Other.
 *   * The two upload columns are Formstack-hosted URLs. Files are not fetched:
 *     this system does not reach out to a third party for an applicant's
 *     audited financial statements, and those URLs stop working when the
 *     Formstack account lapses.
 *   * There is no separate count for individuals benefiting; the export has
 *     only the narrative.
 *
 * Every one of those is reported per row rather than guessed at.
 */

import { parseDelimited, sniffDelimiter, toRecord, CsvError } from '../lib/csv';
import { normalizeEin } from '../lib/ein';
import { parseCurrencyToCents, MoneyParseError } from '../lib/money';

/** How a Formstack column maps onto the current form. */
export interface ColumnMapping {
  /** Exact header text, as Formstack writes it. */
  header: string;
  /** Field key on the current form, or a synthetic target below. */
  target: string;
  kind: 'answer' | 'address_part' | 'metadata' | 'file' | 'retired';
  /** For address_part: which sub-field. */
  part?: string;
}

/**
 * The Inspire Change export, as of the 2026 form.
 *
 * Header text is matched after normalizing whitespace and case, so a stray
 * double space or a capitalisation change does not break an import.
 */
export const INSPIRE_CHANGE_COLUMNS: ColumnMapping[] = [
  { header: 'Time', target: 'submitted_at', kind: 'metadata' },
  { header: 'My organization is either a 501(c)(3) nonprofit organization, registered', target: 'entity_type_confirmation', kind: 'answer' },
  { header: 'I have read through the Inspire Change Grant Guidelines and Criteria and', target: 'guidelines_attestation', kind: 'answer' },
  { header: 'Salutation', target: 'salutation', kind: 'answer' },
  { header: 'Name (First)', target: 'contact_first_name', kind: 'answer' },
  { header: 'Name (Last)', target: 'contact_last_name', kind: 'answer' },
  { header: 'Email Address', target: 'contact_email', kind: 'answer' },
  { header: 'Best Phone Number', target: 'contact_phone', kind: 'answer' },
  { header: 'Job Title', target: 'contact_job_title', kind: 'answer' },
  { header: 'I am authorized to complete and submit this application on behalf of my', target: 'authorization_attestation', kind: 'answer' },
  { header: 'Organization Name', target: 'organization_name', kind: 'answer' },
  { header: 'EIN', target: 'ein', kind: 'answer' },
  { header: 'Website', target: 'organization_website', kind: 'answer' },
  { header: 'Address (Address)', target: 'organization_address', kind: 'address_part', part: 'address_1' },
  { header: 'Address (Address2)', target: 'organization_address', kind: 'address_part', part: 'address_2' },
  { header: 'Address (City)', target: 'organization_address', kind: 'address_part', part: 'city' },
  { header: 'Address (State)', target: 'organization_address', kind: 'address_part', part: 'state' },
  { header: 'Address (Zip)', target: 'organization_address', kind: 'address_part', part: 'postal_code' },
  { header: 'Address (Country)', target: 'organization_address', kind: 'address_part', part: 'country' },
  { header: "Organizational Mission Statement", target: 'mission_statement', kind: 'answer' },
  { header: "Organization's Annual Operating Budget", target: 'annual_operating_budget', kind: 'answer' },
  { header: 'Grant Request Amount', target: 'requested_amount', kind: 'answer' },
  { header: 'What type of funding is being requested?', target: 'funding_type', kind: 'answer' },
  { header: 'Your Area of Focus:', target: 'area_of_focus', kind: 'answer' },
  { header: "If your area of focus is not listed above, please check 'Other' below an", target: 'area_of_focus_other', kind: 'retired' },
  { header: 'Which of the counties in the Greater Houston area will be served by your', target: 'counties_served', kind: 'answer' },
  { header: 'Describe how your organization advances opportunities for underserved co', target: 'advancing_opportunity', kind: 'answer' },
  { header: 'Provide a summary of the project, program, or initiative for which funds', target: 'project_summary', kind: 'answer' },
  { header: 'Please describe the critical need in your community that this grant woul', target: 'community_need', kind: 'answer' },
  { header: 'Provide a proposed timeline for implementing your project and using gran', target: 'implementation_timeline', kind: 'answer' },
  { header: 'What is the estimated number of individuals who will benefit from this f', target: 'individuals_benefiting', kind: 'answer' },
  { header: "Describe how your organization's leadership, staff, executives, and boar", target: 'leadership_lived_experience', kind: 'answer' },
  { header: 'If awarded less than your requested amount, how would you adjust your pr', target: 'partial_funding_plan', kind: 'answer' },
  { header: 'Describe any potential opportunities for the Texans organization to volu', target: 'volunteer_engagement', kind: 'answer' },
  { header: 'Please provide an itemized spending budget of how the grant funds will b', target: 'itemized_budget', kind: 'answer' },
  { header: 'Most recent financial statements (audited, if available)', target: 'financial_statements', kind: 'file' },
  { header: 'Please upload your current year operating budget', target: 'operating_budget_doc', kind: 'file' },
  { header: 'I would like to receive information on the latest in Texans community in', target: 'marketing_opt_in', kind: 'answer' },
  { header: 'Browser', target: 'submission_user_agent', kind: 'metadata' },
  { header: 'IP Address', target: 'submission_ip', kind: 'metadata' },
  { header: 'Unique ID', target: 'external_ref', kind: 'metadata' },
  { header: 'Location', target: 'location', kind: 'metadata' },
];

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Header text is matched by PREFIX.
 *
 * Formstack question text is long and gets edited -- a clarifying clause added
 * to the end of a question should not orphan a column. The first 60 normalized
 * characters are enough to identify a question and stable enough to survive
 * ordinary rewording.
 */
const KEY_LENGTH = 60;
const headerKey = (s: string): string => norm(s).slice(0, KEY_LENGTH);

export interface RowIssue {
  severity: 'blocking' | 'warning';
  code: string;
  detail: string;
}

export interface AnalyzedRow {
  rowNumber: number;
  externalRef: string | null;
  organizationName: string | null;
  ein: string | null;
  email: string | null;
  requestedAmountCents: number | null;
  submittedAt: string | null;
  answers: Record<string, unknown>;
  /** Formstack-hosted file URLs, preserved for a human rather than fetched. */
  files: { field: string; value: string }[];
  issues: RowIssue[];
}

export interface AnalysisReport {
  delimiter: string;
  totalRows: number;
  /** Columns in the file that no mapping claims. */
  unmappedColumns: string[];
  /** Mappings whose column is absent from the file. */
  missingColumns: string[];
  rows: AnalyzedRow[];
  importable: number;
  blocked: number;
  /** Counts by issue code, so a 300-row report can be read at a glance. */
  issueSummary: { code: string; severity: string; count: number }[];
}

export function analyzeExport(
  text: string,
  opts: { mapping?: ColumnMapping[]; delimiter?: string } = {},
): AnalysisReport {
  const mapping = opts.mapping ?? INSPIRE_CHANGE_COLUMNS;
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const table = parseDelimited(text, delimiter);

  const byKey = new Map(mapping.map((m) => [headerKey(m.header), m]));
  const seen = new Set<string>();
  const unmappedColumns: string[] = [];
  for (const h of table.header) {
    const m = byKey.get(headerKey(h));
    if (m) seen.add(headerKey(m.header));
    else if (h) unmappedColumns.push(h);
  }
  const missingColumns = mapping.filter((m) => !seen.has(headerKey(m.header))).map((m) => m.header);

  const rows: AnalyzedRow[] = [];
  for (const [index, raw] of table.rows.entries()) {
    const rowNumber = index + 2; // 1-based, and the header is line 1.
    const issues: RowIssue[] = [];
    let record: Record<string, string>;
    try {
      record = toRecord(table.header, raw, rowNumber);
    } catch (err) {
      rows.push({
        rowNumber, externalRef: null, organizationName: null, ein: null, email: null,
        requestedAmountCents: null, submittedAt: null, answers: {}, files: [],
        issues: [{
          severity: 'blocking', code: 'malformed_row',
          detail: err instanceof CsvError ? err.message : String(err),
        }],
      });
      continue;
    }

    const answers: Record<string, unknown> = {};
    const address: Record<string, string> = {};
    const files: { field: string; value: string }[] = [];
    const meta: Record<string, string> = {};

    for (const h of table.header) {
      const m = byKey.get(headerKey(h));
      if (!m) continue;
      const value = record[h] ?? '';

      if (m.kind === 'metadata') {
        meta[m.target] = value;
      } else if (m.kind === 'address_part') {
        if (value) address[m.part!] = value;
      } else if (m.kind === 'file') {
        if (value) files.push({ field: m.target, value });
      } else if (m.kind === 'retired') {
        if (value) {
          issues.push({
            severity: 'warning',
            code: 'retired_question_answered',
            detail: `"${m.target}" was answered ("${value.slice(0, 60)}") but the current form no longer asks it. The answer will not be imported.`,
          });
        }
      } else if (value) {
        answers[m.target] = value;
      }
    }
    if (Object.keys(address).length > 0) answers.organization_address = address;

    // --- the things the export simply does not contain -----------------------
    if (!answers.project_title) {
      issues.push({
        severity: 'blocking',
        code: 'no_project_title',
        detail:
          'The export has no project title column, and the current form requires one. A title must be supplied before this row can be imported.',
      });
    }
    if (files.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'files_not_imported',
        detail:
          `${files.length} uploaded file(s) are Formstack-hosted URLs. They are recorded for a human to retrieve, not fetched: this system does not reach a third party for an applicant's financial statements, and those URLs stop working when the account lapses.`,
      });
    }

    const ein = normalizeEin(answers.ein);
    if (answers.ein && !ein) {
      issues.push({
        severity: 'blocking',
        code: 'bad_ein',
        detail: `"${String(answers.ein).slice(0, 40)}" does not contain nine digits.`,
      });
    }
    if (!answers.ein) {
      issues.push({ severity: 'blocking', code: 'no_ein', detail: 'No EIN, so no organization can be resolved.' });
    }

    const email = typeof answers.contact_email === 'string' ? answers.contact_email.toLowerCase() : null;
    if (!email) {
      issues.push({ severity: 'blocking', code: 'no_email', detail: 'No contact email.' });
    }

    let requestedAmountCents: number | null = null;
    if (typeof answers.requested_amount === 'string') {
      let parsed: number | null = null;
      try {
        parsed = parseCurrencyToCents(answers.requested_amount);
      } catch (err) {
        issues.push({
          severity: 'blocking',
          code: 'bad_amount',
          detail: `"${answers.requested_amount}" is not a readable amount${
            err instanceof MoneyParseError ? `: ${err.message}` : ''
          }.`,
        });
      }
      if (parsed !== null) {
        requestedAmountCents = parsed;
        // Historic rows predate the published range and are imported as they
        // were. Flagged, not rejected: rewriting history to fit today's rules
        // would make the archive lie.
        if (parsed < 1_000_000 || parsed > 5_000_000) {
          issues.push({
            severity: 'warning',
            code: 'amount_outside_current_range',
            detail: `$${(parsed / 100).toLocaleString('en-US')} is outside the current $10,000-$50,000 range. Imported as recorded.`,
          });
        }
      }
    }

    if (!meta.external_ref) {
      issues.push({
        severity: 'warning',
        code: 'no_unique_id',
        detail:
          'No Unique ID, so a re-run cannot tell this row from a new one. Importing twice would create two applications.',
      });
    }

    rows.push({
      rowNumber,
      externalRef: meta.external_ref || null,
      organizationName: typeof answers.organization_name === 'string' ? answers.organization_name : null,
      ein,
      email,
      requestedAmountCents,
      submittedAt: meta.submitted_at || null,
      answers,
      files,
      issues,
    });
  }

  const counts = new Map<string, { severity: string; count: number }>();
  for (const r of rows) {
    for (const i of r.issues) {
      const e = counts.get(i.code) ?? { severity: i.severity, count: 0 };
      e.count++;
      counts.set(i.code, e);
    }
  }

  const blocked = rows.filter((r) => r.issues.some((i) => i.severity === 'blocking')).length;
  return {
    delimiter,
    totalRows: rows.length,
    unmappedColumns,
    missingColumns,
    rows,
    importable: rows.length - blocked,
    blocked,
    issueSummary: [...counts]
      .map(([code, v]) => ({ code, severity: v.severity, count: v.count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** A human-readable summary, for someone running this against real data. */
export function formatReport(report: AnalysisReport): string {
  const lines: string[] = [];
  lines.push(`Parsed ${report.totalRows} rows (${report.delimiter === '\t' ? 'tab' : 'comma'}-separated).`);
  lines.push(`  importable: ${report.importable}`);
  lines.push(`  blocked:    ${report.blocked}`);
  if (report.unmappedColumns.length) {
    lines.push('', 'Columns in the file that nothing maps (ignored):');
    for (const c of report.unmappedColumns) lines.push(`  - ${c.slice(0, 90)}`);
  }
  if (report.missingColumns.length) {
    lines.push('', 'Columns the mapping expects but the file does not have:');
    for (const c of report.missingColumns) lines.push(`  - ${c.slice(0, 90)}`);
  }
  if (report.issueSummary.length) {
    lines.push('', 'Issues:');
    for (const i of report.issueSummary) {
      lines.push(`  ${String(i.count).padStart(4)}  [${i.severity}] ${i.code}`);
    }
  }
  return lines.join('\n');
}
