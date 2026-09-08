import { describe, it, expect } from 'vitest';
import { parseCurrencyToCents, formatCents, assertCents, sumCents, MoneyParseError } from '../src/lib/money';

describe('money is integer cents, end to end', () => {
  it('parses the shapes applicants actually type', () => {
    expect(parseCurrencyToCents('25000')).toBe(2_500_000);
    expect(parseCurrencyToCents('25,000')).toBe(2_500_000);
    expect(parseCurrencyToCents('$25,000')).toBe(2_500_000);
    expect(parseCurrencyToCents('$25,000.00')).toBe(2_500_000);
    expect(parseCurrencyToCents(' 25000 ')).toBe(2_500_000);
    expect(parseCurrencyToCents('25000.5')).toBe(2_500_050);
    expect(parseCurrencyToCents('0')).toBe(0);
    expect(parseCurrencyToCents('0.01')).toBe(1);
  });

  it('does not lose precision the way float multiplication does', () => {
    // The canonical failure: 25000.07 * 100 === 2500006.9999999995
    expect(parseCurrencyToCents('25000.07')).toBe(2_500_007);
    expect(parseCurrencyToCents('1.10')).toBe(110);
    expect(parseCurrencyToCents('19.99')).toBe(1999);
    expect(parseCurrencyToCents('0.29')).toBe(29);
    // Exhaustive sweep over the cent values most prone to float error.
    for (let c = 0; c < 100; c++) {
      const s = `1.${String(c).padStart(2, '0')}`;
      expect(parseCurrencyToCents(s)).toBe(100 + c);
    }
  });

  it('rejects what must never become an amount', () => {
    expect(() => parseCurrencyToCents('')).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents('abc')).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents('-5')).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents('25000.123')).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents('1e5')).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents(NaN)).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents(Infinity)).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents(null)).toThrow(MoneyParseError);
    expect(() => parseCurrencyToCents({})).toThrow(MoneyParseError);
  });

  it('refuses a float number input rather than silently rounding it', () => {
    // 25000.5 as a NUMBER has already lost the guarantee. Make the caller send
    // a string instead of guessing what they meant.
    expect(() => parseCurrencyToCents(25000.5)).toThrow(/as text/);
  });

  it('caps absurd amounts', () => {
    expect(() => parseCurrencyToCents('999999999999')).toThrow(MoneyParseError);
  });

  it('assertCents rejects anything that is not integer cents', () => {
    expect(() => assertCents(100)).not.toThrow();
    expect(() => assertCents(0)).not.toThrow();
    expect(() => assertCents(10.5)).toThrow();
    expect(() => assertCents('100')).toThrow();
    expect(() => assertCents(-1)).toThrow();
    expect(() => assertCents(null)).toThrow();
  });

  it('formats only at the display edge', () => {
    expect(formatCents(2_500_000)).toBe('$25,000');
    expect(formatCents(2_500_050)).toBe('$25,000.50');
    expect(formatCents(0)).toBe('$0');
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(2_500_000, { withCents: true })).toBe('$25,000.00');
  });

  it('sums without drift', () => {
    expect(sumCents([1999, 1999, 1999])).toBe(5997);
    expect(sumCents([])).toBe(0);
    expect(() => sumCents([100, 1.5])).toThrow();
  });
});
