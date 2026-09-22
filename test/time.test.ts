import { describe, it, expect } from 'vitest';
import { formatInZone, formatDayInZone, isCycleAcceptingSubmission } from '../src/lib/time';

describe('deadlines', () => {
  it('renders a UTC instant in Central time', () => {
    // Deadlines are announced in Central. Storage stays UTC.
    const s = formatInZone('2026-03-02T05:59:00.000Z', 'America/Chicago');
    expect(s).toContain('March 1, 2026');
    expect(s).toContain('11:59');
  });

  it('NAMES the zone, so a deadline is not just a bare wall-clock time', () => {
    // Shipped without this once: the cycle list read "March 1, 2026 at
    // 11:59 PM" and nothing said which 11:59 PM. An applicant two zones away
    // reads that as their own and loses hours they did not know they had.
    const s = formatInZone('2026-03-02T05:59:00.000Z', 'America/Chicago');
    expect(s).toContain('CST');
  });

  it('follows daylight saving in the label without anyone editing a string', () => {
    const winter = formatInZone('2026-01-15T18:00:00.000Z', 'America/Chicago');
    const summer = formatInZone('2026-07-15T18:00:00.000Z', 'America/Chicago');
    expect(winter).toContain('CST');
    expect(summer).toContain('CDT');
  });

  it('honours an explicit style instead of throwing on mixed options', () => {
    // Intl rejects dateStyle/timeStyle alongside timeZoneName. A caller that
    // wants a style must get theirs, not a TypeError.
    expect(() =>
      formatInZone('2026-03-02T05:59:00.000Z', 'America/Chicago', { dateStyle: 'short' }),
    ).not.toThrow();
    expect(formatInZone('2026-03-02T05:59:00.000Z', 'America/Chicago', { dateStyle: 'short' }))
      .toContain('3/1/26');
  });

  it('handles the DST boundary without moving the deadline', () => {
    // 2026-03-08 is the US spring-forward date. A deadline stored in UTC does
    // not shift; one stored as local time would.
    const before = formatInZone('2026-03-07T18:00:00.000Z', 'America/Chicago');
    const after = formatInZone('2026-03-09T18:00:00.000Z', 'America/Chicago');
    expect(before).toContain('12:00 PM');
    expect(after).toContain('1:00 PM');
  });

  const window = {
    opensAt: '2026-01-01T00:00:00.000Z',
    closesAt: '2026-03-01T00:00:00.000Z',
  };

  it('rejects before open and accepts inside the window', () => {
    expect(isCycleAcceptingSubmission({ ...window, graceHours: 0, now: '2025-12-31T23:00:00.000Z' }))
      .toEqual({ accepted: false, reason: 'not_yet_open' });
    expect(isCycleAcceptingSubmission({ ...window, graceHours: 0, now: '2026-02-01T00:00:00.000Z' }).accepted)
      .toBe(true);
  });

  it('enforces a hard cutoff when graceHours is 0', () => {
    expect(
      isCycleAcceptingSubmission({
        ...window,
        graceHours: 0,
        draftStartedAt: '2026-02-01T00:00:00.000Z',
        now: '2026-03-01T00:00:01.000Z',
      }),
    ).toEqual({ accepted: false, reason: 'closed' });
  });

  it('grants grace only to a draft that already existed before close', () => {
    const started = '2026-02-28T00:00:00.000Z';
    expect(
      isCycleAcceptingSubmission({
        ...window,
        graceHours: 24,
        draftStartedAt: started,
        now: '2026-03-01T12:00:00.000Z',
      }),
    ).toEqual({ accepted: true, reason: 'within_grace' });

    // A draft created AFTER close gets nothing. Grace is a courtesy to someone
    // already mid-form, not a later deadline for everyone.
    expect(
      isCycleAcceptingSubmission({
        ...window,
        graceHours: 24,
        draftStartedAt: '2026-03-01T06:00:00.000Z',
        now: '2026-03-01T12:00:00.000Z',
      }).accepted,
    ).toBe(false);

    // And grace expires.
    expect(
      isCycleAcceptingSubmission({
        ...window,
        graceHours: 24,
        draftStartedAt: started,
        now: '2026-03-02T00:00:01.000Z',
      }).accepted,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('a date that is a day, not a moment', () => {
  const CENTRAL = 'America/Chicago';

  it('carries no hour, minute or zone name', async () => {
    /*
     * THE BUG THIS PREVENTS, which shipped and was found by reading a rendered
     * subject line. `formatInZone` merges the caller's options OVER defaults
     * that include an hour, a minute and a zone name -- so passing
     * `{ year, month, day }` re-specifies the date parts and leaves the time
     * parts standing. Three callers wanted a date and got a timestamp:
     *
     *   - the retention notice, directly against its own comment, which reads
     *     "a deletion date is a day, not a moment";
     *   - the award letter's EMBARGO date, which is the date a grantee is
     *     asked not to announce before -- "you may announce this on November
     *     5, 2026 at 12:00 PM CST" reads as an hour they must wait for, on the
     *     letter CLAUDE.md calls the highest-reputation-risk output here;
     *   - the report reminder, which is what surfaced it.
     */
    const out = formatDayInZone('2026-11-05T18:00:00.000Z', CENTRAL);
    expect(out).toBe('November 5, 2026');
    for (const shape of [/\bAM\b/, /\bPM\b/, /\bC[SD]T\b/, /:/]) {
      expect(out, `a day must not carry ${String(shape)}`).not.toMatch(shape);
    }
  });

  it('still lands on the Central day, not the UTC one', async () => {
    // 1 AM UTC on the 6th is 7 PM Central on the 5th. A due date that silently
    // moves a day either way is a deadline nobody can rely on.
    expect(formatDayInZone('2026-11-06T01:00:00.000Z', CENTRAL)).toBe('November 5, 2026');
    expect(formatDayInZone('2026-11-06T13:00:00.000Z', CENTRAL)).toBe('November 6, 2026');
  });

  it('is what formatInZone with date options was NOT', async () => {
    /*
     * The two side by side, so the difference is on the record rather than in
     * a comment. This is not asserting that formatInZone is wrong -- a
     * timestamp is what most of its callers want -- only that asking it for a
     * date does not produce one.
     */
    const asked = formatInZone('2026-11-05T18:00:00.000Z', CENTRAL, {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    expect(asked).toMatch(/\bPM\b/);
    expect(formatDayInZone('2026-11-05T18:00:00.000Z', CENTRAL)).not.toMatch(/\bPM\b/);
  });
});
