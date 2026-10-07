/**
 * Fail if the repository tells a human to run a wrangler command that cannot work.
 *
 * WHY THIS EXISTS. `wrangler d1 execute --file --remote` switches to D1's bulk
 * IMPORT endpoint, which refuses an OAuth login with `Authentication error
 * [code: 10000]`. That was already written down twice -- in
 * `scripts/apply-sql.mjs` and in `docs/RUNNING-COMMANDS.md` -- and a broken
 * command was still handed over and still run against production, because
 * prose in a file nobody opened is not a guard. This is the guard.
 *
 * It flags a line only when the line is a RUNNABLE INVOCATION: trimmed, it
 * begins with `wrangler` or `npx wrangler`, or it is a package.json script
 * value that does. Prose that names the broken form in order to warn against
 * it -- "Not `wrangler d1 execute --file --remote`" -- does not begin with the
 * command, so the documentation that explains the rule does not trip it.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TEXT = /\.(md|mjs|js|ts|tsx|json|sql|sh|toml|ya?ml)$/;

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && TEXT.test(f));

/**
 * Every runnable wrangler invocation on a line, as a bare command string.
 *
 * A package.json script is `"name": "wrangler …"`, so the value is unwrapped
 * before the test. Anything else must start the line, after whitespace and
 * markdown's code fences and list markers.
 */
function invocations(line) {
  const out = [];
  /*
   * Peel wrappers until the line stops changing. One pass in a fixed order
   * missed `` `--   npx wrangler …` `` in a template literal: the backtick is
   * not a list marker, so stripping markers first did nothing and stripping
   * backticks afterwards left the `--` comment in front of the command.
   */
  let bare = line.trim();
  for (let i = 0; i < 6; i += 1) {
    const next = bare
      .replace(/^[-*>\s]*/, '')
      .replace(/^`+/, '')
      .replace(/`+[,;]?$/, '')
      .trim();
    if (next === bare) break;
    bare = next;
  }
  if (/^(npx\s+)?wrangler\s/.test(bare)) out.push(bare);
  for (const m of line.matchAll(/"[^"]*":\s*"((?:npx\s+)?wrangler\s[^"]*)"/g)) {
    out.push(m[1]);
  }
  return out;
}

const RULES = [
  {
    id: 'd1-remote-file',
    hit: (cmd) =>
      cmd.includes('d1 execute') &&
      /(^|\s)--remote(\s|$|=)/.test(cmd) &&
      /(^|\s)--file(\s|=)/.test(cmd),
    say:
      'wrangler d1 execute --file --remote uses D1\'s bulk IMPORT endpoint, which ' +
      'refuses an OAuth login (Authentication error 10000). Use ' +
      '`npm run sql:apply -- --file=… --remote` for preview, or, for a hand-written ' +
      'multi-statement file, `--command="$(cat <file>)"`.',
  },
  {
    id: 'command-unbound',
    /*
     * `--command "$(cat f.sql)"` loses the value when the file opens with a
     * `--` comment: yargs reads the leading dashes as the next flag and exits
     * with "You must provide either --command or --file". `--command=` binds
     * it. Every SQL file in this repo opens with a comment, so the unbound
     * form is always wrong here.
     */
    hit: (cmd) => /--command\s+"\$\(/.test(cmd),
    say:
      '`--command "$(cat …)"` breaks when the file opens with a `--` comment: yargs ' +
      'reads the leading dashes as a flag. Write `--command="$(cat …)"`.',
  },
];

const problems = [];
for (const file of tracked) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!text.includes('wrangler')) continue;
  text.split('\n').forEach((line, i) => {
    for (const cmd of invocations(line)) {
      for (const rule of RULES) {
        if (rule.hit(cmd)) problems.push({ file, line: i + 1, rule, cmd });
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`check:commands — ${problems.length} unrunnable wrangler invocation(s):\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}`);
    console.error(`    ${p.cmd.slice(0, 140)}`);
    console.error(`    ${p.rule.say}\n`);
  }
  process.exit(1);
}

console.log(`check:commands — ok, ${tracked.length} files scanned.`);
