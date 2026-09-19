/**
 * Organization deduplication.
 *
 * Duplicates are not a defect in this system, they are a documented state of
 * it: `organizations` deliberately has NO unique index on EIN, because two
 * contacts from the same nonprofit, or an EIN typed with a dash one year and
 * without it the next, are ordinary things and refusing them at the door would
 * turn a data-entry slip into a nonprofit unable to apply.
 *
 * The consequence is that something has to put them back together, and
 * CLAUDE.md is blunt that retrofitting a merge after two years of data is
 * painful. It is also not cosmetic: the compliance gate binds to the
 * organization identity RESOLVES, so a returning grantee applying from a new
 * address lands in a fresh record with no history and is not gated on the
 * report they owe. Merging is what closes that.
 *
 * TWO PHASES, ALWAYS. `planMerge` reads and decides, `applyMerge` writes what
 * was planned. Nothing merges without a plan a human could have read first,
 * and the preview is the plan with the second call not made. Merging is not
 * reversible in any way that matters -- the loser's rows are re-pointed, not
 * copied -- so it gets the same treatment as a money path.
 *
 * NOTHING IS DELETED. The loser keeps its row, marked `merged` with
 * `merged_into_id` set, so an id held anywhere -- an old email, a bookmark, a
 * spreadsheet -- still resolves through resolveMergeTarget to the survivor.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { auditStatement } from './audit';
import { nowIso } from './time';
import { isStaffRole } from './scope';

/** Rows moved from the merged organization to the survivor. */
export interface MergeMoves {
  applications: number;
  awards: number;
  reportDrafts: number;
  contacts: number;
  /** Contacts NOT moved, because the survivor already has that address. */
  contactsRetired: number;
  users: number;
  attachments: number;
}

export interface OrganizationSummary {
  id: string;
  legalName: string;
  ein: string | null;
  status: string;
  createdAt: string;
  applications: number;
  awards: number;
  contacts: number;
  users: number;
  /** Reports this organization still owes. */
  openReports: number;
  /** The most recent thing that happened, so an admin can tell which is live. */
  lastActivityAt: string | null;
}

export interface MergePlan {
  survivor: OrganizationSummary;
  merged: OrganizationSummary;
  moves: MergeMoves;
  /** Things a human has to resolve before this can run. */
  conflicts: string[];
  ok: boolean;
}

function assertStaff(session: Session): void {
  if (!isStaffRole(session)) {
    throw new AppError('FORBIDDEN', 'That action is not available.', {
      internalMessage: `organization merge reached by role ${session.role}`,
      severity: 'error',
    });
  }
}

function assertAdmin(session: Session): void {
  if (session.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'Only an administrator can merge organizations.', {
      internalMessage: `merge attempted by role ${session.role}`,
      severity: 'warn',
    });
  }
}

const SUMMARY_SQL = `
  SELECT o.id, o.legal_name AS legalName, o.ein, o.status, o.created_at AS createdAt,
         (SELECT COUNT(*) FROM applications WHERE organization_id = o.id AND deleted_at IS NULL)
           AS applications,
         (SELECT COUNT(*) FROM awards WHERE organization_id = o.id AND deleted_at IS NULL)
           AS awards,
         (SELECT COUNT(*) FROM contacts WHERE organization_id = o.id AND deleted_at IS NULL)
           AS contacts,
         (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND deleted_at IS NULL)
           AS users,
         (SELECT COUNT(*) FROM report_periods rp
            JOIN awards a ON a.id = rp.award_id AND a.deleted_at IS NULL
           WHERE a.organization_id = o.id AND rp.deleted_at IS NULL
             AND rp.status IN ('scheduled','open','revisions_requested')) AS openReports,
         (SELECT MAX(t) FROM (
            SELECT MAX(created_at) AS t FROM applications
             WHERE organization_id = o.id AND deleted_at IS NULL
            UNION ALL
            SELECT MAX(awarded_at) FROM awards
             WHERE organization_id = o.id AND deleted_at IS NULL
            UNION ALL
            SELECT o.updated_at
          )) AS lastActivityAt
    FROM organizations o
   WHERE o.id = ?`;

async function summarize(db: D1Database, id: string): Promise<OrganizationSummary | null> {
  return await db.prepare(SUMMARY_SQL).bind(id).first<OrganizationSummary>();
}

export interface DuplicateGroup {
  /** Why these are suspected duplicates. */
  reason: 'same_ein' | 'same_name';
  key: string;
  organizations: OrganizationSummary[];
}

