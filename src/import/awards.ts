/**
 * Parsing a file of past awards.
 *
 * WHAT THIS FILE IS AND IS NOT. It turns CSV text into award rows and a list of
 * problems. It touches no database. That separation is deliberate: the parsing
 * rules are where almost all the mistakes live, and a pure function can be
 * tested against fifty malformed rows in a second, which a function that also
 * writes cannot.
 *
 * THE WHOLE FILE OR NONE OF IT. If any row is unusable the import does not
 * proceed. A half-applied import of financial records is worse than no import:
 * somebody has to work out which half, against records they were importing
 * precisely because they were tired of reconciling by hand. So this returns
 * every problem it found, not the first one.
 *
 * IDEMPOTENCE IS NOT THIS FILE'S JOB. `external_reference` plus a unique index
 * over live rows is what stops a second run awarding anybody twice. This file
 * catches duplicates WITHIN one file, which the index cannot see, because two
 * identical references in one spreadsheet is a data-entry error worth naming
 * rather than a constraint violation to trip over.
 */

import { parseDelimited, sniffDelimiter, toRecord, CsvError } from '../lib/csv';
import { normalizeEin } from '../lib/ein';
import { parseCurrencyToCents, MoneyParseError } from '../lib/money';

/** Headers the file must carry. Matched case-insensitively, order-independent. */
export const REQUIRED_COLUMNS = [
  'external_reference',
  'organization_name',
  'ein',
  'program_slug',
  'awarded_amount',
  'awarded_date',
  'grantee_contact_name',
  'grantee_contact_email',
] as const;

export const OPTIONAL_COLUMNS = [
  'fiscal_year',
  'announcement_date',
  'term_start',
  'term_end',
  'is_multi_year',
  'parent_external_reference',
  'agreement_signed_date',
  'w9_received_date',
  'media_release_date',
  'grantee_contact_phone',
  'status',
  'notes',
] as const;

export interface ParsedAward {
  externalReference: string;
  organizationName: string;
  /** Nine digits, separators stripped. */
  ein: string;
  programSlug: string;
  fiscalYear: number | null;
  awardedAmountCents: number;
  awardedAt: string;
  announcementDate: string | null;
  termStart: string | null;
  termEnd: string | null;
  isMultiYear: boolean;
  parentExternalReference: string | null;
  agreementSignedAt: string | null;
  w9ReceivedAt: string | null;
  mediaReleaseAt: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  status: 'pending' | 'active' | 'completed' | 'cancelled';
  notes: string | null;
  /** 1-based line in the file, for a message a human can act on. */
  rowNumber: number;
}

export interface AwardIssue {
  rowNumber: number;
  column: string | null;
  message: string;
}

export interface AwardParseResult {
  awards: ParsedAward[];
  issues: AwardIssue[];
  /** Headers present in the file that this importer ignores. */
  unknownColumns: string[];
  /** True when every row parsed and nothing needs a human first. */
  ok: boolean;
}

const STATUSES = new Set(['pending', 'active', 'completed', 'cancelled']);

/** Headers are matched on lower-cased, trimmed text so casing cannot break a file. */
const key = (header: string): string => header.trim().toLowerCase().replace(/\s+/g, '_');

/**
 * A date, as a spreadsheet writes one, into an ISO instant at UTC midnight.
 *
 * ACCEPTS `YYYY-MM-DD` and `M/D/YYYY`, because Excel writes the second one on a
 * US locale and the person filling this in will not notice which they have.
 * REFUSES anything else rather than guessing: `03/04/2025` is ambiguous between
 * March and April in general, and is read as US order here only because the
 * other accepted format is unambiguous and the Foundation is in Houston. That
 * assumption is stated so it can be argued with.
 *
 * Midnight UTC rather than Central: these are dates, not instants. Nothing in
 * reporting depends on the time of day an award was made, and storing a
 * timezone-shifted midnight makes every date one day off somewhere.
 */
export function parseImportDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (us) {
    [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3])];
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February, which the Date constructor would happily roll into
  // March and which would otherwise become a plausible-looking wrong date.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString();
}

/** `yes`/`no`, `true`/`false`, `1`/`0`, or blank. Anything else is an error. */
function parseBoolean(raw: string): boolean | null | 'invalid' {
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return 'invalid';
}

