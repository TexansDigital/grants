/**
 * Generate the seed artifact.
 *
 *   npm run seed:build
 *
 * Bundled with esbuild before running: the src/ modules use extensionless
 * imports, which Node's ESM resolver does not accept on its own.
 *
 * Writes seeds/<slug>.sql. The file is checked in so a seed can be reviewed as
 * a diff before anyone applies it to a database.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { emitSeedSql } from '../src/seed/emitSql';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';

const programs = [INSPIRE_CHANGE];

mkdirSync('seeds', { recursive: true });
for (const spec of programs) {
  const sql = await emitSeedSql(spec, { now: '2026-01-01T00:00:00.000Z' });
  const path = `seeds/${spec.slug}.sql`;
  writeFileSync(path, sql, 'utf8');
  const statements = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--')).length;
  console.log(`${path}: ${statements} statements, ${sql.length} bytes`);
}
