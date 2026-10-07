/**
 * What needs a person, across everything.
 *
 * WHY THIS EXISTS, AND IT IS NOT TIDINESS. One person runs this Foundation's
 * grantmaking. Every obligation the platform knows about was, until now,
 * discoverable only by opening the tab it lived on and looking: claims on one
 * screen, overdue reports on another, files about to be destroyed on a third.
 * Nothing raised a hand. A nonprofit could sit in the claims queue for a week
 * and the system's position was that everything was fine.
 *
 * That is a single-person failure mode, not a navigation problem, and the
 * answer is one list rather than better menus. It is also what lets somebody
 * else pick this up: a colleague covering for a fortnight does not need to
 * learn the information architecture, they need to know what is outstanding.
 *
 * WHAT IS DELIBERATELY NOT HERE. Data-health findings -- no W-9, no signed
 * agreement, a missing EIN -- are real and belong on this screen eventually,
 * but they are conditions rather than deadlines, and a first version of "what
 * needs you" that mixes fourteen standing data-quality notes into four live
 * obligations is a list people stop reading. Deadlines first; conditions when
 * the shape has earned trust.
 *
 * EVERY SOURCE IS AN EXISTING, TESTED QUERY. This module composes; it owns no
 * SQL of its own. A second copy of "which reports are overdue" is how two
 * screens start disagreeing about what is overdue.
 */

import type { Session } from '../types';
import { AppError } from './errors';
import { isStaffRole } from './scope';
import { reportPortfolio } from './reportAdmin';
import { listClaims } from './granteeClaims';
import { filesDueWithin } from './retention';
import { GRANTEE_OWES } from './reportDue';

/**
 * How loudly an item asks.
 *
 * Three, not five. The point of the screen is a person glancing at it between
 * other work, and a scale finer than "now / soon / keep an eye on it" asks
 * them to rank things the software cannot rank for them.
 */
export type Urgency = 'now' | 'soon' | 'watch';

export interface TodoItem {
  /** Stable within a kind. Used as a React key and nothing else. */
  id: string;
  kind: 'claim' | 'report_filed' | 'report_overdue' | 'report_due' | 'files_due';
  /** Who this is about. An organization name, almost always. */
  title: string;
  /** One line saying what is being asked of the reader. */
  detail: string;
  /** Where to go. Null when the thing has no screen of its own yet. */
  href: string | null;
  /** ISO, for ordering within an urgency. Null sorts last. */
  dueAt: string | null;
  urgency: Urgency;
}

const URGENCY_ORDER: Record<Urgency, number> = { now: 0, soon: 1, watch: 2 };

/** Days before a report is due that it starts appearing here. */
export const REPORT_HORIZON_DAYS = 14;

/** Days before a file is destroyed that it starts appearing here. */
export const FILE_HORIZON_DAYS = 30;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * How many report periods one page of the portfolio can hold.
 *
 * reportPortfolio caps at 500 and reports a total, and this screen promises
 * completeness -- so when the cap bites, the screen has to say so rather than
 * quietly show the first 500. At 25 to 100 awards a year that is a decade
 * away; `complete` exists so the day it arrives produces a sentence on the
 * screen instead of a silently short list.
 */
const PORTFOLIO_PAGE = 500;