export function parseAwardsCsv(input: string): AwardParseResult {
  const issues: AwardIssue[] = [];
  const awards: ParsedAward[] = [];

  let table;
  try {
    table = parseDelimited(input, sniffDelimiter(input));
  } catch (err) {
    const e = err as CsvError;
    return {
      awards: [],
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
    // No point reporting four hundred row errors when the header is wrong.
    return {
      awards: [],
      issues: missing.map((c) => ({
        rowNumber: 1,
        column: c,
        message: `The file is missing a required column: ${c}`,
      })),
      unknownColumns,
      ok: false,
    };
  }

  const seenReferences = new Map<string, number>();

  table.rows.forEach((row, i) => {
    // Row 1 is the header, so the first data row is row 2 -- which is what the
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

    const externalReference = get('external_reference');
    if (!externalReference) {
      add('external_reference', 'Every award needs a reference of its own.');
    } else if (seenReferences.has(externalReference)) {
      add(
        'external_reference',
        `Reference "${externalReference}" is already used on row ${seenReferences.get(externalReference)}.`,
      );
    } else {
      seenReferences.set(externalReference, rowNumber);
    }

    const organizationName = get('organization_name');
    if (!organizationName) add('organization_name', 'An organization name is required.');

    const ein = normalizeEin(get('ein'));
    if (!ein) {
      add('ein', `"${get('ein')}" is not a nine-digit EIN.`);
    }

    const programSlug = get('program_slug');
    if (!programSlug) add('program_slug', 'A program is required.');

    let awardedAmountCents = 0;
    try {
      awardedAmountCents = parseCurrencyToCents(get('awarded_amount'));
      if (awardedAmountCents <= 0) {
        add('awarded_amount', 'An award amount must be more than zero.');
      }
    } catch (err) {
      add('awarded_amount', err instanceof MoneyParseError ? err.message : 'Enter a dollar amount.');
    }

    const awardedAt = parseImportDate(get('awarded_date'));
    if (!awardedAt) {
      add('awarded_date', `"${get('awarded_date')}" is not a date. Use YYYY-MM-DD.`);
    }

    /** Optional dates: blank is fine, malformed is not. Silence would lose one. */
    const optionalDate = (column: string): string | null => {
      const raw = get(column);
      if (!raw) return null;
      const parsed = parseImportDate(raw);
      if (!parsed) add(column, `"${raw}" is not a date. Use YYYY-MM-DD.`);
      return parsed;
    };

    const termStart = optionalDate('term_start');
    const termEnd = optionalDate('term_end');
    if (termStart && termEnd && termEnd < termStart) {
      add('term_end', 'A term cannot end before it starts.');
    }

    const multiYear = parseBoolean(get('is_multi_year'));
    if (multiYear === 'invalid') add('is_multi_year', 'Use yes or no.');

    const contactEmail = get('grantee_contact_email').toLowerCase();
    if (!contactEmail) {
      // Said this way on purpose: the consequence is not "a field is blank".
      add('grantee_contact_email', 'Without an email address this grantee cannot sign in to report.');
    } else if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(contactEmail)) {
      add('grantee_contact_email', `"${contactEmail}" does not look like an email address.`);
    }

    const contactName = get('grantee_contact_name');
    if (!contactName) add('grantee_contact_name', 'A contact name is required.');

    const statusRaw = get('status').toLowerCase();
    if (statusRaw && !STATUSES.has(statusRaw)) {
      add('status', `"${statusRaw}" is not a status. Use pending, active, completed or cancelled.`);
    }

    const fiscalYearRaw = get('fiscal_year');
    let fiscalYear: number | null = null;
    if (fiscalYearRaw) {
      if (!/^\d{4}$/.test(fiscalYearRaw)) {
        add('fiscal_year', `"${fiscalYearRaw}" is not a four-digit year.`);
      } else {
        fiscalYear = Number(fiscalYearRaw);
      }
    }

    awards.push({
      externalReference,
      organizationName,
      ein: ein ?? '',
      programSlug,
      fiscalYear,
      awardedAmountCents,
      awardedAt: awardedAt ?? '',
      announcementDate: optionalDate('announcement_date'),
      termStart,
      termEnd,
      isMultiYear: multiYear === true,
      parentExternalReference: get('parent_external_reference') || null,
      agreementSignedAt: optionalDate('agreement_signed_date'),
      w9ReceivedAt: optionalDate('w9_received_date'),
      mediaReleaseAt: optionalDate('media_release_date'),
      contactName,
      contactEmail,
      contactPhone: get('grantee_contact_phone') || null,
      status: (statusRaw || 'active') as ParsedAward['status'],
      notes: get('notes') || null,
      rowNumber,
    });
  });

  /*
   * Parent references, checked ACROSS rows once every row is read.
   *
   * Year two of a multi-year grant points at year one. Checking this per-row
   * would fail whenever the file lists year two first, which a spreadsheet
   * sorted by anything other than date routinely does.
   *
   * A parent that is not in this file is not an error here: it may already be
   * imported. That is the database's question, and it answers it with a
   * foreign key rather than a guess.
   */
  for (const award of awards) {
    if (award.parentExternalReference === award.externalReference) {
      issues.push({
        rowNumber: award.rowNumber,
        column: 'parent_external_reference',
        message: 'An award cannot be its own parent.',
      });
    }
  }

  return { awards, issues, unknownColumns, ok: issues.length === 0 };
}

/** A report a person reads before deciding whether to run the import for real. */
export function formatAwardReport(result: AwardParseResult): string {
  const lines: string[] = [];
  lines.push(`Awards read: ${result.awards.length}`);
  if (result.awards.length > 0) {
    const total = result.awards.reduce((n, a) => n + a.awardedAmountCents, 0);
    lines.push(`Total awarded: $${(total / 100).toLocaleString('en-US')}`);
    const orgs = new Set(result.awards.map((a) => a.ein));
    lines.push(`Distinct organizations (by EIN): ${orgs.size}`);
    const missingTerms = result.awards.filter((a) => !a.termStart || !a.termEnd).length;
    if (missingTerms > 0) {
      lines.push(
        `${missingTerms} award(s) have no term dates. Report periods for those must be entered by hand.`,
      );
    }
  }
  if (result.unknownColumns.length > 0) {
    lines.push(`Columns ignored: ${result.unknownColumns.join(', ')}`);
  }
  if (result.issues.length === 0) {
    lines.push('No problems found.');
  } else {
    lines.push('', `${result.issues.length} problem(s) — nothing will be imported until these are fixed:`);
    for (const issue of result.issues.slice(0, 100)) {
      lines.push(`  row ${issue.rowNumber}${issue.column ? ` (${issue.column})` : ''}: ${issue.message}`);
    }
    if (result.issues.length > 100) lines.push(`  … and ${result.issues.length - 100} more`);
  }
  return lines.join('\n');
}
