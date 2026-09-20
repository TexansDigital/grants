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
import { SECOND_PROGRAM } from '../src/seed/secondProgram';

/*
 * SECOND_PROGRAM was written as the Phase 0 proof -- deliberately dissimilar to
 * Inspire Change, used by the test suite to show that adding a program needs no
 * migration. It is emitted here as well so it can be APPLIED, which is what
 * makes it useful as a place to put fixtures: anything invented goes in this
 * program and never in the real one.
 *
 * Its only cycle is status 'draft', so it cannot appear on the public
 * open-cycles page. A fabricated grant programme advertised to nonprofits
 * would be a genuinely bad outcome, and that is the line stopping it.
 */
const programs = [INSPIRE_CHANGE, SECOND_PROGRAM];

mkdirSync('seeds', { recursive: true });
for (const spec of programs) {
  const sql = await emitSeedSql(spec, { now: '2026-01-01T00:00:00.000Z' });
  const path = `seeds/${spec.slug}.sql`;
  writeFileSync(path, sql, 'utf8');
  const statements = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--')).length;
  console.log(`${path}: ${statements} statements, ${sql.length} bytes`);
}
