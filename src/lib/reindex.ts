/**
 * Rebuild the full-text index from the applications table.
 *
 * WHY THIS EXISTS. Until now, an application entered `application_fts` at
 * exactly one moment: submit. There was no other path, which meant the index
 * could not be rebuilt at all -- and a restore drill is what made that
 * visible.
 *
 * The export deliberately skips virtual tables and their shadow tables, so a
 * restored database has an EMPTY `application_fts`. It does not have an empty
 * `application_search_state`: that is an ordinary table, it restores fine, and
 * it says every application is indexed. So after a restore, search returns
 * nothing, reports itself up to date, and nothing in the system would ever
 * rebuild it. "Have we ever funded youth mental health in Fort Bend County"
 * would answer no, forever, and look like it had checked.
 *
 * WHAT IT REBUILDS. Every SUBMITTED application -- the same set submit indexes,
 * for the same reason: a draft is not findable until its author says it is
 * finished. Drafts are skipped rather than excluded by a filter somebody has
 * to remember, and a draft's stale index entry, if one exists, is removed.
 *
 * IDEMPOTENT. It rebuilds each application from what is stored now, so running
 * it twice produces the same index, and running it on a healthy database is a
 * no-op in effect. That matters because the only person who will ever run it
 * is someone in the middle of a bad day.
 */

import type { RequestContext } from '../types';
import { buildSearchDoc, reindexStatements } from './search';
import { loadStoredAnswers } from './submit';
import { loadFormDefinition } from './loadForm';
import { allFields } from './forms';
import { promote } from './mapsTo';
import { writeAudit } from './audit';
import { nowIso } from './time';

export interface ReindexResult {
  /** Applications examined. */
  considered: number;
  /** Applications written into the index. */
  indexed: number;
  /** Applications whose stale index entries were removed. */
  cleared: number;
  /** Ids that could not be rebuilt, with why. Never silently dropped. */
  failed: { applicationId: string; reason: string }[];
}

/**
 * One batch per application rather than one enormous one.
 *
 * A single batch would be atomic across the whole rebuild, which sounds better
 * and is not: a rebuild that fails on application 400 of 400 and rolls back
 * the other 399 leaves the operator exactly where they started, with no way to
 * make progress except to fix the one bad row first. Per-application batches
 * mean a partial rebuild is still a rebuild, and `failed` names what is left.
 */
export async function reindexAllApplications(
  db: D1Database,
  ctx: RequestContext,
): Promise<ReindexResult> {
  const { results } = await db
    .prepare(
      `SELECT id, status, form_definition_id
         FROM applications
        WHERE deleted_at IS NULL
        ORDER BY created_at`,
    )
    .all<{ id: string; status: string; form_definition_id: string }>();

  const rows = results ?? [];
  const result: ReindexResult = { considered: rows.length, indexed: 0, cleared: 0, failed: [] };
  const at = nowIso();

  // Form definitions repeat across applications and loading one is several
  // queries; at 400 applications and a handful of forms this is the difference
  // between a rebuild that takes a moment and one that takes minutes.
  const definitions = new Map<string, Awaited<ReturnType<typeof loadFormDefinition>>>();

  for (const row of rows) {
    if (row.status === 'draft') {
      // Not an error and not indexed. Any entry from an earlier life -- an
      // application sent back to draft, say -- must not linger as a hit.
      const before = await db
        .prepare(`SELECT COUNT(*) AS n FROM application_fts WHERE application_id = ?`)
        .bind(row.id)
        .first<{ n: number }>();
      if ((before?.n ?? 0) > 0) {
        await db.batch([
          db.prepare(`DELETE FROM application_fts WHERE application_id = ?`).bind(row.id),
          db.prepare(`DELETE FROM application_search_state WHERE application_id = ?`).bind(row.id),
        ]);
        result.cleared += 1;
      }
      continue;
    }

    try {
      let definition = definitions.get(row.form_definition_id);
      if (!definition) {
        definition = await loadFormDefinition(db, row.form_definition_id);
        definitions.set(row.form_definition_id, definition);
      }
      const answers = await loadStoredAnswers(db, row.id);
      const promoted = promote(allFields(definition), answers);
      const doc = buildSearchDoc({
        applicationId: row.id,
        definition,
        answers,
        promoted: promoted.application,
      });
      // No guard: submit's guard exists to lose a race against a concurrent
      // submit, and this runs against applications that are already submitted.
      await db.batch(reindexStatements(db, doc, at));
      result.indexed += 1;
    } catch (e) {
      result.failed.push({
        applicationId: row.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await writeAudit(db, ctx, {
    action: 'search.reindexed',
    entityType: 'search_index',
    entityId: 'application_fts',
    after: {
      considered: result.considered,
      indexed: result.indexed,
      cleared: result.cleared,
      failed: result.failed.length,
    },
  });

  return result;
}
