/**
 * What "overdue" means, in one place.
 *
 * Two surfaces ask the question and they must not answer it differently: the
 * staff compliance desk, which colours a row red, and the application gate,
 * which can refuse a nonprofit a grant cycle over it. A definition that forked
 * between those two would mean telling an organization they are blocked for a
 * report the desk shows as fine.
 *
 * Pure: no database, no Env. Both callers pass what they have.
 */

/**
 * The calendar day an instant falls on, as YYYY-MM-DD.
 *
 * EXPORTED SO SQL CAN BIND THE SAME THING THIS MODULE COMPARES. Three list
 * queries re-implemented "overdue" as `due_date < ?` with a full ISO instant
 * bound, which is not the same predicate: due dates are stored either as a
 * plain date ('2026-10-07', what requestUpdates writes) or midnight UTC, and
 * string comparison makes BOTH sort before any same-day timestamp. So a
 * report due today read as overdue from a millisecond after midnight, in red,
 * on screens sitting next to the compliance desk saying it was fine.
 *
 * Any SQL asking this question binds `today(nowIso)` and compares
 * `substr(due_date, 1, 10) < ?`, so the string comparison is between two
 * plain dates and cannot diverge from daysUntil below.
 *
 * NOTE, AND IT IS NOT FIXED HERE: this is the UTC day, while the grantee
 * portal deliberately uses the Central one (web/src/reportWording.ts). That
 * fork predates this helper and changing it moves the application-blocking
 * boundary, so it is reported rather than quietly altered.
 */
export function today(nowIso: string): string {
  return nowIso.slice(0, 10);
}

/** Whole calendar days from today to a due date. Negative means past. */
export function daysUntil(dueIso: string, nowIso: string): number {
  const due = dueIso.slice(0, 10);
  const today = nowIso.slice(0, 10);
  const a = Date.parse(`${due}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86_400_000);
}

/**
 * Statuses where the report is still the GRANTEE'S to do.
 *
 * Everything else is ours or finished: `submitted` is sitting with staff,
 * `accepted` and `waived` are done.
 */
export const GRANTEE_OWES = ['scheduled', 'open', 'revisions_requested'] as const;

/**
 * A report is overdue when the date has passed AND it has not been filed.
 *
 * Not "the date has passed". A report filed a week late and now waiting on
 * staff is our queue, not the nonprofit's failure -- and blocking their next
 * application over a report they already sent us would be indefensible.
 */
export function isOverdue(status: string, dueIso: string, nowIso: string): boolean {
  if (!(GRANTEE_OWES as readonly string[]).includes(status)) return false;
  return daysUntil(dueIso, nowIso) < 0;
}
