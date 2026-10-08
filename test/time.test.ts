import { describe, it, expect } from 'vitest';
import {
  formatInZone, formatDayInZone, formatCalendarDay, isCycleAcceptingSubmission,
} from '../src/lib/time';

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

// ---------------------------------------------------------------------------
/*
 * A DAY ON A CALENDAR versus A MOMENT IN TIME.
 *
 * These two look interchangeable and are not. `2026-10-22` is a day somebody
 * typed into a date field; `2026-11-05T18:00:00.000Z` is an instant. Reading
 * the first in Central moves it to October 21, because JavaScript parses a
 * date-only string as UTC midnight and UTC midnight in Central is the previous
 * evening.
 *
 * THIS REACHED A REAL MAILBOX. On 2026-10-08 a grantee was sent "October 21,
 * 2026. Due in 14 days." about a report due 2026-10-22 -- the date and the
 * day-count contradicting each other inside one sentence, and both
 * contradicting the compliance desk, which said October 22.
 */
describe('a calendar day is not an instant', () => {
  const CENTRAL = 'America/Chicago';

  it('renders a plain YYYY-MM-DD as that day, not the evening before', () => {
    expect(formatCalendarDay('2026-10-22')).toBe('October 22, 2026');
    // The exact string that went out, and the exact one that should have.
    expect(formatDayInZone('2026-10-22', CENTRAL)).toBe('October 21, 2026');
  });

  it('does the same for a date stored as UTC midnight, which is what the importer writes', () => {
    // parseImportDate returns d.toISOString(), so announcement_date looks like
    // this. The embargo date on an award letter is this shape.
    expect(formatCalendarDay('2026-10-22T00:00:00.000Z')).toBe('October 22, 2026');
  });

  it('is wrong in winter too, so this is not a daylight-saving edge', () => {
    // CST, not CDT. The shift is six hours rather than five and lands in the
    // previous day either way.
    expect(formatCalendarDay('2026-01-15')).toBe('January 15, 2026');
    expect(formatDayInZone('2026-01-15', CENTRAL)).toBe('January 14, 2026');
  });

  it('leaves a genuine instant to formatDayInZone, which still converts it', () => {
    /*
     * The other half of the split, and the reason this is two functions rather
     * than one fix. `purge_due_at` is computed from a real moment and the
     * Foundation should read it in their own zone: 1am UTC on the 6th IS the
     * evening of the 5th in Houston, and saying "November 6" would be wrong.
     */
    expect(formatDayInZone('2026-11-06T01:00:00.000Z', CENTRAL)).toBe('November 5, 2026');
    // formatCalendarDay would answer the other question, correctly for its own
    // question and wrongly for this one.
    expect(formatCalendarDay('2026-11-06T01:00:00.000Z')).toBe('November 6, 2026');
  });

  it('agrees with the screen, which was right all along', () => {
    /*
     * web/src/reportWording.ts formats with timeZone: 'UTC' and has always
     * shown October 22. The email disagreeing with the compliance desk is how
     * this was noticed at all.
     */
    const screen = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
    }).format(new Date('2026-10-22'));
    expect(formatCalendarDay('2026-10-22')).toBe(screen);
  });
});
