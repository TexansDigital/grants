/**
 * How the grantee portal words a date and a deadline.
 *
 * A separate module from GranteeHome.tsx because these are pure functions with
 * tests, and the test suite runs under the Worker tsconfig, which has no JSX.
 * That is a mechanical reason with a real one behind it: the wording of "was
 * due", "due tomorrow" and "not asking for this one" is the part of this
 * surface most worth arguing with, and it should be arguable without a
 * component around it.
 */

import type { ReportSummary } from './granteeApi';

/**
 * A CALENDAR DATE, as a person reads it.
 *
 * Formatted in UTC, and that is the whole point. A due date, a grant term and
 * an award date are calendar dates, stored at midnight UTC. Rendering one in
 * Central subtracts six hours and lands on the PREVIOUS DAY: a grant running
 * 1 January to 31 December displayed as "December 31 to December 30", and a
 * report due the 31st displayed as due the 30th. Found by looking at the page,
 * not by a test -- every assertion about these dates was green.
 *
 * Instants get formatMoment below. The two are separate because confusing them
 * is exactly how this went wrong.
 */
export function formatDay(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * A moment in time, in the zone the Foundation announces in.
 *
 * For a timestamp that records when something actually happened -- when a
 * report was filed. A grantee in another timezone must read the same time the
 * confirmation email gave them, which is Central, not theirs.
 */
export function formatMoment(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * A moment WITH the clock on it, in Central.
 *
 * formatMoment gives the Central calendar day of an instant, which is right
 * for "filed on the 4th". It is useless for "this was checked a moment ago",
 * where the whole point is freshness -- a date alone cannot distinguish a page
 * loaded now from a tab left open since breakfast. The zone name is included
 * because a staff member in another office reading "9:30" needs to know whose.
 */
export function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** The Central calendar date, as YYYY-MM-DD. */
function centralDay(now: Date): string {
  // en-CA is the locale that yields ISO-ordered date parts.
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/**
 * Whole days from today to a due date. Negative means overdue.
 *
 * CALENDAR DAYS, both sides, not a subtraction of instants. A report due on
 * the 31st is not late at 6pm Central on the 30th, which is midnight UTC on
 * the 31st -- and subtracting instants told a grantee it was, in red, a day
 * early.
 */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const due = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return 0;
  const dueMs = Date.parse(`${due}T00:00:00Z`);
  const todayMs = Date.parse(`${centralDay(now)}T00:00:00Z`);
  if (Number.isNaN(dueMs) || Number.isNaN(todayMs)) return 0;
  return Math.round((dueMs - todayMs) / 86_400_000);
}

/**
 * The one line that says what is going on with a report.
 *
 * Written for somebody who has not thought about this since the award letter.
 * "Scheduled", "revisions_requested" and "not_open_yet" are our words; these
 * are theirs.
 */
export function reportHeadline(report: ReportSummary, now: Date = new Date()): string {
  const due = formatDay(report.dueDate);
  switch (report.state) {
    case 'accepted':
      return 'Received and accepted. Nothing more to do.';
    case 'waived':
      return 'We are not asking for this one.';
    case 'submitted':
      return `Sent on ${formatMoment(report.submittedAt)}. We will be in touch if we need anything.`;
    case 'changes_requested':
      return 'We have asked for a few changes.';
    case 'not_open_yet':
      return report.opensAt
        ? `Opens ${formatDay(report.opensAt)}. Due ${due}.`
        : `Due ${due}.`;
    case 'no_form_yet':
      return `Due ${due}. We are still preparing the questions — nothing for you to do yet.`;
    default: {
      const days = daysUntil(report.dueDate, now);
      if (days < 0) return `Was due ${due}.`;
      if (days === 0) return `Due today, ${due}.`;
      if (days === 1) return `Due tomorrow, ${due}.`;
      if (days <= 30) return `Due in ${days} days, on ${due}.`;
      return `Due ${due}.`;
    }
  }
}

/** The tone of the chip beside a report. Red is reserved for genuinely late. */
export function reportTone(
  report: ReportSummary,
  now: Date = new Date(),
): 'todo' | 'late' | 'done' | 'resting' {
  if (report.state === 'accepted') return 'done';
  if (report.state === 'submitted') return 'done';
  if (report.state === 'waived') return 'resting';
  if (!report.outstanding) return 'resting';
  return daysUntil(report.dueDate, now) < 0 ? 'late' : 'todo';
}
