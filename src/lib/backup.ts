/**
 * The scheduled D1 export.
 *
 * WHY THIS EXISTS. D1's Time Travel is disaster recovery, not backup: it
 * restores a database to a point in time, in place, within a 30-day window,
 * and it is gone if the database is. It cannot answer "what did this row say
 * last March", cannot be read without Cloudflare, and cannot survive the
 * account it lives in. CLAUDE.md is explicit that a scheduled export to R2 is
 * required, and requires it BEFORE the public form holds real data.
 *
 * WHAT THIS IS NOT, and must never be reported as. It is an EXPORT. A backup
 * you have never restored is a hypothesis, and nothing here has ever been
 * restored into an empty database. The manifest exists to make that test
 * possible -- row counts a restore can check itself against -- but performing
 * it is a human step that has not happened.
 *
 * TABLES ARE DISCOVERED, NOT LISTED. A hand-maintained list is a list that
 * silently stops covering the tables a later migration adds, and nobody finds
 * out until the restore. Reading sqlite_master means migration 0013's tables
 * are in tomorrow's export without anyone remembering.
 */

import type { Env, RequestContext } from '../types';
import { logError } from './errors';
import { writeAudit } from './audit';

/**
 * Rows per read. Small enough that no single response is large, and the whole
 * database is a few hundred rows a year -- this is about not assuming that
 * stays true, rather than about present volume.
 */
const PAGE_SIZE = 500;

/** How many rows a single table may contribute before the export gives up. */
const MAX_ROWS_PER_TABLE = 500_000;

export interface TableExport {
  table: string;
  rows: number;
  key: string;
  bytes: number;
}

export interface BackupManifest {
  startedAt: string;
  finishedAt: string;
  /** The prefix every file in this export shares. */
  prefix: string;
  tables: TableExport[];
  totalRows: number;
  /** Highest applied migration, so a restore knows which schema this fits. */
  schemaVersion: string | null;
  /** Stated in the manifest itself so nobody reads one and assumes otherwise. */
  note: string;
}

/**
 * Tables worth exporting.
 *
 * Excluded, deliberately:
 *   - `sqlite_%`, which SQLite owns.
 *   - `d1_%`, which Cloudflare owns, including the migrations bookkeeping --
 *     its content is captured in the manifest instead.
 *   - `_cf_%`, which Cloudflare also owns and which is the interesting one:
 *     `_cf_METADATA` is listed in sqlite_master and then REFUSES to be read
 *     ("access to _cf_METADATA.key is prohibited"). Discovering tables rather
 *     than listing them means meeting this, and a nightly job that throws on
 *     a table it was never meant to touch is a backup that never runs. Found
 *     by a test on the first run, which is the argument for having one.
 *   - FTS5 virtual tables and their shadow tables (`_data`, `_idx`, `_docsize`,
 *     `_config`, `_content`). They are DERIVED: the search index is rebuilt
 *     from applications at submit, so exporting it stores a second copy of
 *     data already in the export, in a format only FTS can read, and a restore
 *     that loaded it would be restoring an index rather than rebuilding one.
 */
