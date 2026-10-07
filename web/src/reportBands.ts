/**
 * How the compliance desk sorts thirteen identical-looking rows into the four
 * questions a person actually has.
 *
 * WHY BANDS. The desk listed every obligation in due-date order, which at this
 * Foundation's volume is thirteen rows reading "Final report / December 3 /
 * Scheduled" with the two or three that need something scattered among them.
 * The header said "3 overdue" and then hid those three in the pile. A list
 * whose summary line knows more than its body is making the reader do the
 * sorting the screen exists to do.
 *
 * The bands are by WHO IS HOLDING IT UP, which is the only question that
 * changes what you do next:
 *
 *   Waiting on us   a report has been filed and nobody has read it
 *   Late            the date has passed and it has not been filed
 *   Still to come   owed, not yet due
 *   Settled         accepted or waived
 *
 * A pure module with tests, like reportWording beside it, because the ordering
 * rules are the arguable part and they should be arguable without a component
 * around them.
 */

import type { PortfolioRow } from './api';
import { GRANTEE_OWES } from '../../src/lib/reportDue';

export type BandKey = 'ours' | 'late' | 'coming' | 'settled' | 'other';

export interface Band {
  key: BandKey;
  heading: string;
  blurb: string;
  rows: PortfolioRow[];
}

const BLURB: Record<BandKey, { heading: string; blurb: string }> = {
  ours: {
    heading: 'Waiting on us',
    blurb: 'Filed, and nobody has read it yet. The Foundation is the hold-up on these.',
  },
  late: {
    heading: 'Late',
    blurb: 'The date has passed and nothing has been filed.',
  },
  coming: {
    heading: 'Still to come',
    /*
     * The second sentence is the one that earns the line. Every one of the
     * thirteen 2025 grants sits here as `scheduled`, which is not a neutral
     * waiting state -- it means the obligation exists and NOBODY HAS ASKED
     * FOR IT. Without saying so, the largest band on the screen reads as
     * "handled", and the one thing the Foundation actually has to do this
     * month is invisible inside it.
     */
    blurb: 'Owed, but not due yet. The scheduled ones have not been asked for.',
  },
  settled: {
    heading: 'Settled',
    blurb: 'Accepted, or waived. Nothing to do.',
  },
  /*
   * NOTHING MAY VANISH. The four bands above are written against the six
   * statuses migration 0016 defines, and a seventh added later would match no
   * rule -- so a row would simply stop appearing on the screen whose entire
   * promise is that it shows every obligation. This band catches anything the
   * rules do not claim and says plainly that it did.
   */
  other: {
    heading: 'Not recognised',
    blurb: 'These carry a status this screen has no rule for. Treat the list above as incomplete.',
  },
};

/** Most-overdue first, then soonest, with the organization name breaking ties. */
function byDueThenName(a: PortfolioRow, b: PortfolioRow): number {
  if (a.daysUntilDue !== b.daysUntilDue) return a.daysUntilDue - b.daysUntilDue;
  return a.organizationName.localeCompare(b.organizationName);
}

/** Longest-waiting first. A null filing date sorts last; it should not occur. */
function byFiledOldestFirst(a: PortfolioRow, b: PortfolioRow): number {
  if (a.submittedAt === b.submittedAt) return a.organizationName.localeCompare(b.organizationName);
  if (a.submittedAt === null) return 1;
  if (b.submittedAt === null) return -1;
  return a.submittedAt < b.submittedAt ? -1 : 1;
}

/** Most recently dealt with first. */
function byFiledNewestFirst(a: PortfolioRow, b: PortfolioRow): number {
  return -byFiledOldestFirst(a, b);
}

const OWES: readonly string[] = GRANTEE_OWES;

/**
 * Sort the portfolio into bands, dropping nothing.
 *
 * Empty bands are omitted, so a desk with no late reports does not carry a
 * heading insisting on it -- the absence is the news, and a "Late (0)" heading
 * on every screen trains people to stop reading the headings at all.
 */
export function bandsFor(rows: PortfolioRow[]): Band[] {
  const ours: PortfolioRow[] = [];
  const late: PortfolioRow[] = [];
  const coming: PortfolioRow[] = [];
  const settled: PortfolioRow[] = [];
  const other: PortfolioRow[] = [];

  for (const r of rows) {
    if (r.status === 'submitted') ours.push(r);
    /*
     * `overdue` is the server's, from the one shared definition in
     * src/lib/reportDue.ts, which already excludes anything filed. Recomputing
     * it here from the date would be the second definition that module exists
     * to prevent.
     */
    else if (r.overdue) late.push(r);
    else if (OWES.includes(r.status)) coming.push(r);
    else if (r.status === 'accepted' || r.status === 'waived') settled.push(r);
    else other.push(r);
  }

  ours.sort(byFiledOldestFirst);
  late.sort(byDueThenName);
  coming.sort(byDueThenName);
  settled.sort(byFiledNewestFirst);

  return (
    [
      { key: 'ours' as const, rows: ours },
      { key: 'late' as const, rows: late },
      { key: 'coming' as const, rows: coming },
      { key: 'settled' as const, rows: settled },
      { key: 'other' as const, rows: other },
    ]
      .filter((b) => b.rows.length > 0)
      .map((b) => ({ key: b.key, ...BLURB[b.key], rows: b.rows }))
  );
}
