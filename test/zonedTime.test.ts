/**
 * Wall-clock time in Central, converted to and from UTC.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. A cycle closes at "11:59:59 PM on 1
 * March, Central". If a staff member types that into a form and the browser
 * interprets it in the browser's own zone, a deadline set in Houston and the
 * same deadline set by a consultant in London are five or six hours apart, with
 * nothing on screen saying so. The applications rejected as late would be real
 * applications from real nonprofits.
 *
 * So the tests below are about the two days a year that break naive offset
 * arithmetic, and about the hours on those days that either do not exist or
 * happen twice.
 */

import { describe, it, expect } from 'vitest';
import {
  DISPLAY_ZONE,
  wallTimeToUtcIso,
  utcIsoToWallTime,
  zoneOffsetMs,
  zoneAbbreviation,
} from '../src/lib/zonedTime';

const HOUR = 3_600_000;

describe('a Central wall time becomes the right instant', () => {
  it('in winter, when Central is UTC-6', () => {
    // 1 March 2026, 11:59 PM CST -> 2 March, 05:59 UTC. This is the exact
    // closing time the Inspire Change seed uses.
    expect(wallTimeToUtcIso('2026-03-01T23:59')).toBe('2026-03-02T05:59:00.000Z');
  });

  it('in summer, when Central is UTC-5', () => {
    expect(wallTimeToUtcIso('2026-07-15T08:00')).toBe('2026-07-15T13:00:00.000Z');
  });

  it('carries seconds when they are given', () => {
    expect(wallTimeToUtcIso('2026-03-01T23:59:59')).toBe('2026-03-02T05:59:59.000Z');
  });

  it('is exact on the day the clocks go forward', () => {
    // US DST begins 8 March 2026. 01:59 CST is still -6; 03:00 CDT is -5.
    expect(wallTimeToUtcIso('2026-03-08T01:59')).toBe('2026-03-08T07:59:00.000Z');
    expect(wallTimeToUtcIso('2026-03-08T03:00')).toBe('2026-03-08T08:00:00.000Z');
  });

  it('is exact on the day the clocks go back', () => {
    // US DST ends 1 November 2026. 00:59 CDT is -5; 02:00 CST is -6.
    expect(wallTimeToUtcIso('2026-11-01T00:59')).toBe('2026-11-01T05:59:00.000Z');
    expect(wallTimeToUtcIso('2026-11-01T02:00')).toBe('2026-11-01T08:00:00.000Z');
  });

  it('resolves an hour that does not exist rather than throwing', () => {
    // 02:30 on 8 March 2026 is skipped by the clocks entirely. A form that
    // refused it with no explanation would be worse than one that picks the
    // sane reading; nobody sets a deadline at 2:30 AM.
    const iso = wallTimeToUtcIso('2026-03-08T02:30');
    expect(iso).not.toBeNull();
    expect(Number.isFinite(new Date(iso!).getTime())).toBe(true);
  });

  it('resolves an hour that happens twice rather than throwing', () => {
    const iso = wallTimeToUtcIso('2026-11-01T01:30');
    expect(iso).not.toBeNull();
    expect(Number.isFinite(new Date(iso!).getTime())).toBe(true);
  });

  it('handles midnight, which some ICU builds report as hour 24', () => {
    // `hour12: false` yields "24" rather than "00" for midnight in several ICU
    // versions, and an unnormalised 24 lands the instant a day late. A cycle
    // that opens at midnight is an ordinary thing to configure.
    expect(wallTimeToUtcIso('2026-06-15T00:00')).toBe('2026-06-15T05:00:00.000Z');
    expect(wallTimeToUtcIso('2026-12-15T00:00')).toBe('2026-12-15T06:00:00.000Z');
    expect(utcIsoToWallTime('2026-06-15T05:00:00.000Z')).toBe('2026-06-15T00:00');
    expect(zoneOffsetMs(new Date('2026-06-15T05:00:00.000Z'))).toBe(-5 * HOUR);
  });

  it('refuses anything that is not a wall time', () => {
    for (const bad of ['', 'tomorrow', '2026-13-01T00:00', '2026-03-01', '2026-03-01T25:00']) {
      expect(wallTimeToUtcIso(bad), bad).toBeNull();
    }
  });
});

describe('a stored instant goes back into the form unchanged', () => {
  it('round-trips through UTC and back', () => {
    for (const wall of [
      '2026-01-15T09:30',
      '2026-03-01T23:59',
      '2026-07-04T00:00',
      '2026-11-30T17:45',
    ]) {
      const iso = wallTimeToUtcIso(wall);
      expect(iso, wall).not.toBeNull();
      expect(utcIsoToWallTime(iso!), wall).toBe(wall);
    }
  });

  it('returns an empty string for an unusable value rather than "Invalid Date"', () => {
    expect(utcIsoToWallTime('not a date')).toBe('');
  });
});

describe('the offset is read for the date in question, not for today', () => {
  it('is six hours in winter and five in summer', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), DISPLAY_ZONE)).toBe(-6 * HOUR);
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), DISPLAY_ZONE)).toBe(-5 * HOUR);
  });
});

describe('the abbreviation shown beside a date', () => {
  it('says which Central it means', () => {
    // On screen before the staff member saves, so "11:59 PM CST" is something
    // they read rather than something discovered from a stored value later.
    expect(zoneAbbreviation('2026-03-02T05:59:00.000Z')).toBe('CST');
    expect(zoneAbbreviation('2026-07-15T13:00:00.000Z')).toBe('CDT');
  });
});
