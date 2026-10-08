/**
 * The generated production-apply files must still match their migrations.
 *
 * A file in scripts/sql/apply-NNNN.sql is a COPY of a migration with its
 * statements made idempotent and its ledger row appended. A copy drifts: edit
 * the migration, forget the copy, and production gets the old schema while
 * `npm run golive` reports the ledger as satisfied -- a disagreement nothing
 * else in this project would notice.
 *
 * So this regenerates each one and compares. It is the same reasoning as
 * check:css and check:commands: the mistake is easy, silent, and mechanically
 * detectable.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApply } from './buildMigrationApply.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'scripts', 'sql');

const applies = readdirSync(dir).filter((f) => /^apply-\d{4}\.sql$/.test(f));
const problems = [];

for (const f of applies) {
  const number = f.slice('apply-'.length, 'apply-'.length + 4);
  const onDisk = readFileSync(join(dir, f), 'utf8');
  let expected;
  try {
    expected = buildApply(number);
  } catch (e) {
    problems.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  if (onDisk !== expected) {
    problems.push(
      `${f} no longer matches migrations/${number}_*.sql.\n` +
        `    Re-generate:  node scripts/buildMigrationApply.mjs ${number}`,
    );
  }
}

if (problems.length > 0) {
  console.error(`check:migration-apply — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(`check:migration-apply — ok, ${applies.length} generated file(s) match.`);
