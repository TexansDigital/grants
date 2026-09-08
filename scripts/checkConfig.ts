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

// Both hostnames live at once is the correct state only while cutting over.
// Left that way permanently it is an extra public surface that a later Access
// policy change can forget about.
if (customDomains.length > 0 && workersDev === 'true') {
  console.warn(
    `note: workers_dev is still true alongside ${customDomains.join(', ')}. ` +
      `That is correct DURING cutover. Set it to false once the custom domain ` +
      `is verified and the Access application covers it.`,
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

// The default D1 must be the preview database, not production.
if (!/database_name = "steward-preview"/.test(src)) {
  problems.push('the default D1 binding is not steward-preview');
}

if (problems.length > 0) {
  console.error('wrangler.toml problems:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('wrangler.toml OK: hostname surface pinned, production bindings still placeholders');
