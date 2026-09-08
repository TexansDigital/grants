/**
 * Time handling.
 *
 * Storage is ALWAYS UTC, ISO-8601, with milliseconds. Central time is a display
 * concern applied at the edge. A deadline stored in local time is a deadline
 * that moves twice a year.
 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(d: Date): string {
  return d.toISOString();
}

/**
 * Default shape for a human-facing timestamp.
 *
 * Explicit components rather than dateStyle/timeStyle, because Intl rejects
 * combining those with timeZoneName -- and the zone name is not optional here.
 */
const ZONED_DEFAULTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

/**
 * Format a stored UTC timestamp for a human, in the program's display timezone.
 * Cycle deadlines are announced in Central time; this is where that happens.
 *
 * The zone NAME is always part of the output. This previously used
 * `dateStyle: 'long'` with `timeStyle: 'short'`, which cannot emit one, so the
 * cycle list read "March 1, 2026 at 11:59 PM" with nothing saying which 11:59
 * PM. That is a deadline a nonprofit is held to; an applicant two zones away
 * reads it as their own and loses hours they did not know they had.
 *
 * "CST" and "CDT" come out of the zone data, so the label follows daylight
 * saving by itself rather than being a string someone must remember to change
 * twice a year.
 */
export function formatInZone(
  iso: string,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  // A caller asking for a style wants a different shape entirely, and Intl
  // throws if the two kinds of option are combined. Honour theirs alone.
  const usesStyles = opts.dateStyle !== undefined || opts.timeStyle !== undefined;
  const options = usesStyles ? { ...opts } : { ...ZONED_DEFAULTS, ...opts };
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(new Date(iso));
}

/**
 * Whether a cycle is accepting submissions right now.
 *
 * `graceHours` is the per-cycle grace rule for drafts started before close.
 * It applies ONLY to an application that already existed before closes_at;
 * the caller supplies `draftStartedAt` to prove that. A grace window is not a
 * later deadline for everyone, it is a courtesy to someone already mid-form.
 */
export function isCycleAcceptingSubmission(args: {
  opensAt: string;
  closesAt: string;
  graceHours: number;
  /** The cycle's administrative status. 'open' is the only accepting state. */
  status?: string;
  draftStartedAt?: string | null;
  now?: string;
}): { accepted: boolean; reason?: string } {
  const now = new Date(args.now ?? nowIso()).getTime();
  const opens = new Date(args.opensAt).getTime();
  const closes = new Date(args.closesAt).getTime();

  // A malformed timestamp must never widen the window. `now < NaN` is false,
  // so an unguarded comparison skipped the not-yet-open branch and behaved as
  // though the cycle had opened.
  if (!Number.isFinite(now) || !Number.isFinite(opens) || !Number.isFinite(closes)) {
    return { accepted: false, reason: 'invalid_window' };
  }
  if (!Number.isFinite(args.graceHours) || args.graceHours < 0) {
    return { accepted: false, reason: 'invalid_window' };
  }

  // Closing a cycle administratively is the action an admin actually takes; it
  // must not require also rewriting an announced deadline.
  if (args.status !== undefined && args.status !== 'open') {
    return { accepted: false, reason: args.status === 'draft' ? 'not_yet_open' : 'closed' };
  }

  if (now < opens) return { accepted: false, reason: 'not_yet_open' };
  if (now <= closes) return { accepted: true };

  if (args.graceHours > 0 && args.draftStartedAt) {
    const startedBeforeClose = new Date(args.draftStartedAt).getTime() <= closes;
    const graceEnds = closes + args.graceHours * 3600_000;
    if (startedBeforeClose && now <= graceEnds) {
      return { accepted: true, reason: 'within_grace' };
    }
  }
  return { accepted: false, reason: 'closed' };
}
