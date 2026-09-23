/**
 * Is this thing ready for nonprofits?
 *
 *   npm run golive                      -- against the deployed hostnames
 *   npm run golive -- --local           -- against a dev worker on 8787
 *
 * WHY A SCRIPT AND NOT A CHECKLIST. docs/BLOCKED-ON-YOU.md is a list of things
 * a person has to decide or fetch. This is the other half: the things that are
 * either true right now or not, and that nobody should be taking anyone's word
 * for -- least of all mine. Every line below is a fact the script went and got.
 *
 * It is READ-ONLY. It issues GETs and it runs SELECTs. It writes nothing,
 * anywhere, and there is no flag that makes it write.
 *
 * WHAT IT CANNOT TELL YOU, stated here so a green run is never mistaken for
 * permission to open the form:
 *   - Whether the code is secure. An author auditing their own work is the one
 *     review that does not count. See CLAUDE.md.
 *   - Whether email is delivered. SPF, DKIM and DMARC being published is not
 *     the same as a grantee's mail server accepting the message.
 *   - Whether an upload reaches R2. That needs real credentials and a real
 *     bucket, and it has been proven exactly once, by hand.
 *   - What any of it sounds like in a screen reader.
 * Those four are in the report as OPEN, permanently, because they cannot be
 * closed from here.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const remoteDb = args.includes('--preview');
const APPLY = arg('--apply') ?? (local ? 'http://127.0.0.1:8787' : 'https://apply.houstontexansfoundation.org');
const STAFF = arg('--staff') ?? (local ? null : 'https://grants.houstontexansfoundation.org');

function arg(name) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

const RESULTS = [];
/** state: 'ok' | 'blocked' | 'warn' | 'open' | 'unknown' */
const record = (state, name, detail) => RESULTS.push({ state, name, detail });

const COLOUR = { ok: '\x1b[32m', blocked: '\x1b[31m', warn: '\x1b[33m', open: '\x1b[36m', unknown: '\x1b[90m' };
const LABEL = { ok: 'READY ', blocked: 'BLOCK ', warn: 'WATCH ', open: 'OPEN  ', unknown: '?     ' };

