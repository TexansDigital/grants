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
 * Format a stored UTC timestamp for a human, in the program's display timezone.
 * Cycle deadlines are announced in Central time; this is where that happens.
 */
export function formatInZone(
  iso: string,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'long',
    timeStyle: 'short',
    ...opts,
  }).format(new Date(iso));
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
  draftStartedAt?: string | null;
  now?: string;
}): { accepted: boolean; reason?: string } {
  const now = new Date(args.now ?? nowIso()).getTime();
  const opens = new Date(args.opensAt).getTime();
  const closes = new Date(args.closesAt).getTime();

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
