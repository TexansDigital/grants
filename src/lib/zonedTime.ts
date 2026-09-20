/**
 * Wall-clock time in a named zone, converted to and from UTC.
 *
 * WHY THIS IS NOT `new Date(localString)`.
 *
 * A cycle closes at "11:59:59 PM on 1 March, Central". Storage is UTC and
 * display is Central -- that much was already true. What was missing is the
 * step in between: a staff member typing a deadline into a form.
 *
 * `<input type="datetime-local">` yields a naive string with no zone, and the
 * browser interprets it in ITS OWN zone. A deadline entered by somebody in
 * Houston and the same deadline entered by a consultant in London would be five
 * or six hours apart, and nothing on screen would say so. The applications
 * rejected as late would be real.
 *
 * So the zone is stated, not inferred. The Foundation's deadlines are Central
 * whoever types them.
 *
 * DST is the reason this is more than an offset subtraction. Central is -06:00
 * for part of the year and -05:00 for the rest, the offset that applies depends
 * on the instant, and the instant is what we are trying to work out. The fixed
 * point below converges in one correction and is run twice, which is enough for
 * every real zone: offsets change by at most an hour or two, never by more than
 * the gap between the guess and the answer.
 *
 * Two wall times have no single answer and both are handled deliberately:
 *   - the hour that does not exist on a spring-forward day
 *   - the hour that happens twice on a fall-back day
 * Both resolve to a real instant rather than throwing, because a form that
 * refuses "2:30 AM on the second Sunday in March" with no explanation is worse
 * than one that picks the sane reading. Deadlines are not set at 2 AM.
 */

/** Steward's display and input zone. One definition. */
export const DISPLAY_ZONE = 'America/Chicago';

const PARTS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = PARTS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS.set(timeZone, f);
  }
  return f;
}

/**
 * What the clock in `timeZone` reads at this instant, as UTC milliseconds.
 *
 * Subtracting this from the instant gives the zone's offset. Intl is the only
 * thing in the platform that knows the DST rules, and it knows them for the
 * date in question rather than for today.
 */
function wallClockMs(instant: Date, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  /*
   * Hour 24 for midnight, under `hour12: false`, in some ICU versions.
   *
   * KNOWN GAP, stated rather than left to look covered: this runtime's ICU
   * reports "00", so the `% 24` is defensive and no test exercises it. A
   * mutation removing it survives the suite. It stays because a runtime that
   * does report 24 would land every midnight instant a day late, and because
   * the cost of keeping it is one character.
   */
  const hour = get('hour') % 24;
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
export function zoneOffsetMs(instant: Date, timeZone: string = DISPLAY_ZONE): number {
  return wallClockMs(instant, timeZone) - instant.getTime();
}

/**
 * "2026-03-01T23:59" read as a wall clock in `timeZone`, as a UTC instant.
 *
 * Accepts the shapes an `<input type="datetime-local">` produces: with or
 * without seconds. Returns null for anything else rather than guessing, so a
 * caller has to decide what to tell the person.
 */
export function wallTimeToUtcIso(local: string, timeZone: string = DISPLAY_ZONE): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59 || se! > 59) return null;

  const wanted = Date.UTC(y!, mo! - 1, d!, h!, mi!, se!);
  // Fixed point: guess, measure the offset AT that guess, correct, repeat once.
  let utc = wanted;
  for (let i = 0; i < 2; i += 1) {
    utc = wanted - zoneOffsetMs(new Date(utc), timeZone);
  }
  const result = new Date(utc);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

/**
 * The reverse, for putting a stored instant back into a form field.
 *
 * Produces exactly what `<input type="datetime-local">` expects, which is
 * minute precision and no zone suffix.
 */
export function utcIsoToWallTime(iso: string, timeZone: string = DISPLAY_ZONE): string {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return '';
  const wall = new Date(wallClockMs(instant, timeZone));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(wall.getUTCFullYear(), 4)}-${p(wall.getUTCMonth() + 1)}-${p(wall.getUTCDate())}` +
    `T${p(wall.getUTCHours())}:${p(wall.getUTCMinutes())}`
  );
}

/**
 * The zone abbreviation for an instant -- CST or CDT.
 *
 * Shown next to a date the staff member typed, so "11:59 PM CST" is on screen
 * before they save rather than discovered from a stored value afterwards.
 */
export function zoneAbbreviation(iso: string, timeZone: string = DISPLAY_ZONE): string {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(
    instant,
  );
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}
