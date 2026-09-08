/**
 * Money.
 *
 * ALL money in this system is integer cents. No floats, no strings, no
 * exceptions. Parsing happens once, on the way in, using STRING arithmetic —
 * never `parseFloat(x) * 100`, which turns 25000.07 into 2500006.9999999995.
 *
 * Formatting happens once, at the display edge.
 */

/** Largest amount we will accept: $100,000,000.00. A typo, not a grant. */
export const MAX_CENTS = 10_000_000_000;

export class MoneyParseError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'MoneyParseError';
    this.reason = reason;
  }
}

/**
 * Parse human currency input into integer cents.
 *
 * Accepts: "25000", "25,000", "$25,000", "$25,000.00", "25000.5", " 25000 ".
 * Rejects: negatives, more than two decimal places, non-numeric text, and
 * anything above MAX_CENTS.
 *
 * A JS number input is accepted only when it is a safe integer count of DOLLARS
 * with no fractional part; a float dollar amount must arrive as a string,
 * because by the time it is a float the precision is already gone.
 */
export function parseCurrencyToCents(input: unknown): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new MoneyParseError('not_finite', 'Enter a dollar amount.');
    }
    if (!Number.isInteger(input)) {
      throw new MoneyParseError(
        'float_input',
        'Enter the amount as text, for example 25000.50.',
      );
    }
    return assertInRange(input * 100);
  }

  if (typeof input !== 'string') {
    throw new MoneyParseError('wrong_type', 'Enter a dollar amount.');
  }

  const raw = input.trim();
  if (raw === '') throw new MoneyParseError('empty', 'Enter a dollar amount.');

  // Strip a single leading currency symbol and thousands separators.
  const cleaned = raw.replace(/^\$/, '').replace(/,/g, '').trim();

  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    if (/^-/.test(cleaned)) {
      throw new MoneyParseError('negative', 'Enter an amount of zero or more.');
    }
    if (/^\d+\.\d{3,}$/.test(cleaned)) {
      throw new MoneyParseError(
        'too_many_decimals',
        'Enter an amount with at most two decimal places, for example 25000.50.',
      );
    }
    throw new MoneyParseError(
      'not_numeric',
      'Enter a dollar amount using numbers only, for example 25000.',
    );
  }

  const [dollarsPart, fractionPart = ''] = cleaned.split('.');
  const cents = fractionPart.padEnd(2, '0');
  const combined = `${dollarsPart}${cents}`.replace(/^0+(?=\d)/, '');

  const value = Number(combined);
  if (!Number.isSafeInteger(value)) {
    throw new MoneyParseError('too_large', 'That amount is too large.');
  }
  return assertInRange(value);
}

function assertInRange(cents: number): number {
  if (cents < 0) throw new MoneyParseError('negative', 'Enter an amount of zero or more.');
  if (cents > MAX_CENTS) throw new MoneyParseError('too_large', 'That amount is too large.');
  return cents;
}

/**
 * Runtime guard for anything claiming to be cents. Used at every boundary where
 * a value is about to be written to a *_cents column.
 */
export function assertCents(value: unknown, label = 'amount'): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyParseError('not_integer_cents', `${label} must be integer cents`);
  }
  if (value < 0 || value > MAX_CENTS) {
    throw new MoneyParseError('out_of_range', `${label} is out of range`);
  }
}

/** Display formatting. The ONLY place cents become a human-readable string. */
export function formatCents(cents: number, opts: { withCents?: boolean } = {}): string {
  assertCents(cents);
  const showCents = opts.withCents ?? cents % 100 !== 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(cents / 100);
}

/** Sum cents safely. Used for budget rollups and payment schedules. */
export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
  }
  if (!Number.isSafeInteger(total)) {
    throw new MoneyParseError('overflow', 'Total exceeds the supported range');
  }
  return total;
}
