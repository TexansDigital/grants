/**
 * PHASE A SPIKE -- THROWAWAY, deleted with spike/.
 *
 *   node spike/load-key.mjs                 finds the key in ~/Downloads
 *   node spike/load-key.mjs <path>          or use the one you name
 *
 * Puts the service-account key into .dev.vars, base64'd onto one line.
 *
 * WHY A SCRIPT AND NOT A COMMAND TO PASTE. The paste version asked you to
 * substitute a filename into the middle of it, and a placeholder that looks
 * copyable will be copied -- which is how `steward-grants-XXXXXX.json` ended up
 * being read as a real path. Worse, the failure was quiet: the command
 * substitution returned empty, printf ran anyway, and .dev.vars gained a line
 * setting the secret to nothing. This finds the file, checks it really is a
 * service-account key, and rewrites the line rather than stacking another one.
 *
 * It prints the account's address and project id, and NEVER the private key.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEV_VARS = '.dev.vars';
const VAR = 'GOOGLE_SERVICE_ACCOUNT_B64';

function die(message, hint) {
  console.error(`\n  ${message}\n` + (hint ? `  ${hint}\n` : ''));
  process.exit(1);
}

/** A service-account key, or a reason it is not one. */
function inspect(path) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch {
    return { ok: false, why: 'could not be read' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, why: 'is not JSON' };
  }
  if (parsed?.type !== 'service_account') {
    return { ok: false, why: 'is JSON, but not a service-account key' };
  }
  if (!parsed.client_email || !parsed.private_key) {
    return { ok: false, why: 'has no client_email / private_key' };
  }
  return {
    ok: true,
    raw,
    email: parsed.client_email,
    projectId: parsed.project_id ?? '(none in the file)',
  };
}

// ---- find the key ---------------------------------------------------------

const named = process.argv[2];
let path;

if (named) {
  path = resolve(named.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(path)) die(`No file at ${path}`);
} else {
  const downloads = join(homedir(), 'Downloads');
  let candidates = [];
  try {
    candidates = readdirSync(downloads)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => join(downloads, f))
      .filter((f) => inspect(f).ok)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    die(`Could not read ${downloads}`, 'Pass the path instead: node spike/load-key.mjs <path>');
  }

  if (candidates.length === 0) {
    die(
      'No service-account key found in ~/Downloads.',
      'If it is somewhere else: node spike/load-key.mjs <path to the .json>',
    );
  }
  if (candidates.length > 1) {
    console.error('\n  More than one service-account key in ~/Downloads:\n');
    for (const c of candidates) console.error(`    ${c}   ${inspect(c).email}`);
    die('Name the one you want.', 'node spike/load-key.mjs <path>');
  }
  path = candidates[0];
}

const key = inspect(path);
if (!key.ok) die(`${path}\n  ${key.why}.`, 'This should be the JSON you downloaded from Google Cloud.');

// ---- refuse to write somewhere git would pick it up -----------------------

const gitignore = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';
if (!gitignore.split(/\r?\n/).some((l) => l.trim() === DEV_VARS)) {
  die(
    `${DEV_VARS} is not in .gitignore. Refusing to write a private key into a tracked file.`,
    'Are you running this from the repository root?',
  );
}

// ---- rewrite, do not append ----------------------------------------------

const before = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : '';
const kept = before
  .split(/\r?\n/)
  .filter((line) => !line.startsWith(`${VAR}=`))
  .filter((line, i, all) => line.trim() !== '' || i < all.length - 1);

const removed = before.split(/\r?\n/).filter((l) => l.startsWith(`${VAR}=`)).length;
const line = `${VAR}=${key.raw.toString('base64')}`;
writeFileSync(DEV_VARS, [...kept, line, ''].join('\n'));

console.log(`
  Key loaded into ${DEV_VARS}.

    from       ${path}
    account    ${key.email}
    project    ${key.projectId}
` + (removed > 0 ? `\n  Replaced ${removed} earlier ${VAR} line${removed === 1 ? '' : 's'}.\n` : '') + `
  Check the account address above is the one you shared the Drive folder with.
  Then delete the downloaded file -- this is the only copy you need.

  Next:  npm run spike
`);
