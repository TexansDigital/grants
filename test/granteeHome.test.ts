import { describe, it, expect } from 'vitest';
import {
  formatDay, formatMoment, daysUntil, reportHeadline, reportTone,
} from '../web/src/reportWording';
import type { ReportSummary } from '../web/src/granteeApi';

const report = (over: Partial<ReportSummary> = {}): ReportSummary => ({
  id: 'r1',
  label: 'Final report',
  type: 'final',
  periodStart: '2025-01-01T00:00:00.000Z',
  periodEnd: '2025-12-31T00:00:00.000Z',
  dueDate: '2026-03-31T00:00:00.000Z',
  opensAt: '2025-12-31T00:00:00.000Z',
  state: 'open',
  outstanding: true,
  submittedAt: null,
  feedback: null,
  attachments: [],
  ...over,
});

const at = (iso: string) => new Date(iso);

// ---------------------------------------------------------------------------
describe('a calendar date is not an instant', () => {
  it('shows the day that was stored, not the day before it', () => {
    // Found by looking at the rendered page: a grant running 1 January to 31
    // December read as "December 31 to December 30", because a date stored at
    // midnight UTC is 6pm the previous evening in Central.
    expect(formatDay('2025-01-01T00:00:00.000Z')).toBe('January 1, 2025');
    expect(formatDay('2025-12-31T00:00:00.000Z')).toBe('December 31, 2025');
    expect(formatDay('2026-03-31T00:00:00.000Z')).toBe('March 31, 2026');
  });

  it('shows an instant in Central, which is what the email said', () => {
    // 1am UTC on the 1st is 7pm Central on the previous evening, and the
    // confirmation email says the 31st. The portal has to agree with it.
    expect(formatMoment('2026-01-01T01:00:00.000Z')).toBe('December 31, 2025');
  });

  it('degrades to nothing rather than to "Invalid Date"', () => {
    for (const bad of [null, '', 'not a date']) {
      expect(formatDay(bad)).toBe('');
      expect(formatMoment(bad)).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
describe('how late is late', () => {
  it('counts whole calendar days, not a subtraction of instants', () => {
    // 6pm Central on the 30th IS midnight UTC on the 31st. Subtracting
    // instants made a report due the 31st overdue that evening -- in red, a
    // day early, to somebody who had not missed anything.
    expect(daysUntil('2026-03-31T00:00:00.000Z', at('2026-03-31T00:30:00.000Z'))).toBe(1);
    // The same moment, an hour before midnight Central on the 30th.
    expect(daysUntil('2026-03-31T00:00:00.000Z', at('2026-03-31T04:59:00.000Z'))).toBe(1);
    // Just past midnight Central on the 31st: due today.
    expect(daysUntil('2026-03-31T00:00:00.000Z', at('2026-03-31T05:30:00.000Z'))).toBe(0);
    // Just past midnight Central on 1 April: one day late.
    expect(daysUntil('2026-03-31T00:00:00.000Z', at('2026-04-01T05:30:00.000Z'))).toBe(-1);
  });

  it('counts across a month boundary', () => {
    expect(daysUntil('2026-04-15T00:00:00.000Z', at('2026-03-31T12:00:00.000Z'))).toBe(15);
  });

  it('returns zero rather than NaN for an unusable date', () => {
    expect(daysUntil('nonsense')).toBe(0);
    expect(daysUntil('')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('what the page tells a grantee', () => {
  const now = at('2026-03-01T12:00:00.000Z');

  it('counts down in days when the date is close', () => {
    expect(reportHeadline(report({ dueDate: '2026-03-02T00:00:00.000Z' }), now))
      .toBe('Due tomorrow, March 2, 2026.');
    expect(reportHeadline(report({ dueDate: '2026-03-01T00:00:00.000Z' }), now))
      .toBe('Due today, March 1, 2026.');
    expect(reportHeadline(report({ dueDate: '2026-03-11T00:00:00.000Z' }), now))
      .toBe('Due in 10 days, on March 11, 2026.');
  });

  it('stops counting when the date is far off', () => {
    // "Due in 214 days" is a number nobody acts on; the date is the fact.
    expect(reportHeadline(report({ dueDate: '2026-10-01T00:00:00.000Z' }), now))
      .toBe('Due October 1, 2026.');
  });

  it('says a passed date plainly, without scolding', () => {
    expect(reportHeadline(report({ dueDate: '2026-02-01T00:00:00.000Z' }), now))
      .toBe('Was due February 1, 2026.');
  });

  it('names every closed state in the grantee`s own terms', () => {
    const h = (over: Partial<ReportSummary>) => reportHeadline(report(over), now);
    expect(h({ state: 'accepted', outstanding: false }))
      .toBe('Received and accepted. Nothing more to do.');
    expect(h({ state: 'waived', outstanding: false })).toBe('We are not asking for this one.');
    expect(h({ state: 'submitted', outstanding: false, submittedAt: '2026-02-10T15:00:00.000Z' }))
      .toContain('Sent on February 10, 2026');
    expect(h({ state: 'changes_requested' })).toBe('We have asked for a few changes.');
  });

  it('gives an unopened report its opening date, not a countdown', () => {
    expect(h(now)).toBe('Opens December 31, 2025. Due March 31, 2026.');
    function h(n: Date) {
      return reportHeadline(report({ state: 'not_open_yet', outstanding: false }), n);
    }
  });

  it('owns a missing form as our problem, not theirs', () => {
    expect(reportHeadline(report({ state: 'no_form_yet', outstanding: false }), now))
      .toContain('nothing for you to do yet');
  });
});

// ---------------------------------------------------------------------------
describe('when a chip turns red', () => {
  const now = at('2026-03-01T12:00:00.000Z');

  it('is red only once a date has actually passed', () => {
    // Battle Red is reserved for the highest-priority alerts. A report due in
    // three weeks is not one.
    expect(reportTone(report({ dueDate: '2026-03-22T00:00:00.000Z' }), now)).toBe('todo');
    expect(reportTone(report({ dueDate: '2026-03-01T00:00:00.000Z' }), now)).toBe('todo');
    expect(reportTone(report({ dueDate: '2026-02-28T00:00:00.000Z' }), now)).toBe('late');
  });

  it('never reds a report the grantee cannot act on', () => {
    // An overdue date on a waived or not-yet-open report is our bookkeeping,
    // not their failure.
    const overdue = { dueDate: '2026-01-01T00:00:00.000Z', outstanding: false };
    expect(reportTone(report({ ...overdue, state: 'waived' }), now)).toBe('resting');
    expect(reportTone(report({ ...overdue, state: 'not_open_yet' }), now)).toBe('resting');
    expect(reportTone(report({ ...overdue, state: 'no_form_yet' }), now)).toBe('resting');
  });

  it('reads a finished report as finished', () => {
    expect(reportTone(report({ state: 'submitted', outstanding: false }), now)).toBe('done');
    expect(reportTone(report({ state: 'accepted', outstanding: false }), now)).toBe('done');
  });
});