export async function listBackupTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE 'd1_%'
          AND name NOT LIKE '\_cf\_%' ESCAPE '\\'
        ORDER BY name`,
    )
    .all<{ name: string; sql: string | null }>();

  const all = results ?? [];
  const virtualNames = new Set(
    all.filter((t) => /CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? '')).map((t) => t.name),
  );
  const isShadow = (name: string) =>
    [...virtualNames].some((v) => name.startsWith(`${v}_`));

  return all
    .map((t) => t.name)
    .filter((name) => !virtualNames.has(name) && !isShadow(name));
}

/** `2026-09-19T04:07:11.123Z` -> `2026-09-19/040711`. Sorts correctly as text. */
export function backupPrefix(now: Date): string {
  const iso = now.toISOString();
  return `d1/${iso.slice(0, 10)}/${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * Export one table as NDJSON.
 *
 * NDJSON rather than SQL: it is diffable, streamable, and readable by anything,
 * and it does not embed assumptions about the schema it will be loaded into.
 * A restore builds its own INSERTs from it, against whatever the schema is
 * then -- which is the situation a restore is actually in.
 *
 * Ordered by rowid and paged by it rather than by OFFSET. OFFSET re-walks the
 * table for every page and, worse, silently skips rows if anything is written
 * mid-export -- which is exactly what a nightly job racing a late submission
 * would do.
 */
async function exportTable(
  db: D1Database,
  bucket: R2Bucket,
  table: string,
  prefix: string,
): Promise<TableExport> {
  const parts: string[] = [];
  let rows = 0;
  let afterRowid = 0;

  for (;;) {
    const { results } = await db
      .prepare(
        // The table name comes from sqlite_master, never from a request, and
        // is the only interpolation here.
        `SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .bind(afterRowid, PAGE_SIZE)
      .all<Record<string, unknown>>();

    const page = results ?? [];
    if (page.length === 0) break;

    for (const row of page) {
      const rowid = row.__rowid as number;
      delete row.__rowid;
      parts.push(JSON.stringify(row));
      afterRowid = rowid;
    }
    rows += page.length;

    if (rows > MAX_ROWS_PER_TABLE) {
      throw new Error(
        `table ${table} exceeded ${MAX_ROWS_PER_TABLE} rows; the export needs a streaming rewrite`,
      );
    }
    if (page.length < PAGE_SIZE) break;
  }

  const body = parts.length > 0 ? `${parts.join('\n')}\n` : '';
  const key = `${prefix}/${table}.ndjson`;
  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/x-ndjson' },
  });

  return { table, rows, key, bytes: new TextEncoder().encode(body).length };
}

/**
 * Run the export.
 *
 * THROWS on failure, after logging. A cron that swallows its own errors is a
 * backup everybody believes in and nobody has: Cloudflare records a scheduled
 * run as failed only if the handler rejects, and that record is the only
 * signal anyone will ever see.
 */
export async function runBackup(env: Env, ctx: RequestContext, now = new Date()): Promise<BackupManifest> {
  const bucket = env.BACKUPS;
  if (!bucket) {
    throw new Error('BACKUPS bucket is not bound; the scheduled export cannot run');
  }

  const startedAt = now.toISOString();
  const prefix = backupPrefix(now);
  const tables = await listBackupTables(env.DB);
  const exported: TableExport[] = [];

  for (const table of tables) {
    exported.push(await exportTable(env.DB, bucket, table, prefix));
  }

  const schemaVersion = await env.DB.prepare(
    `SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`,
  )
    .first<{ name: string }>()
    .then((r) => r?.name ?? null)
    .catch(() => null);

  const manifest: BackupManifest = {
    startedAt,
    finishedAt: new Date().toISOString(),
    prefix,
    tables: exported,
    totalRows: exported.reduce((n, t) => n + t.rows, 0),
    schemaVersion,
    note:
      'This is an export, not a verified backup. It has not been restored into an empty ' +
      'database. Check a restore against the row counts above before relying on it.',
  };

  await bucket.put(`${prefix}/manifest.json`, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  // A stable key, so "did last night's backup run" is one read rather than a
  // listing sorted by hand.
  await bucket.put('d1/latest.json', JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  await writeAudit(env.DB, ctx, {
    action: 'data.exported',
    entityType: 'export',
    entityId: prefix,
    after: {
      tables: exported.length,
      total_rows: manifest.totalRows,
      schema_version: schemaVersion,
    },
  });

  return manifest;
}

/** The scheduled entry point. Logs, then rethrows so the run is recorded failed. */
export async function scheduledBackup(env: Env, ctx: RequestContext): Promise<void> {
  try {
    const manifest = await runBackup(env, ctx);
    console.log(
      `d1 export ${manifest.prefix}: ${manifest.tables.length} tables, ${manifest.totalRows} rows`,
    );
  } catch (err) {
    await logError(env, ctx, {
      code: 'BACKUP_FAILED',
      severity: 'fatal',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? (err.stack ?? null) : null,
    });
    throw err;
  }
}
