/**
 * Guard wrangler.toml against silent misconfiguration.
 *
 *   npm run check:config
 *
 * The checks live in src/lib/configCheck.ts so the test suite can exercise
 * them. This file is only the CLI around them.
 */
import { readFileSync } from 'node:fs';
import { configProblems } from '../src/lib/configCheck';

const problems = configProblems(readFileSync('wrangler.toml', 'utf8'));

if (problems.length > 0) {
  console.error('wrangler.toml problems:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('wrangler.toml OK: hostname surface pinned, production bindings still placeholders');
