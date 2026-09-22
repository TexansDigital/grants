/**
 * Restore a nightly export into an empty database, and prove it worked.
 *
 *   npm run restore -- --from=./export-dir
 *   npm run restore -- --from=./export-dir --database=steward-preview --remote
 *
 * WHY THIS EXISTS. CLAUDE.md: "Time Travel is disaster recovery, not backup.
 * Scheduled export to R2 is required." The export has run nightly for weeks
 * and backup.ts says so in its own header: "A backup you have never restored
 * is a hypothesis, and nothing here has ever been restored into an empty
 * database." This is the other half. Until it is run against a real export,
 * the hypothesis stands.
 *
 * WHAT IT DOES
 *   1. Reads manifest.json and every <table>.ndjson beside it.
 *   2. Applies every migration to the target database, in order.
 *   3. Drops the schema's triggers, loads the rows, puts the triggers back.
 *   4. Counts what landed and compares it to the manifest, table by table.
 *
 * WHY STEP 3 IS NOT A SHORTCUT. This schema defends itself with triggers: a
 * published form definition is immutable (0003), an awarded amount cannot
 * change without an amendment (0024), a field key may not name an internal
 * column (0026). Every one of those is correct for a live system and every
 * one of them refuses rows that were legitimately written before it, in the
 * order a restore has to write them. A restore is not a user; it is putting
 * back what the database itself produced. The triggers come back before
 * anything else can touch it, and the script fails loudly if it cannot
 * restore one.
 *
 * WHAT IT REFUSES. Any database whose name mentions production, with no
 * override flag, because there is no version of this script that should be
 * pointed at the real one. CLAUDE.md, non-negotiable 2.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const FROM = args.from;
const DATABASE = args.database ?? 'steward-preview';
const REMOTE = args.remote === true;
/*
 * A SEPARATE STATE DIRECTORY, which is what makes this a drill rather than a
 * gamble. Without it, "restore into an empty database" means wiping the
 * database you develop against. --persist-to hands wrangler somewhere else to
 * keep the local D1 entirely.
 */
const PERSIST = typeof args['persist-to'] === 'string' ? args['persist-to'] : null;

if (!FROM) {
  console.error('usage: npm run restore -- --from=<directory holding manifest.json>');
  process.exit(2);
}
if (/prod/i.test(String(DATABASE))) {
  console.error(
    `refusing to restore into "${DATABASE}".\n` +
      'CLAUDE.md: never write to the production database. There is no flag for this.',
  );
  process.exit(2);
}

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
};

