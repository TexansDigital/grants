/**
 * Guard the stylesheets against reading custom properties nothing defines.
 *
 *   npm run check:css
 *
 * The checks live in src/lib/cssCheck.ts so the test suite can exercise them;
 * this file is only the CLI around them.
 *
 * NOT A VITEST TEST, and that is the second bug this file records. The first
 * attempt imported the stylesheets with `?raw` from inside the suite, which
 * runs under vitest-pool-workers: CSS imports resolve to an EMPTY STRING
 * there, so every assertion passed against nothing at all. A green test that
 * checks a zero-length string is worse than no test. Node reads files; this
 * runs in Node.
 */
import { readFileSync } from 'node:fs';
import { cssTokenProblems } from '../src/lib/cssCheck';

const FILES = ['web/src/theme.css', 'web/src/form.css', 'web/src/internal.css'];

const sheets = FILES.map((name) => ({ name, body: readFileSync(name, 'utf8') }));

// If a stylesheet ever reads as empty, say so rather than reporting "no
// problems found" -- which is exactly how the vitest version lied.
const empty = sheets.filter((s) => s.body.trim().length === 0);
if (empty.length > 0) {
  console.error(`stylesheets read as empty: ${empty.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

const problems = cssTokenProblems(sheets);
if (problems.length > 0) {
  console.error(
    'CSS custom properties read but never defined ' +
      '(the whole declaration is dropped, silently):\n' +
      problems
        .map((p) => `  - ${p.sheet}:${p.line}  ${p.token}\n      ${p.context}`)
        .join('\n'),
  );
  process.exit(1);
}

const bytes = sheets.reduce((n, s) => n + s.body.length, 0);
console.log(
  `CSS OK: ${sheets.length} stylesheets, ${bytes.toLocaleString()} bytes, ` +
    'every var() without a fallback resolves',
);