/** One SELECT. Local unless --preview is passed, and never production. */
function sql(statement) {
  const flags = ['d1', 'execute', 'steward-preview', remoteDb ? '--remote' : '--local',
                 '--json', '--command', statement];
  const out = execFileSync('npx', ['wrangler', ...flags],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

async function head(url) {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') ?? '', headers: res.headers };
}

console.log(`\nSteward — go-live check\n`);
console.log(`  applicant surface : ${APPLY}`);
console.log(`  staff surface     : ${STAFF ?? '(not checked locally)'}`);
console.log(`  database          : steward-preview ${remoteDb ? '(remote preview)' : '(local)'}\n`);

// ---------------------------------------------------------------------------
// The hostnames
// ---------------------------------------------------------------------------
/*
 * THE CHECK THAT HAS ALREADY CAUGHT A LIVE FAULT. On 20 September the Access
 * application was scoped to the Worker rather than to a hostname, so it had
 * silently taken the applicant hostname too. Every nonprofit reaching the form
 * would have consumed one of fifty free Access seats, and applicant fifty-one
 * would have been refused rather than billed. It cannot be seen from the
 * repository or from a deploy log. It can only be seen from outside.
 */
try {
  const r = await head(`${APPLY}/`);
  const behindAccess = /cloudflareaccess\.com/.test(r.location);
  record(behindAccess ? 'blocked' : 'ok',
    'the applicant form is NOT behind Cloudflare Access',
    behindAccess
      ? `redirects to ${r.location} — every applicant would burn one of 50 free seats`
      : `HTTP ${r.status}, no Access redirect`);
} catch (e) {
  record('unknown', 'the applicant form is NOT behind Cloudflare Access', String(e.message ?? e));
}

if (STAFF) {
  try {
    const r = await head(`${STAFF}/`);
    const behindAccess = /cloudflareaccess\.com/.test(r.location);
    record(behindAccess ? 'ok' : 'blocked',
      'the staff surface IS behind Cloudflare Access',
      behindAccess ? 'redirects to Access as it should'
                   : `HTTP ${r.status} with no Access redirect — staff pages are open to the internet`);
  } catch (e) {
    record('unknown', 'the staff surface IS behind Cloudflare Access', String(e.message ?? e));
  }
}

/*
 * The CSP. A connect-src that does not admit R2 makes every upload fail before
 * a request is even made: no network entry, no R2 error, nothing in any log.
 * That shipped once and no test could see it.
 */
try {
  const r = await head(`${APPLY}/apply`);
  const csp = r.headers.get('content-security-policy') ?? '';
  if (csp === '') {
    record('warn', 'the public form sends a Content-Security-Policy', 'no CSP header on /apply');
  } else {
    const admitsR2 = /r2\.cloudflarestorage\.com/.test(csp);
    record(admitsR2 ? 'ok' : 'blocked',
      'the CSP admits uploads to R2',
      admitsR2 ? 'connect-src names R2'
               : 'connect-src does not name R2 — every upload fails silently, with no request made');
  }
} catch (e) {
  record('unknown', 'the CSP admits uploads to R2', String(e.message ?? e));
}

// ---------------------------------------------------------------------------
// Is there anything to apply to?
// ---------------------------------------------------------------------------
/*
 * The API's answer, not the database's. A cycle can be marked open and still
 * not be listable -- that is exactly what happened on 22 September, when the
 * seeded program had no eligibility stage and listOpenCycles quietly returned
 * nothing. Comparing the two is the only way to see the difference.
 */
let listed = null;
try {
  const res = await fetch(`${APPLY}/api/public/cycles`);
  const body = await res.json();
  listed = Array.isArray(body?.cycles) ? body.cycles : [];
  record(res.ok ? 'ok' : 'blocked', 'the public cycles endpoint answers',
    `HTTP ${res.status}, ${listed.length} cycle(s) listed`);
} catch (e) {
  record('unknown', 'the public cycles endpoint answers', String(e.message ?? e));
}

let dbReachable = true;
let openInDb = [];
try {
  openInDb = sql(`SELECT c.id, c.name, c.closes_at, p.name AS program
                    FROM cycles c JOIN programs p ON p.id = c.program_id
                   WHERE c.status = 'open' AND c.deleted_at IS NULL`);
} catch (e) {
  dbReachable = false;
  record('unknown', 'the database could be read', String(e.message ?? e).slice(0, 160));
}

if (dbReachable) {
  if (openInDb.length === 0) {
    record('warn', 'a cycle is open for applications',
      'no cycle has status open — nobody can apply, which is correct between rounds');
  } else if (listed !== null && listed.length < openInDb.length) {
    /*
     * The important one. An open cycle the public page will not show is a
     * cycle nobody can apply to, and nothing anywhere says so.
     */
    record('blocked', 'every open cycle is actually reachable by an applicant',
      `${openInDb.length} open in the database, ${listed.length} listed publicly — ` +
      'an open cycle with no published form for its first stage does not appear');
  } else {
    const shown = openInDb.slice(0, 4).map((c) => `${c.program}: ${c.name}`).join('; ');
    record('ok', 'a cycle is open for applications',
      openInDb.length > 4 ? `${shown}; and ${openInDb.length - 4} more` : shown);
  }

  /*
   * A FIXTURE CYCLE, OPEN AND PUBLICLY LISTED.
   *
   * The e2e harnesses create open cycles with generated names and run against
   * the LOCAL database, so this should never fire on preview. It is here
   * because of what happens if it ever does: an invented grant programme
   * advertised to real nonprofits, who would read it, plan around it and
   * apply. The seed file already refuses this for the fixtures program by
   * keeping its only cycle in draft, and says why in as many words. This is
   * the same rule applied to cycles nothing checked in can see.
   *
   * Matching on the name is crude and deliberately so: a cycle a person named
   * will not look like this, and a false positive costs somebody ten seconds
   * of reading while a false negative costs the Foundation its credibility.
   */
  const fixtures = openInDb.filter((c) => /^(e2e|a11y|stages|test|demo|fixture)\b/i.test(String(c.name)));
  record(fixtures.length === 0 ? 'ok' : 'blocked',
    'no test cycle is open to the public',
    fixtures.length === 0
      ? 'every open cycle looks like one a person named'
      : `${fixtures.length} open cycle(s) look generated: ${fixtures.slice(0, 3).map((c) => c.name).join(', ')}` +
        ' — a nonprofit would see these as real programmes');

  // CLAUDE.md: "Two admin accounts exist from day one. Single-admin is a
  // continuity failure, not a security preference."
  const admins = sql(`SELECT COUNT(*) AS n FROM users
                       WHERE role='admin' AND is_active=1 AND deleted_at IS NULL`)[0]?.n ?? 0;
  record(Number(admins) >= 2 ? 'ok' : 'blocked', 'there are at least two active admins',
    Number(admins) >= 2 ? `${admins} active`
      : `${admins} active — one admin is a continuity failure if they are unavailable mid-cycle`);

  // Every migration on disk has been applied. A missing one is a table that is
  // not there, and the failure shows up as something unrelated.
  const onDisk = readdirSync('migrations').filter((f) => f.endsWith('.sql')).length;
  let applied = 0;
  try {
    applied = Number(sql(`SELECT COUNT(*) AS n FROM d1_migrations`)[0]?.n ?? 0);
  } catch { applied = -1; }
  record(applied === onDisk ? 'ok' : applied < 0 ? 'unknown' : 'blocked',
    'every migration is applied',
    applied < 0 ? 'could not read d1_migrations' : `${applied} applied, ${onDisk} on disk`);

  // A report form that cannot take a photograph is the state preview is in
  // until somebody rebuilds it. Worth naming rather than discovering.
  const mediaForms = sql(
    `SELECT p.name AS program FROM form_definitions fd
       JOIN programs p ON p.id = fd.program_id
      WHERE fd.kind='report' AND fd.status='published' AND fd.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM form_fields ff
                     WHERE ff.form_definition_id = fd.id AND ff.field_key='project_media')`);
  const reportForms = sql(
    `SELECT COUNT(*) AS n FROM form_definitions
      WHERE kind='report' AND status='published' AND deleted_at IS NULL`)[0]?.n ?? 0;
  record(Number(reportForms) === 0 ? 'warn'
        : mediaForms.length === Number(reportForms) ? 'ok' : 'warn',
    'published report forms can take photos and video',
    Number(reportForms) === 0
      ? 'no published report form yet'
      : `${mediaForms.length} of ${reportForms} published report form(s) have a media field`);

  // Files nothing will ever delete. Not a blocker; a number to have seen.
  const bytes = Number(sql(
    `SELECT COALESCE(SUM(size_bytes),0) AS b FROM attachments
      WHERE parent_type='report_submission' AND purge_due_at IS NULL
        AND purged_at IS NULL AND deleted_at IS NULL`)[0]?.b ?? 0);
  const gb = bytes / (1024 ** 3);
  record(gb * 0.015 >= 5 ? 'warn' : 'ok', 'storage is below the figure worth a conversation',
    `${gb.toFixed(2)} GB on reports has no deletion date, about $${(gb * 0.015).toFixed(2)} a month`);
}

// ---------------------------------------------------------------------------
// The four that cannot be closed from here
// ---------------------------------------------------------------------------
record('open', 'a security review by somebody who did not write this',
  'holds other organizations EINs, audited accounts and operating budgets');
record('open', 'email actually delivered to a real grantee',
  'SPF, DKIM and DMARC published is not the same as a message accepted');
record('open', 'an upload proven against the real bucket, recently',
  'done once by hand on 22 September; nothing re-checks it');
record('open', 'a screen reader, driven by somebody who uses one',
  'axe catches perhaps a third to a half of real barriers');

// ---------------------------------------------------------------------------
for (const r of RESULTS) {
  console.log(`  ${COLOUR[r.state]}${LABEL[r.state]}\x1b[0m ${r.name}`);
  console.log(`         ${r.detail}`);
}

const blocked = RESULTS.filter((r) => r.state === 'blocked');
const unknown = RESULTS.filter((r) => r.state === 'unknown');
console.log('');
if (blocked.length > 0) {
  console.log(`\x1b[31m${blocked.length} thing(s) block going live.\x1b[0m`);
} else if (unknown.length > 0) {
  console.log(`\x1b[33mNothing is blocking, but ${unknown.length} check(s) could not be run.\x1b[0m`);
} else {
  console.log('Nothing automated is blocking.');
}
console.log('The four OPEN items above are not automatable and are not optional.');
console.log('docs/BLOCKED-ON-YOU.md carries what a person still has to fetch or decide.\n');
process.exit(blocked.length > 0 ? 1 : 0);
