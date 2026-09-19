import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { runBackup, listBackupTables, backupPrefix, scheduledBackup } from '../src/lib/backup';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env } from '../src/types';

/**
 * An in-memory R2, because the point of these tests is WHAT gets written, and
 * a real bucket would only add a network to the same assertions.
 */
function fakeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    put: async (key: string, body: string) => {
      objects.set(key, body);
      return {} as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

const envWith = (bucket: R2Bucket | undefined): Env =>
  ({ ...(testEnv as unknown as Env), BACKUPS: bucket });

const ctx = () => ctxFor(adminSession());
let n = 0;

async function someData() {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `bk-${++n}` });
  const now = nowIso();
  const orgId = newId();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, `Backed Up Org ${n}`, String(900000000 + n), now, now).run();
  return { programId: p.programId, organizationId: orgId };
}

// ---------------------------------------------------------------------------
describe('which tables get exported', () => {
  it('discovers them rather than reading a list somebody has to maintain', async () => {
    const tables = await listBackupTables(db);
    // Every table migration 0012 added, without this test or the exporter
    // naming them anywhere.
    for (const t of ['awards', 'report_periods', 'report_submissions', 'metric_values',
                     'applications', 'organizations', 'audit_log']) {
      expect(tables, t).toContain(t);
    }
  });

  it('leaves out the search index, which is derived', async () => {
    // The FTS index is rebuilt from applications at submit. Exporting it
    // stores a second copy of data already in the export, in a format only
    // FTS can read -- and a restore that loaded it would be restoring an index
    // rather than rebuilding one.
    const tables = await listBackupTables(db);
    expect(tables).not.toContain('application_fts');
    expect(tables.filter((t) => t.startsWith('application_fts_'))).toEqual([]);
  });

  it('leaves out the tables SQLite and Cloudflare own', async () => {
    const tables = await listBackupTables(db);
    expect(tables.filter((t) => t.startsWith('sqlite_') || t.startsWith('d1_'))).toEqual([]);
  });

  it('leaves out _cf_METADATA, which D1 lists and then refuses to read', async () => {
    /*
     * The one that actually bit. It appears in sqlite_master like any other
     * table, and SELECTing from it fails with
     * "access to _cf_METADATA.key is prohibited". Discovering tables rather
     * than listing them means meeting this, and without the exclusion every
     * nightly run would throw on it -- a backup that never runs, reported as
     * a failed cron nobody is watching yet.
     */
    const { results } = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\_cf\_%' ESCAPE '\\'`,
    ).all<{ name: string }>();
    expect((results ?? []).length, 'D1 still has internal _cf_ tables').toBeGreaterThan(0);
    expect(await listBackupTables(db)).not.toContain(results![0]!.name);
  });
});