/**
 * Organizations that look like the same nonprofit twice.
 *
 * Two passes, and the EIN one is the one that matters: EINs are normalized to
 * nine digits on the way in, so a match there is a strong signal rather than a
 * guess. The name pass is deliberately crude -- case-folded, punctuation and
 * the usual suffixes stripped -- because it exists to put a pair in front of a
 * human, not to decide anything. Nothing here merges anything.
 */
export async function findDuplicateCandidates(
  db: D1Database,
  session: Session,
  opts: { limit?: number } = {},
): Promise<DuplicateGroup[]> {
  assertStaff(session);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const groups: DuplicateGroup[] = [];

  const { results: einGroups } = await db
    .prepare(
      /*
       * The NULL and empty-string guards are an OPTIMIZATION, not the
       * correctness boundary, and saying so beats implying otherwise.
       *
       * `ein = ?` in the fetch below never matches NULL, and the schema CHECK
       * means an EIN is NULL or exactly nine digits -- so there is no
       * empty-string case to defend against either. What these actually buy is
       * not grouping every blank-EIN record in the table into one pile on the
       * way past.
       */
      `SELECT ein, COUNT(*) AS n FROM organizations
        WHERE ein IS NOT NULL AND ein <> ''
          AND deleted_at IS NULL AND status <> 'merged'
        GROUP BY ein HAVING COUNT(*) > 1
        ORDER BY n DESC, ein
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ ein: string; n: number }>();

  for (const g of einGroups ?? []) {
    const { results: ids } = await db
      .prepare(
        `SELECT id FROM organizations
          WHERE ein = ? AND deleted_at IS NULL AND status <> 'merged'
          ORDER BY created_at`,
      )
      .bind(g.ein)
      .all<{ id: string }>();
    const organizations: OrganizationSummary[] = [];
    for (const r of ids ?? []) {
      const s = await summarize(db, r.id);
      if (s) organizations.push(s);
    }
    if (organizations.length > 1) {
      groups.push({ reason: 'same_ein', key: g.ein, organizations });
    }
  }

  /*
   * The name pass.
   *
   * Done in SQL with nested replace() rather than in code, because doing it in
   * code means reading every organization row to find the handful that
   * collide. It is crude on purpose: "The Bayou Reach Collective, Inc." and
   * "Bayou Reach Collective" should land in front of a human, and anything
   * cleverer would start deciding.
   */
  /*
   * lower() INNERMOST, which is not where it started.
   *
   * With lower() wrapped around the replaces, ' inc' and 'the ' were matched
   * against the original casing -- so "The Bayou Reach Collective, Inc." kept
   * both its article and its suffix and never grouped with "Bayou Reach
   * Collective". Every replace has to run on already-folded text.
   */
  const NORM =
    `replace(replace(replace(replace(replace(replace(replace(` +
    `lower(legal_name), '.', ''), ',', ''), '-', ' '), '  ', ' '), ' inc', ''), ' llc', ''), 'the ', '')`;

  const { results: nameGroups } = await db
    .prepare(
      `SELECT ${NORM} AS norm, COUNT(*) AS n FROM organizations
        WHERE deleted_at IS NULL AND status <> 'merged'
        GROUP BY norm HAVING COUNT(*) > 1
        ORDER BY n DESC, norm
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ norm: string; n: number }>();

  const seen = new Set(groups.flatMap((g) => g.organizations.map((o) => o.id)));

  for (const g of nameGroups ?? []) {
    const { results: ids } = await db
      .prepare(
        `SELECT id FROM organizations
          WHERE ${NORM} = ? AND deleted_at IS NULL AND status <> 'merged'
          ORDER BY created_at`,
      )
      .bind(g.norm)
      .all<{ id: string }>();

    // Already reported under their shared EIN. Saying it twice makes the
    // queue look twice as bad as it is.
    if ((ids ?? []).every((r) => seen.has(r.id))) continue;

    const organizations: OrganizationSummary[] = [];
    for (const r of ids ?? []) {
      const s = await summarize(db, r.id);
      if (s) organizations.push(s);
    }
    if (organizations.length > 1) {
      groups.push({ reason: 'same_name', key: g.norm, organizations });
    }
  }

  return groups;
}

/**
 * Work out what merging one organization into another would do.
 *
 * Reads only. Every conflict it can find is a sentence, because the person
 * reading this is deciding whether to do something irreversible to a
 * nonprofit's record.
 */
