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
  /*
   * A BACKTICK LEFT IN THE MIDDLE MEANS THIS IS PROSE, not a command.
   *
   * `* \`wrangler deploy --env staging\` would reassign ...` in a JSDoc
   * comment normalises to a string that starts with `wrangler`, because the
   * comment marker and the opening backtick are both stripped -- and it was
   * then reported as an unrunnable invocation in a file that only talks about
   * one. A real command line in this repository contains no backtick; an
   * inline-code span inside a sentence always leaves its closing one behind.
   */
  if (bare.includes('`')) return out;
  if (/^(npx\s+)?wrangler\s/.test(bare)) out.push(bare);
  for (const m of line.matchAll(/"[^"]*":\s*"((?:npx\s+)?wrangler\s[^"]*)"/g)) {
    out.push(m[1]);
  }
  return out;
}

/*
 * A RULE THAT WAS HERE AND WAS WRONG.
 *
 * `d1 execute --remote` without `--json` returned 7403 ("The given account is
 * not valid or is not authorized to access this service"); with `--json` it
 * worked. Several times each way. A rule was added requiring `--json`, and
 * docs were written stating it as fact.
 *
 * On 2026-10-08 the same command FAILED with `--json` and then SUCCEEDED on an
 * immediate retry, byte-identical. So 7403 is intermittent on Cloudflare's
 * side and the flag never had anything to do with it: every failure happening
 * to lack `--json` was a coincidence that survived a handful of samples.
 *
 * The rule is deleted rather than reworded, because a check enforcing a false
 * reason rejects correct commands and teaches the wrong lesson. What is left
 * is the only thing the evidence supports: ON A 7403, RETRY BEFORE CONCLUDING
 * ANYTHING.
 */

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
  /*
   * Join shell line continuations before scanning. A command written across
   * two lines with a trailing `\` was half-read: the first line carried the
   * invocation and the flag that makes it work sat on the second, so the check
   * reported a problem that the file did not have -- and, the other way round,
   * would have passed a broken command whose bad flag was on line two.
   *
   * The reported line number stays that of the line the command starts on.
   */
  const raw = text.split('\n');
  const logical = [];
  for (let i = 0; i < raw.length; i += 1) {
    let line = raw[i];
    const start = i;
    /*
     * A comment prefix repeats on the continuation line, so it is stripped --
     * but ONLY when the command itself is inside a comment. In a shell block
     * the continuation line legitimately begins with `--json` or `--command`,
     * and stripping a leading `--` there both hid a bad flag and falsely
     * flagged a good one. The marker is taken from the line the command starts
     * on, and only that marker is removed.
     */
    const marker = (/^\s*(--|#|\*)/.exec(raw[start]) ?? [])[1];
    const strip = marker
      ? new RegExp(`^\\s*${marker.replace(/[*]/g, '\\*')}[ \\t]*`)
      : null;
    while (/\\\s*$/.test(line) && i + 1 < raw.length) {
      i += 1;
      const cont = strip ? raw[i].replace(strip, '') : raw[i];
      line = line.replace(/\\\s*$/, ' ') + cont;
    }
    logical.push({ line, no: start + 1 });
  }

  /*
   * THE ENCLOSING FENCED BLOCK, for rules that are about a PROCEDURE rather
   * than a single command.
   *
   * docs/PRODUCTION-CUTOVER.md writes the deploy as two lines in one block --
   * `npm run build:web`, then the deploy -- which is correct, and a line-based
   * rule called it broken. A fenced block is one thing somebody pastes, so
   * for those rules the block is the unit.
   */
  const fenceOf = new Map();
  let fenceStart = null;
  let fenceLines = [];
  raw.forEach((l, i) => {
    if (/^\s*```/.test(l)) {
      if (fenceStart === null) {
        fenceStart = i;
        fenceLines = [];
      } else {
        const text = fenceLines.join('\n');
        for (let n = fenceStart + 1; n < i; n += 1) fenceOf.set(n + 1, text);
        fenceStart = null;
      }
      return;
    }
    if (fenceStart !== null) fenceLines.push(l);
  });

  logical.forEach(({ line, no: lineNo }) => {
    const block = fenceOf.get(lineNo) ?? line;
    for (const cmd of invocations(line)) {
      for (const rule of RULES) {
        if (rule.hit(cmd, block)) problems.push({ file, line: lineNo, rule, cmd });
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
