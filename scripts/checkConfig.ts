/**
 * Guard wrangler.toml against silent misconfiguration.
 *
 *   npm run check:config
 *
 * This exists because a real mistake got through: `workers_dev` and
 * `preview_urls` were written below a [table] header, so TOML assigned them to
 * that table and wrangler ignored them. The deploy reported success and Preview
 * URLs stayed enabled -- an extra public hostname that Cloudflare Access does
 * not cover. Only a warning in the deploy output revealed it.
 *
 * Config that fails silently is worse than config that fails loudly.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('wrangler.toml', 'utf8');
const lines = src.split('\n');
const problems: string[] = [];

const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));

// Access configuration. Empty is allowed -- that is the fail-closed state
// before Access is set up -- but a MALFORMED value is not, because it would
// make every staff login fail with an error pointing at the token instead of
// at the config.
const team = /ACCESS_TEAM_DOMAIN = "([^"]*)"/.exec(src)?.[1] ?? '';
const aud = /ACCESS_AUD = "([^"]*)"/.exec(src)?.[1] ?? '';

/**
 * A key that must be top-level, i.e. above the first [table] header.
 *
 * Returns the value so a caller can reason about it; `allowed` constrains it.
 */
function requireTopLevel(key: string, allowed: readonly string[]): string | null {
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (idx === -1) {
    problems.push(`${key} is missing; it would be defaulted rather than chosen`);
    return null;
  }
  if (firstTable !== -1 && idx > firstTable) {
    problems.push(
      `${key} is on line ${idx + 1}, below the first [table] header on line ${firstTable + 1}. ` +
        `TOML assigns it to that table, so wrangler ignores it.`,
    );
  }
  const value = lines[idx]!.split('=')[1]!.trim();
  if (!allowed.includes(value)) {
    problems.push(`${key} is ${value}, expected one of ${allowed.join(' | ')}`);
  }
  return value;
}

// Every additional hostname is a surface Access must be placed in front of
// separately. Preview URLs mint one per deployed version, which no policy
// attached to a named hostname can cover.
const workersDev = requireTopLevel('workers_dev', ['true', 'false']);
requireTopLevel('preview_urls', ['false']);

// --- the custom domain -------------------------------------------------------
//
// `routes` must also be top-level. Below a [table] header TOML would assign it
// to that table and wrangler would ignore it -- the exact failure this whole
// script exists because of.
const routesIdx = lines.findIndex((l) => /^\s*routes\s*=/.test(l));
const customDomains = [...src.matchAll(/pattern\s*=\s*"([^"]+)"[^}]*custom_domain\s*=\s*true/g)].map(
  (m) => m[1]!,
);

if (routesIdx !== -1 && firstTable !== -1 && routesIdx > firstTable) {
  problems.push(
    `routes is on line ${routesIdx + 1}, below the first [table] header. ` +
      `wrangler would ignore it and the custom domain would silently not exist.`,
  );
}

for (const pattern of customDomains) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(pattern)) {
    problems.push(`custom domain "${pattern}" is not a plain hostname`);
  }
  if (pattern.includes('*') || pattern.includes('/')) {
    problems.push(`custom domain "${pattern}" must be a hostname, not a route pattern`);
  }
}

// A published hostname with no Access configuration is a staff API that fails
// closed -- safe, but it means nobody can sign in and the failure looks like an
// outage. Refuse to ship a custom domain without Access configured.
if (customDomains.length > 0 && (team === '' || aud === '')) {
  problems.push(
    'a custom domain is configured but ACCESS_TEAM_DOMAIN/ACCESS_AUD are empty. ' +
      'Every staff route would fail closed on the new hostname.',
  );
}

// Once a custom domain exists, workers.dev is an extra public hostname with no
// purpose. Both being live at once is correct only during a cutover, and that
// cutover is done. A hard failure, not a warning: this script exists because an
// extra hostname slipped through once already, and if workers.dev is ever
// genuinely needed again, editing this rule is the review moment we want.
if (customDomains.length > 0 && workersDev !== 'false') {
  problems.push(
    `workers_dev is ${workersDev} alongside the custom domain ${customDomains.join(', ')}. ` +
      `Two public hostnames means two surfaces for an Access policy change to miss.`,
  );
}

if (team !== '' && !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) {
  problems.push(`ACCESS_TEAM_DOMAIN "${team}" is not a <team>.cloudflareaccess.com hostname`);
}
if (aud !== '' && !/^[0-9a-f]{64}$/.test(aud)) {
  problems.push(`ACCESS_AUD is not 64 lowercase hex characters (got ${aud.length})`);
}
if ((team === '') !== (aud === '')) {
  problems.push('ACCESS_TEAM_DOMAIN and ACCESS_AUD must both be set or both be empty');
}