export async function planMerge(
  db: D1Database,
  session: Session,
  survivorId: string,
  mergedId: string,
): Promise<MergePlan> {
  assertStaff(session);

  const survivor = await summarize(db, survivorId);
  const merged = await summarize(db, mergedId);
  if (!survivor || !merged) throw notFound('organization');

  const conflicts: string[] = [];

  if (survivorId === mergedId) {
    conflicts.push('An organization cannot be merged into itself.');
  }

  for (const [label, o] of [
    ['survivor', survivor],
    ['duplicate', merged],
  ] as const) {
    if (o.status === 'merged') {
      conflicts.push(
        `"${o.legalName}" has already been merged into another organization. ` +
          'Merge into the surviving record instead.',
      );
    }
    // Deleted rows are excluded from every candidate query, so this is only
    // reachable by an id typed in by hand -- which is exactly when it matters.
    const deleted = await db
      .prepare(`SELECT deleted_at FROM organizations WHERE id = ?`)
      .bind(o.id)
      .first<{ deleted_at: string | null }>();
    if (deleted?.deleted_at) {
      conflicts.push(`The ${label} record "${o.legalName}" has been deleted.`);
    }
  }

  /*
   * The one conflict that is not about state, but about consequence.
   *
   * A program may cap live applications per organization per cycle per stage.
   * That cap is enforced by a BEFORE INSERT trigger, so re-pointing rows with
   * an UPDATE walks straight past it: merging two organizations that both
   * applied to the same cycle would leave the survivor over the limit, with
   * nothing to say so. Found by reading the trigger rather than by hitting it.
   */
  const { results: clashes } = await db
    .prepare(
      `SELECT c.name AS cycle_name, ps.name AS stage_name, p.max_applications_per_cycle AS cap,
              COUNT(*) AS n
         FROM applications a
         JOIN cycles c ON c.id = a.cycle_id
         JOIN programs p ON p.id = c.program_id
         LEFT JOIN program_stages ps ON ps.id = a.stage_id
        WHERE a.organization_id IN (?, ?)
          AND a.deleted_at IS NULL
          AND a.status <> 'withdrawn'
        GROUP BY a.cycle_id, a.stage_id
       HAVING p.max_applications_per_cycle IS NOT NULL
          AND COUNT(*) > p.max_applications_per_cycle`,
    )
    .bind(survivorId, mergedId)
    .all<{ cycle_name: string; stage_name: string | null; cap: number; n: number }>();

  for (const c of clashes ?? []) {
    conflicts.push(
      `Both records have an application in "${c.cycle_name}"` +
        (c.stage_name ? ` (${c.stage_name})` : '') +
        `. That program allows ${c.cap} per organization, and merging would leave ${c.n}. ` +
        'Withdraw one of them first, then merge.',
    );
  }

  // Contacts the survivor already holds under the same address. Not a
  // conflict: it is the same person, and their duplicate record is retired
  // rather than moved.
  const dupContacts = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM contacts m
        WHERE m.organization_id = ? AND m.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM contacts s
                       WHERE s.organization_id = ? AND s.deleted_at IS NULL
                         AND s.email = m.email)`,
    )
    .bind(mergedId, survivorId)
    .first<{ n: number }>();
  const contactsRetired = dupContacts?.n ?? 0;

  const reportDrafts = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM report_drafts
        WHERE organization_id = ? AND deleted_at IS NULL`,
    )
    .bind(mergedId)
    .first<{ n: number }>();

  const attachments = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM attachments
        WHERE organization_id = ? AND deleted_at IS NULL`,
    )
    .bind(mergedId)
    .first<{ n: number }>();

  const moves: MergeMoves = {
    applications: merged.applications,
    awards: merged.awards,
    reportDrafts: reportDrafts?.n ?? 0,
    contacts: merged.contacts - contactsRetired,
    contactsRetired,
    users: merged.users,
    attachments: attachments?.n ?? 0,
  };

  return { survivor, merged, moves, conflicts, ok: conflicts.length === 0 };
}

export interface MergeResult extends MergeMoves {
  survivorId: string;
  mergedId: string;
}

/**
 * Do it.
 *
 * ONE BATCH. A half-merged organization -- applications moved, awards not --
 * is worse than either state, and there is no way to tell from the data which
 * half ran. Everything re-points or nothing does.
 *
 * ORDER MATTERS INSIDE THE BATCH. Awards move before report drafts, because
 * `report_drafts.organization_id` is denormalized from the award and a trigger
 * refuses a draft whose organization does not match the award holding it.
 * Moving the draft first fires that trigger and takes the whole merge down.
 */
export async function applyMerge(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  survivorId: string,
  mergedId: string,
): Promise<MergeResult> {
  assertAdmin(session);

  const plan = await planMerge(db, session, survivorId, mergedId);
  if (!plan.ok) {
    throw new AppError('CONFLICT', plan.conflicts[0] ?? 'These records cannot be merged.', {
      internalMessage: `merge ${mergedId} -> ${survivorId} blocked: ${plan.conflicts.join(' ')}`,
      severity: 'warn',
      context: { conflicts: plan.conflicts },
    });
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    // A contact the survivor already has under the same address is the same
    // person. Retired rather than moved: moving it violates the unique index
    // on (organization_id, email), and keeping both would show an admin one
    // human twice.
    db
      .prepare(
        `UPDATE contacts SET deleted_at = ?, updated_at = ?
          WHERE organization_id = ? AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM contacts s
                         WHERE s.organization_id = ? AND s.deleted_at IS NULL
                           AND s.email = contacts.email)`,
      )
      .bind(now, now, mergedId, survivorId),
    db
      .prepare(
        `UPDATE contacts SET organization_id = ?, updated_at = ?
          WHERE organization_id = ? AND deleted_at IS NULL`,
      )
      .bind(survivorId, now, mergedId),
    db
      .prepare(
        `UPDATE users SET organization_id = ?, updated_at = ?
          WHERE organization_id = ? AND deleted_at IS NULL`,
      )
      .bind(survivorId, now, mergedId),
    db
      .prepare(
        `UPDATE applications SET organization_id = ?, updated_at = ?
          WHERE organization_id = ? AND deleted_at IS NULL`,
      )
      .bind(survivorId, now, mergedId),
    // Before report_drafts. See the note above.
    db
      .prepare(
        `UPDATE awards SET organization_id = ?, updated_at = ?
          WHERE organization_id = ? AND deleted_at IS NULL`,
      )
      .bind(survivorId, now, mergedId),
    db
      .prepare(
        `UPDATE report_drafts SET organization_id = ?
          WHERE organization_id = ? AND deleted_at IS NULL`,
      )
      .bind(survivorId, mergedId),
    db
      .prepare(`UPDATE attachments SET organization_id = ? WHERE organization_id = ?`)
      .bind(survivorId, mergedId),
    /*
     * The audit BEFORE the signpost, which is the opposite of the usual order
     * here and is forced by the guard.
     *
     * Statements in a batch run in sequence, so a guard reading
     * `status <> 'merged'` after the flip is always false and the audit row
     * never lands. Guarded on the same predicate, evaluated while it can still
     * be true, it lands exactly when the flip does.
     */
    auditStatement(db, ctx, {
      action: 'organization.merged',
      entityType: 'organization',
      entityId: mergedId,
      before: {
        legal_name: plan.merged.legalName,
        status: plan.merged.status,
        applications: plan.merged.applications,
        awards: plan.merged.awards,
      },
      after: {
        status: 'merged',
        merged_into_id: survivorId,
        survivor_legal_name: plan.survivor.legalName,
        moved: plan.moves,
      },
    // THE SAME GUARD as the signpost UPDATE it describes.
    //
    // It was missing, and the concurrency test caught it: on the losing side
    // of a simultaneous merge every mutation no-ops and an unguarded audit row
    // lands anyway, asserting a merge that did not happen. audit.ts states
    // this rule in its own comments -- an audit trail that records events that
    // did not occur is worse than none, because it is believed -- and this
    // file broke it.
    }, {
      guard: {
        sql: `(SELECT status FROM organizations WHERE id = ?) <> 'merged'`,
        binds: [mergedId],
      },
    }),
    // LAST: the loser becomes a signpost. The row stays, so an id held in an
    // old email or a spreadsheet still resolves to the survivor -- and its row
    // count is the authoritative answer about whether this call did anything.
    db
      .prepare(
        `UPDATE organizations SET status = 'merged', merged_into_id = ?, updated_at = ?
          WHERE id = ? AND status <> 'merged' AND deleted_at IS NULL`,
      )
      .bind(survivorId, now, mergedId),
  ];

  const results = await db.batch(statements);
  // The signpost UPDATE is last and is the authoritative one: if it changed
  // nothing, somebody else merged this organization between the plan and the
  // write.
  const flipped = results[results.length - 1]?.meta.changes ?? 0;
  if (flipped === 0) {
    throw new AppError('CONFLICT', 'That organization was already merged.', {
      internalMessage: `merge ${mergedId} -> ${survivorId} lost a race`,
      severity: 'warn',
    });
  }

  return { survivorId, mergedId, ...plan.moves };
}
