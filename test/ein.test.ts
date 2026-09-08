import { describe, it, expect } from 'vitest';
import { normalizeEin, formatEin, isValidEin } from '../src/lib/ein';

describe('EIN normalization', () => {
  it('collapses the ways the same nonprofit writes its EIN', () => {
    // This is the duplicate-organization problem at its root: the same EIN,
    // typed four ways across four years, must produce one stored value.
    expect(normalizeEin('76-1234567')).toBe('761234567');
    expect(normalizeEin('761234567')).toBe('761234567');
    expect(normalizeEin('76 1234567')).toBe('761234567');
    expect(normalizeEin(' 76-123-4567 ')).toBe('761234567');
  });

  it('rejects anything that is not nine digits', () => {
    expect(normalizeEin('7612345')).toBeNull();
    expect(normalizeEin('7612345678')).toBeNull();
    expect(normalizeEin('')).toBeNull();
    expect(normalizeEin(null)).toBeNull();
    expect(normalizeEin(12345)).toBeNull();
    expect(isValidEin('76-1234567')).toBe(true);
    expect(isValidEin('nope')).toBe(false);
  });

  it('formats for display without changing storage', () => {
    expect(formatEin('761234567')).toBe('76-1234567');
    expect(formatEin('76-1234567')).toBe('76-1234567');
  });
});