export async function todo(
  db: D1Database,
  session: Session,
  nowIso: string,
  /*
   * The report page size, injectable only so a test can reach the truncated
   * case without inserting five hundred report periods. Nothing in the app
   * passes it; the default is the real one.
   */
  portfolioPage: number = PORTFOLIO_PAGE,
): Promise<{ items: TodoItem[]; generatedAt: string; complete: boolean }> {
  /*
   * Checked here as well as at the route. This composes three queries that
   * each check for themselves, but the list it returns is a summary of the
   * whole Foundation's position, and a summary is exactly the kind of thing
   * that gets wired to a new endpoint later by somebody who assumes the
   * function guards itself.
   */
  if (!isStaffRole(session)) {
    throw new AppError('FORBIDDEN', 'That action is not available.', {
      internalMessage: `to-do list reached by role ${session.role}`,
      severity: 'error',
    });
  }

  /*
   * TWO OF THESE THREE SOURCES ARE ADMIN-ONLY SURFACES, and that is the trap
   * in a screen like this. /api/grantee-claims and /api/retention are both
   * ADMIN_ONLY; /api/reports is STAFF_READ. A single endpoint that fans out to
   * all three and inherits the loosest of those three roles would quietly hand
   * a reviewer -- including an outside consultant hired for one cycle -- the
   * claims queue and the destruction schedule, which is a widening of two
   * surfaces nobody asked to widen, performed by a convenience screen.
   *
   * So the role check lives next to each source rather than at the route. The
   * route stays STAFF_READ, because a reviewer has a real to-do list; it just
   * contains only the things a reviewer is permitted to see.
   */
  const isAdmin = session.role === 'admin';

  /*
   * Fetched together. These are independent reads and the screen is useless
   * until it has all of them, so there is nothing to gain by waiting in turn.
   */
  const [claims, reports, files] = await Promise.all([
    isAdmin ? listClaims(db, 'pending') : Promise.resolve([]),
    reportPortfolio(db, session, { limit: portfolioPage }),
    isAdmin ? filesDueWithin(db, nowIso, FILE_HORIZON_DAYS) : Promise.resolve([]),
  ]);

  const items: TodoItem[] = [];

  /*
   * CLAIMS ARE ALWAYS 'now'. A nonprofit has written in saying we funded them
   * and is waiting to hear back. There is no version of that which can sit
   * until next week, and it is the one queue with a person on the other end
   * of it refreshing their inbox.
   */
  for (const c of claims) {
    items.push({
      id: `claim:${c.id}`,
      kind: 'claim',
      title: c.organizationName,
      detail: `${c.contactName} says we funded them${c.grantYear ? ` in ${c.grantYear}` : ''}. Find the grant and connect them, or decline.`,
      href: '/past-grantees',
      dueAt: c.createdAt,
      urgency: 'now',
    });
  }

  for (const r of reports.rows) {
    /*
     * A FILED REPORT IS AN OBLIGATION ON US, and it is the one people forget,
     * because nothing chases the Foundation. A grantee who filed three weeks
     * ago and has heard nothing has done everything we asked.
     */
    if (r.status === 'submitted') {
      items.push({
        id: `filed:${r.reportPeriodId}`,
        kind: 'report_filed',
        title: r.organizationName,
        detail: `Filed their ${r.label.toLowerCase()}. Read it and accept, or ask for more.`,
        href: `/reporting?report=${encodeURIComponent(r.reportPeriodId)}`,
        dueAt: r.submittedAt,
        urgency: 'now',
      });
      continue;
    }

    /*
     * GRANTEE_OWES IS THE LIST, not a copy of it written here.
     *
     * This was spelled out as `open` or `scheduled`, which silently dropped
     * `revisions_requested` -- a report the Foundation sent back and is
     * waiting on. The comment even claimed revisions "has been answered by
     * somebody", which is backwards: we asked, and the grantee has not
     * answered. Meanwhile the compliance desk counted it overdue and the
     * application gate could block that nonprofit's next cycle over it, while
     * the screen whose contract is "an empty list means nothing is
     * outstanding" showed nothing at all.
     *
     * reportDue.ts owns the definition precisely so the desk, the gate and
     * this list cannot disagree. Anything outside it -- submitted, accepted,
     * waived -- is ours or finished, and `submitted` is picked up above as
     * work for the Foundation rather than for the grantee.
     */
    if (!(GRANTEE_OWES as readonly string[]).includes(r.status)) continue;

    /*
     * Said out loud in the row, because "overdue" against a grantee nobody
     * contacted is a different conversation from "overdue" against one who
     * was reminded three times, and the two look identical without this.
     *
     * Keyed on `scheduled` ALONE. A period in revisions_requested has very
     * much been asked for -- twice.
     */
    const unasked = r.status === 'scheduled' ? ' Nobody has asked them for it yet.' : '';

    if (r.overdue) {
      items.push({
        id: `overdue:${r.reportPeriodId}`,
        kind: 'report_overdue',
        title: r.organizationName,
        detail: `${r.label} was due ${r.dueDate.slice(0, 10)} — ${plural(Math.abs(r.daysUntilDue), 'day', 'days')} ago.${unasked}`,
        href: `/reporting?report=${encodeURIComponent(r.reportPeriodId)}`,
        dueAt: r.dueDate,
        urgency: 'now',
      });
    } else if (r.daysUntilDue <= REPORT_HORIZON_DAYS) {
      items.push({
        id: `due:${r.reportPeriodId}`,
        kind: 'report_due',
        title: r.organizationName,
        detail: `${r.label} is due in ${plural(r.daysUntilDue, 'day', 'days')}.${unasked}`,
        href: `/reporting?report=${encodeURIComponent(r.reportPeriodId)}`,
        dueAt: r.dueDate,
        // An unasked report due inside the horizon is 'now', not 'soon': the
        // thing that has to happen is ours, and it has to happen before the
        // date, not on it.
        urgency: r.status === 'scheduled' ? 'now' : 'soon',
      });
    }
  }

  /*
   * A FILE ABOUT TO BE DESTROYED IS A DEADLINE, not a setting, and it was
   * previously only visible to somebody who thought to open Retention. These
   * are somebody else's audited financial statements; the decision to keep or
   * destroy one should not depend on remembering a tab.
   */
  for (const f of files) {
    items.push({
      id: `file:${f.id}`,
      kind: 'files_due',
      title: f.organization_name,
      detail: `${f.filename} is due for destruction ${f.effective_due_at.slice(0, 10)}.`,
      href: '/retention',
      dueAt: f.effective_due_at,
      urgency: 'soon',
    });
  }

  /*
   * Urgency first, then by date within it, oldest first -- the thing that has
   * been waiting longest is the thing most likely to have been forgotten.
   * A null date sorts last rather than first, so an item with no deadline
   * never displaces one that has been overdue for a month.
   */
  items.sort((a, b) => {
    const u = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (u !== 0) return u;
    if (a.dueAt === b.dueAt) return a.id.localeCompare(b.id);
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    return a.dueAt < b.dueAt ? -1 : 1;
  });

  return { items, generatedAt: nowIso, complete: reports.total <= reports.rows.length };
}
