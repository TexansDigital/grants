/**
 * Pull one nightly export out of R2 onto disk, so it can be restored.
 *
 *   npm run backup:pull -- --out=./export            (local R2, from wrangler dev)
 *   npm run backup:pull -- --out=./export --remote   (the real preview bucket)
 *   npm run backup:pull -- --out=./export --remote --prefix=d1/2026-09-21
 *
 * WHY A SCRIPT. A restore drill needs the bytes the nightly job actually
 * wrote, not bytes reconstructed from the live database -- reconstructing
 * them would test the reconstruction and nothing else. With no --prefix it
 * reads d1/latest.json, which runBackup keeps pointed at the most recent
 * export precisely so "which one is current" is a read rather than a listing
 * sorted by hand.
 *
 * READ-ONLY. It gets objects and writes them locally. Nothing here puts,
 * deletes, or touches a database.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const OUT = args.out ?? './export';
const REMOTE = args.remote === true;
const BUCKET = args.bucket ?? 'steward-preview-backups';

if (/prod/i.test(String(BUCKET))) {
  console.error(`refusing to read "${BUCKET}". CLAUDE.md: preview bindings only.`);
  process.exit(2);
}

function get(key, dest) {
  execFileSync(
    'npx',
    ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`,
     `--file=${dest}`, REMOTE ? '--remote' : '--local'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
}

mkdirSync(OUT, { recursive: true });
console.log(`Steward — pulling an export from ${BUCKET} (${REMOTE ? 'remote' : 'local'})\n`);

const prefix = args.prefix;
const manifestKey = prefix ? `${prefix}/manifest.json` : 'd1/latest.json';
get(manifestKey, join(OUT, 'manifest.json'));
const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
console.log(`      prefix:  ${manifest.prefix}`);
console.log(`      taken:   ${manifest.startedAt}`);
console.log(`      schema:  ${manifest.schemaVersion ?? 'unknown'}`);
console.log(`      claims:  ${manifest.totalRows} rows across ${manifest.tables.length} tables\n`);

let pulled = 0;
for (const entry of manifest.tables) {
  const dest = join(OUT, `${entry.table}.ndjson`);
  try {
    get(entry.key, dest);
    // An export writes an empty file for an empty table, and `r2 object get`
    // is content with that -- so a missing file and an empty one have to be
    // told apart here rather than at restore time.
    if (!existsSync(dest)) throw new Error('no file written');
    pulled += 1;
    console.log(`      ${entry.table}  (${entry.rows} rows, ${entry.bytes} bytes)`);
  } catch (e) {
    console.log(`      ${entry.table}  FAILED: ${String(e.stdout ?? e.message).slice(0, 160)}`);
  }
}

console.log(`\n${pulled === manifest.tables.length ? 'Complete.' : 'INCOMPLETE — see above.'}`);
console.log(`\nNext:  npm run restore -- --from=${OUT} --persist-to=/tmp/steward-drill`);
process.exit(pulled === manifest.tables.length ? 0 : 1);
