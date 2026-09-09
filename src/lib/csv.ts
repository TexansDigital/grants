/**
 * Delimited-text parsing, done properly.
 *
 * A Formstack export is not "split on commas". Narrative answers routinely
 * contain commas, quotation marks, and -- because they are typed into a
 * textarea -- literal newlines. A naive split silently shifts every column
 * after the first quoted comma, which does not throw: it produces an EIN in
 * the website field and an import that looks like it worked.
 *
 * RFC 4180 with the usual real-world tolerances: CRLF or LF, a UTF-8 BOM, a
 * configurable delimiter (Formstack exports tab-separated), and doubled quotes
 * inside a quoted field.
 */

export interface ParsedTable {
  header: string[];
  rows: string[][];
}

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

export function parseDelimited(input: string, delimiter = ','): ParsedTable {
  if (delimiter.length !== 1) throw new CsvError('delimiter must be one character', 0);

  // A BOM survives Excel round-trips and would otherwise become part of the
  // first header name, so the first column silently fails to match.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }

    if (c === '"' && field === '') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      started = true;
      continue;
    }
    if (c === '\r') {
      // Swallow CR only when it precedes LF; a lone CR is data.
      if (text[i + 1] === '\n') continue;
      field += c;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
      line++;
      continue;
    }
    field += c;
    started = true;
  }

  if (inQuotes) {
    throw new CsvError('file ends inside a quoted value: a quote is unclosed', line);
  }
  // A trailing newline is normal and must not produce a phantom empty row.
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) throw new CsvError('file is empty', 1);

  return { header: header.map((h) => h.trim()), rows };
}

/**
 * Pair a row with its header.
 *
 * A row with the WRONG number of fields is an error, not something to pad or
 * truncate. Both of those quietly produce a record with values under the wrong
 * names, which is the failure mode this whole file exists to prevent.
 */
export function toRecord(
  header: readonly string[],
  row: readonly string[],
  rowNumber: number,
): Record<string, string> {
  if (row.length !== header.length) {
    throw new CsvError(
      `row has ${row.length} values but the header has ${header.length} columns`,
      rowNumber,
    );
  }
  const out: Record<string, string> = {};
  header.forEach((name, i) => {
    out[name] = (row[i] ?? '').trim();
  });
  return out;
}

/** Guess the delimiter from the header line. Tab-separated exports are common. */
export function sniffDelimiter(input: string): string {
  const firstLine = input.slice(0, 20000).split(/\r?\n/)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}
