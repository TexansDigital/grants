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
/*
 * Say what was actually checked, not what was true when this line was written.
 * It read "production bindings still placeholders" long after the cutover
 * began filling them in -- a green line asserting something false, which is
 * the one thing a check must never do.
 */
console.log(
  'wrangler.toml OK: hostname surface pinned, production shares no resource with preview',
);