function wrangler(argv, opts = {}) {
  return execFileSync('npx', ['wrangler', ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}
const scope = () => (REMOTE ? ['--remote'] : ['--local', ...(PERSIST ? [`--persist-to=${PERSIST}`] : [])]);

function query(sqlText) {
  const out = wrangler(['d1', 'execute', DATABASE, ...scope(), '--json', '--command', sqlText]);
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

function runFile(path) {
  wrangler(['d1', 'execute', DATABASE, ...scope(), '--file', path]);
}

/**
 * One SQL literal.
 *
 * Throws on anything it was not built for rather than guessing. A restore
 * that silently coerces a value it did not recognise is how a financial
 * record comes back subtly wrong, which is worse than one that does not come
 * back at all.
 */
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`cannot restore a non-finite number: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`cannot restore a value of type ${typeof v}: ${JSON.stringify(v).slice(0, 80)}`);
}

console.log(`Steward — restore drill into ${DATABASE} (${REMOTE ? 'remote' : 'local'})`);
if (PERSIST) console.log(`      state: ${PERSIST}`);
console.log('');

// --- read the export --------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(FROM, 'manifest.json'), 'utf8'));
console.log(`      export prefix: ${manifest.prefix}`);
console.log(`      taken:         ${manifest.startedAt}`);
console.log(`      schema:        ${manifest.schemaVersion ?? 'unknown'}`);
console.log(`      claims:        ${manifest.totalRows} rows across ${manifest.tables.length} tables\n`);

const onDisk = new Set(readdirSync(FROM).filter((f) => f.endsWith('.ndjson')));
const expected = new Set(manifest.tables.map((t) => `${t.table}.ndjson`));
check('every table the manifest names has a file',
  [...expected].filter((f) => !onDisk.has(f)), []);
check('and no file is present that the manifest does not name',
  [...onDisk].filter((f) => !expected.has(f)), []);

/*
 * THE SCHEMA VERSION IS CHECKED, NOT ASSUMED.
 *
 * Restoring January's export into September's schema is a real situation and
 * not always wrong -- but it is never something to discover afterwards from a
 * column that did not exist yet. Named here, before anything is written.
 */
const migrations = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
const newest = migrations[migrations.length - 1];
if (manifest.schemaVersion && manifest.schemaVersion !== newest) {
  console.log(
    `\n      NOTE: this export was taken at ${manifest.schemaVersion}, and the repository is\n` +
      `      now at ${newest}. The restore below applies EVERY migration, so the rows land\n` +
      '      in the newer schema. Columns added since are NULL. Say so in any report.\n',
  );
}

// --- build the schema -------------------------------------------------------
console.log('\n  Building the schema:\n');
const before = query(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`);
if (Number(before[0]?.n ?? 0) > 1) {
  console.log(
    `      the target already holds ${before[0].n} tables. A restore drill means an EMPTY\n` +
      '      database. Pass --persist-to=<a fresh directory> for a clean local one.',
  );
  failures += 1;
} else {
  wrangler(['d1', 'migrations', 'apply', DATABASE, ...scope()], { stdio: ['ignore', 'inherit', 'pipe'] });
}

// --- take the triggers off --------------------------------------------------
const triggers = query(
  `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL`,
);
console.log(`\n  Setting aside ${triggers.length} triggers so the rows can go back in.\n`);
const tmp = mkdtempSync(join(tmpdir(), 'steward-restore-'));
if (triggers.length > 0) {
  const dropFile = join(tmp, '00-drop-triggers.sql');
  writeFileSync(dropFile, triggers.map((t) => `DROP TRIGGER "${t.name}";`).join('\n'));
  runFile(dropFile);
}

// --- load -------------------------------------------------------------------
/*
 * TABLES THE RESTORE DELIBERATELY DOES NOT LOAD.
 *
 * `application_search_state` is the record of WHAT HAS BEEN INDEXED, and the
 * index itself -- `application_fts` -- is a virtual table the export
 * deliberately skips. Restoring the bookkeeping without the index produces a
 * search that finds nothing and reports itself perfectly up to date, which is
 * worse than one that is visibly empty. Left out here so the rebuild below
 * has something to do.
 *
 * Found by running this drill, not by reading the code.
 */
const NOT_RESTORED = new Set(['application_search_state']);

console.log('  Loading:\n');
/*
 * ONE FILE, ONE TRANSACTION, and this is the correction the first drill
 * forced.
 *
 * The first version wrote a file per table with `PRAGMA defer_foreign_keys`
 * at the top of each, and every table with a parent failed. Deferred foreign
 * keys are checked AT COMMIT, and a file per table means a commit per table
 * -- so every child was checked while its parent was still two files away.
 * Deferral only helps if the whole restore is one transaction.
 *
 * The cost is that a failure names the statement rather than the table, which
 * is why the rows are still one INSERT each.
 */
const statements = [];
const skipped = [];
for (const entry of manifest.tables) {
  if (NOT_RESTORED.has(entry.table)) {
    skipped.push(entry.table);
    continue;
  }
  const text = readFileSync(join(FROM, `${entry.table}.ndjson`), 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    console.log(`      ${entry.table}: empty`);
    continue;
  }
  const rows = lines.map((l) => JSON.parse(l));
  const columns = Object.keys(rows[0]);
  /*
   * DELETE FIRST. "An empty database" is not empty: migrations seed reference
   * data -- field_types, promotion_targets -- and the first drill failed on a
   * UNIQUE violation against rows a migration had just written. The export's
   * copy is the one that should win, so the seeded rows come out and the
   * exported ones go in.
   */
  statements.push(`DELETE FROM "${entry.table}";`);
  for (const r of rows) {
    statements.push(
      `INSERT INTO "${entry.table}" (${columns.map((c) => `"${c}"`).join(',')}) ` +
        `VALUES (${columns.map((c) => literal(r[c])).join(',')});`,
    );
  }
  console.log(`      ${entry.table}: ${rows.length}`);
}
for (const t of skipped) console.log(`      ${t}: SKIPPED on purpose (see NOT_RESTORED)`);

const loadFile = join(tmp, '10-load.sql');
writeFileSync(loadFile, `PRAGMA defer_foreign_keys = true;\n${statements.join('\n')}\n`);
let loaded = 0;
try {
  runFile(loadFile);
  loaded = manifest.tables
    .filter((t) => !NOT_RESTORED.has(t.table))
    .reduce((n, t) => n + t.rows, 0);
} catch (e) {
  failures += 1;
  const out = `${String(e.stderr ?? '')}\n${String(e.stdout ?? '')}`
    .split('\n')
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((l) => l && !/wrangler 4\.|^─+$|Resource location|Use --remote|Executing on|To execute on|Proxy environment/.test(l))
    .slice(0, 8)
    .join('\n        ');
  console.log(`\n      THE LOAD FAILED:\n        ${out}`);
  console.log(`\n      The statements are in ${loadFile} if you need to find the row.`);
}

// --- put the triggers back --------------------------------------------------
console.log(`\n  Restoring ${triggers.length} triggers.\n`);
const restoredTriggers = [];
for (const t of triggers) {
  const file = join(tmp, `zz-${t.name}.sql`);
  writeFileSync(file, `${t.sql};`);
  try {
    runFile(file);
    restoredTriggers.push(t.name);
  } catch (e) {
    failures += 1;
    console.log(`      could not restore trigger ${t.name}: ${String(e.stdout ?? e.message).slice(0, 200)}`);
  }
}
check('every trigger is back on', restoredTriggers.length, triggers.length);

// --- prove it ---------------------------------------------------------------
console.log('\n  Checking what landed against the manifest:\n');
const counts = {};
for (const entry of manifest.tables) {
  const n = query(`SELECT COUNT(*) AS n FROM "${entry.table}"`);
  counts[entry.table] = Number(n[0]?.n ?? -1);
}
const claimed = Object.fromEntries(
  manifest.tables.filter((t) => !NOT_RESTORED.has(t.table)).map((t) => [t.table, t.rows]),
);
const mismatched = Object.entries(claimed).filter(([t, n]) => counts[t] !== n);
check('every table holds exactly what the manifest claimed',
  Object.fromEntries(mismatched.map(([t, n]) => [t, { manifest: n, restored: counts[t] }])), {});
/*
 * The manifest's total counts everything the export wrote, including the rows
 * this restore deliberately leaves out. Comparing against it raw reported a
 * two-row shortfall that was the script working as designed -- so the skipped
 * rows are subtracted and named, rather than the check being loosened.
 */
const skippedRows = manifest.tables
  .filter((t) => NOT_RESTORED.has(t.table))
  .reduce((n, t) => n + t.rows, 0);
check('and the totals agree, once the deliberate skips are taken off',
  loaded, manifest.totalRows - skippedRows);
if (skippedRows > 0) {
  console.log(`      (${skippedRows} rows in ${[...NOT_RESTORED].join(', ')} were not restored, on purpose)`);
}

/*
 * FOREIGN KEYS, CHECKED AFTER THE FACT.
 *
 * They were deferred for the load, so nothing was enforced while the rows
 * went in. A restore that satisfies the row counts and leaves a dangling
 * reference is not a restore, and this is the only point at which anyone
 * would find out.
 */
const violations = query(`PRAGMA foreign_key_check`);
check('no dangling references', violations.length, 0);

/*
 * THE SEARCH INDEX IS EMPTY, AND SAYING SO IS THE POINT.
 *
 * This is the finding this drill produced. It is not fixed by restoring more
 * bytes -- the index is a virtual table the export cannot carry -- and until
 * somebody rebuilds it, staff search answers "no results" to every question
 * while looking like it checked. POST /api/search/reindex exists for exactly
 * this moment.
 */
const indexed = query(`SELECT COUNT(*) AS n FROM application_fts`);
const submitted = query(
  `SELECT COUNT(*) AS n FROM applications WHERE status <> 'draft' AND deleted_at IS NULL`,
);
console.log('');
if (Number(submitted[0]?.n ?? 0) > 0) {
  console.log(
    `      SEARCH IS NOT RESTORED. ${submitted[0].n} submitted applications, ` +
      `${indexed[0]?.n ?? 0} indexed.\n` +
      '      Rebuild it before anyone trusts a search result:\n' +
      '        curl -X POST <host>/api/search/reindex   (admin, behind Access)',
  );
}

console.log(`\n${failures === 0 ? 'Restore verified.' : `${failures} CHECK(S) FAILED.`}`);
console.log('');
console.log('What this establishes: these bytes, from this export, reconstruct a database');
console.log('whose row counts match the manifest and whose foreign keys resolve.');
console.log('');
console.log('What it does NOT establish: that the rows are CORRECT. Row counts and foreign');
console.log("keys agree with an export that was wrong in its values too. And a drill run");
console.log('against a fixture proves the script works, not that the real nightly export is');
console.log('restorable — that needs a real export, pulled from R2, run through this.');
process.exit(failures === 0 ? 0 : 1);
