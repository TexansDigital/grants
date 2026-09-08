/**
 * Employer Identification Numbers.
 *
 * Stored NORMALIZED: exactly nine digits, no dash, no spaces. The same nonprofit
 * typing "76-1234567" one year and "761234567" the next must land on the same
 * organization row, and that only works if normalization happens on the way in.
 */

export function normalizeEin(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

export function isValidEin(input: unknown): boolean {
  return normalizeEin(input) !== null;
}

/** Display formatting: 76-1234567. */
export function formatEin(ein: string): string {
  const n = normalizeEin(ein);
  if (!n) return ein;
  return `${n.slice(0, 2)}-${n.slice(2)}`;
}

/**
 * Result of checking an EIN against IRS Business Master File / Pub 78 data.
 *
 * A mismatch is a SOFT WARNING for a human to look at, never an automatic
 * rejection. IRS files are periodic, not live, and a legitimately new or
 * recently renamed organization will lag them.
 */
export type EinCheck =
  | { status: 'match'; legalName: string }
  | { status: 'name_mismatch'; legalName: string; warning: string }
  | { status: 'not_found'; warning: string }
  | { status: 'unavailable'; warning: string };