// NON-NEGOTIABLE: the default bindings must never point at production.
const prodPlaceholders = (src.match(/FILL_IN_AT_DEPLOY_TIME_DO_NOT_COMMIT/g) ?? []).length;
if (prodPlaceholders < 3) {
  problems.push(
    `expected 3 production placeholders, found ${prodPlaceholders}. ` +
      `Production ids must never be committed; a deliberate deploy fills them in.`,
  );
}

// -----------------------------------------------------------------------------
// NON-NEGOTIABLE #2: the default bindings point at PREVIEW, always.
//
// This was the rule with no check behind it. The script asserted the database
// NAME was steward-preview and stopped there, so editing the default
// `database_id` to a production uuid passed `npm run verify` clean -- and the
// default binding is what every script, every `wrangler dev` and every
// unqualified deploy uses.
//
// The invariant that actually makes "a script run with the default config hits
// preview, never production" true is that the id and the preview id are the
// SAME VALUE. If they diverge, `--remote` and `--local` reach different
// databases and one of them is not preview.
// -----------------------------------------------------------------------------

/**
 * The default-environment part of the file: everything before the first real
 * `[env.*]` table header.
 *
 * Scanned line by line rather than with indexOf, because the file's own header
 * COMMENT mentions `[env.production]` on line 9 -- a substring search truncated
 * the section to nine lines and every assertion below silently passed on an
 * almost-empty string. Config that fails silently is what this script exists to
 * prevent, so getting caught by it here was fair.
 */
function defaultEnvSection(): string {
  const end = lines.findIndex((l) => /^\s*\[env\./.test(l));
  return (end === -1 ? lines : lines.slice(0, end)).join('\n');
}

const defaults = defaultEnvSection();

function pairMustMatch(label: string, aKey: string, bKey: string): void {
  const a = new RegExp(`^\\s*${aKey}\\s*=\\s*"([^"]*)"`, 'm').exec(defaults)?.[1];
  const b = new RegExp(`^\\s*${bKey}\\s*=\\s*"([^"]*)"`, 'm').exec(defaults)?.[1];
  if (a === undefined || b === undefined) {
    problems.push(`${label}: expected both ${aKey} and ${bKey} in the default bindings`);
    return;
  }
  if (a !== b) {
    problems.push(
      `${label}: ${aKey} (${a}) and ${bKey} (${b}) differ. ` +
        `The default bindings must resolve to the SAME preview resource, or a script ` +
        `run without --env reaches something that is not preview.`,
    );
  }
}

/*
 * Staging must never collide with preview or production.
 *
 * A copy-pasted id here is how the friendly-organization test with REAL EINs
 * ends up writing into the database that seed and admin scripts are pointed at
 * with --remote. Decision #12 exists to keep those apart; this is the check
 * that keeps the decision true.
 */
const stagingSection = (() => {
  const start = lines.findIndex((l) => /^\s*\[env\.staging\]/.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s*\[env\.(?!staging)/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
})();

if (stagingSection !== '') {
  const previewIds = [
    /^\s*database_id\s*=\s*"([^"]*)"/m.exec(defaults)?.[1],
    /^\s*id\s*=\s*"([^"]*)"/m.exec(defaults)?.[1],
    /^\s*bucket_name\s*=\s*"([^"]*)"/m.exec(defaults)?.[1],
  ].filter((v): v is string => typeof v === 'string' && v !== '');

  for (const value of [...stagingSection.matchAll(/=\s*"([^"]+)"/g)].map((m) => m[1]!)) {
    if (previewIds.includes(value)) {
      problems.push(
        `staging reuses the preview resource "${value}". Real applicant data would ` +
          `land in the database that seed:preview and admin:apply are run against.`,
      );
    }
  }
}

pairMustMatch('D1', 'database_id', 'preview_database_id');
pairMustMatch('R2', 'bucket_name', 'preview_bucket_name');
pairMustMatch('KV', 'id', 'preview_id');

if (!/database_name = "steward-preview"/.test(defaults)) {
  problems.push('the default D1 binding is not steward-preview');
}
if (!/bucket_name = "steward-preview-files"/.test(defaults)) {
  problems.push('the default R2 binding is not steward-preview-files');
}
if (!/ENVIRONMENT = "preview"/.test(defaults)) {
  problems.push('the default ENVIRONMENT var is not "preview"');
}

if (problems.length > 0) {
  console.error('wrangler.toml problems:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('wrangler.toml OK: hostname surface pinned, production bindings still placeholders');