// ---------------------------------------------------------------------------
describe('running the export', () => {
  it('writes one file per table, plus a manifest', async () => {
    await someData();
    const { bucket, objects } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());

    const tables = await listBackupTables(db);
    for (const t of tables) {
      expect(objects.has(`${manifest.prefix}/${t}.ndjson`), t).toBe(true);
    }
    expect(objects.has(`${manifest.prefix}/manifest.json`)).toBe(true);
  });

  it('writes NDJSON a restore can actually read', async () => {
    const d = await someData();
    const { bucket, objects } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());

    const body = objects.get(`${manifest.prefix}/organizations.ndjson`)!;
    const lines = body.trimEnd().split('\n');
    const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const mine = rows.find((r) => r.id === d.organizationId);
    expect(mine, 'the organization is in the export').toBeDefined();
    expect(mine!.legal_name).toMatch(/^Backed Up Org/);
    // rowid is an implementation detail of the paging, not data.
    expect(Object.keys(mine!)).not.toContain('__rowid');
  });

  it('counts rows so a restore has something to check itself against', async () => {
    await someData();
    const { bucket } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());

    const actual = await db.prepare(`SELECT COUNT(*) AS n FROM organizations`)
      .first<{ n: number }>();
    const entry = manifest.tables.find((t) => t.table === 'organizations')!;
    expect(entry.rows).toBe(actual!.n);
    expect(manifest.totalRows).toBe(manifest.tables.reduce((s, t) => s + t.rows, 0));
  });

  it('says in the manifest that it has never been restored', async () => {
    // A backup nobody has restored is a hypothesis. The file says so, so
    // somebody reading one in an emergency is not surprised by it.
    const { bucket, objects } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());
    expect(manifest.note).toMatch(/not a verified backup/i);
    expect(objects.get(`${manifest.prefix}/manifest.json`)).toMatch(/not a verified backup/i);
  });

  it('records the schema version the export fits', async () => {
    const { bucket } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());
    // A restore into the wrong schema is the failure this prevents.
    expect(manifest.schemaVersion).toMatch(/^0012_/);
  });

  it('writes a stable latest.json, so "did it run" is one read', async () => {
    const { bucket, objects } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());
    const latest = JSON.parse(objects.get('d1/latest.json')!) as { prefix: string };
    expect(latest.prefix).toBe(manifest.prefix);
  });

  it('audits the export', async () => {
    const { bucket } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());
    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='data.exported' AND entity_id=?`,
    ).bind(manifest.prefix).first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it('exports an empty table as an empty file, not a missing one', async () => {
    // A missing file is indistinguishable from a failed export. An empty one
    // says "this table had nothing in it", which is different.
    const { bucket, objects } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());
    const empty = manifest.tables.find((t) => t.rows === 0);
    expect(empty, 'some table is empty in a fresh database').toBeDefined();
    expect(objects.get(empty!.key)).toBe('');
  });

  it('pages through more rows than fit in one read', async () => {
    // PAGE_SIZE is 500. Paging by rowid rather than OFFSET is what stops a
    // row being skipped when something is written mid-export.
    const now = nowIso();
    const stmts = Array.from({ length: 1200 }, (_, i) =>
      db.prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?,'active',?,?)`,
      ).bind(newId(), `Bulk ${i}`, String(910000000 + i), now, now));
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));

    const { bucket, objects } = fakeBucket();
    const manifest = await runBackup(envWith(bucket), ctx());
    const entry = manifest.tables.find((t) => t.table === 'organizations')!;
    const actual = await db.prepare(`SELECT COUNT(*) AS n FROM organizations`)
      .first<{ n: number }>();
    expect(entry.rows).toBe(actual!.n);
    // Well past PAGE_SIZE (500), so at least three reads were needed.
    expect(entry.rows).toBeGreaterThanOrEqual(1200);
    // Every row, once.
    const lines = objects.get(entry.key)!.trimEnd().split('\n');
    expect(lines).toHaveLength(entry.rows);
    expect(new Set(lines.map((l) => (JSON.parse(l) as { id: string }).id)).size).toBe(entry.rows);
  });
});

// ---------------------------------------------------------------------------
describe('when it goes wrong', () => {
  it('refuses to pretend it ran with no bucket bound', async () => {
    await expect(runBackup(envWith(undefined), ctx())).rejects.toThrow(/not bound/i);
  });

  it('rethrows, so Cloudflare records the run as failed', async () => {
    // A cron that swallows its own errors is a backup everybody believes in
    // and nobody has. The scheduled record is the only signal anyone sees.
    await expect(scheduledBackup(envWith(undefined), ctx())).rejects.toThrow();
    const logged = await db.prepare(
      `SELECT severity FROM error_log WHERE code='BACKUP_FAILED' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ severity: string }>();
    expect(logged!.severity).toBe('fatal');
  });
});

// ---------------------------------------------------------------------------
describe('where the files land', () => {
  it('sorts chronologically as plain text', async () => {
    // So a bucket listing is in order without anybody parsing a date.
    const a = backupPrefix(new Date('2026-09-09T04:07:11.000Z'));
    const b = backupPrefix(new Date('2026-09-19T04:07:11.000Z'));
    const c = backupPrefix(new Date('2026-09-19T23:59:59.000Z'));
    expect(a).toBe('d1/2026-09-09/040711');
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });
});
