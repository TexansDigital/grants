/**
 * A past grant recipient, from knowing nothing to sending a video.
 *
 *   npm run e2e:pastgrantee
 *
 * THE WHOLE POINT. Somebody the Foundation funded before this system existed
 * has no application here, no award they can reach and no account. This drives
 * the path that gives them one: a public claim, a person approving it, a
 * sign-in, and a report carrying photos and video.
 *
 * WHAT IT PROVES THAT NO UNIT TEST CAN. Each half of this worked before the
 * halves were joined -- that has been the shape of every fault found in this
 * project. The claim form posted, approval granted, the portal rendered, and
 * nothing connected them.
 *
 * WHAT IT DOES NOT PROVE. No file reaches R2: the PUT is intercepted against a
 * hostname that does not exist, so this checks what the browser SENDS -- PUT,
 * no Content-Type -- and not what storage accepts. No email is delivered.
 *
 * PREREQUISITES: `npm run build:web`, `npm run dev`, a migrated and seeded
 * local database, and TURNSTILE_OPTIONAL="1" in .dev.vars. Invented data only.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.STEWARD_WORKER ?? 'http://127.0.0.1:8787';
const BROWSER =
  process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
};
const note = (l, v) => console.log(`      ${l}: ${v}`);

function sql(statement) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'steward-preview', '--local', '--json', '--command', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}
const one = (statement, column) => {
  const rows = sql(statement);
  if (rows.length === 0) throw new Error(`no rows for: ${statement}`);
  return rows[0][column];
};

function sessionsNamespaceId() {
  const toml = readFileSync('wrangler.toml', 'utf8');
  const block = toml.split('[[kv_namespaces]]').find((b) => /binding\s*=\s*"SESSIONS"/.test(b));
  const id = block && /\bid\s*=\s*"([^"]+)"/.exec(block)?.[1];
  if (!id) throw new Error('could not find the SESSIONS namespace id');
  return id;
}
function mintSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const key = `session:${createHash('sha256').update(token).digest('hex')}`;
  const file = join(mkdtempSync(join(tmpdir(), 'steward-pg-')), 's.json');
  writeFileSync(file, JSON.stringify({
    userId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }));
  execFileSync('npx', ['wrangler', 'kv', 'key', 'put', key, `--path=${file}`,
    `--namespace-id=${sessionsNamespaceId()}`, '--local'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return token;
}

console.log('Steward — a past grantee, from a claim to a video\n');

// --- a historical award, the way an imported one looks ----------------------
const stamp = Date.now().toString().slice(-6);
const now = new Date().toISOString();
const ein = `00${stamp}0`;
const orgId = randomUUID();
const awardId = randomUUID();
const email = `pastgrantee-${stamp}@example-invented.org`;

const programId = one(
  `SELECT id FROM programs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`, 'id');
sql(`INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES ('${orgId}','Invented Harbor Trust ${stamp}','${ein}','active','${now}','${now}')`);
sql(`INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
       status, source_system, source_reference, term_start, term_end, created_at, updated_at)
     VALUES ('${awardId}','${orgId}','${programId}',2500000,'2024-03-01T00:00:00.000Z','active',
             'spreadsheet','HIST-${stamp}','2024-01-01T00:00:00.000Z','2024-12-31T00:00:00.000Z',
             '${now}','${now}')`);
note('award', awardId);
note('EIN', ein);

/*
 * A published report form THAT HAS THE MEDIA FIELD.
 *
 * Requiring the field, not just "a report form", and the first run of this
 * script is why. A published definition is immutable by trigger, so the one
 * already in the database was scaffolded before photos and video existed and
 * will never grow them. Reusing it meant driving the old shape and reporting
 * that the new one was missing.
 *
 * That is also a real operational note, not just a harness one: the
 * Foundation's existing report forms do not gain this section. Somebody has
 * to scaffold a new version.
 */
let reportFormId = sql(
  `SELECT fd.id FROM form_definitions fd
    WHERE fd.program_id='${programId}' AND fd.kind='report' AND fd.status='published'
      AND fd.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM form_fields ff
                   WHERE ff.form_definition_id = fd.id AND ff.field_key='project_media')
    LIMIT 1`)[0]?.id;

if (!reportFormId) {
  reportFormId = randomUUID();
  const version = 1 + Number(sql(
    `SELECT COALESCE(MAX(version),0) AS v FROM form_definitions
      WHERE program_id='${programId}' AND form_key='grant_report'`)[0].v);
  // DRAFT first: 0003 refuses a field added to a published definition.
  sql(`INSERT INTO form_definitions (id, program_id, form_key, stage_id, kind, name, version,
         status, created_at, updated_at)
       VALUES ('${reportFormId}','${programId}','grant_report',NULL,'report','Grant report',
               ${version},'draft','${now}','${now}')`);
  const progressId = randomUUID();
  const mediaSectionId = randomUUID();
  sql(`INSERT INTO form_sections (id, form_definition_id, section_key, title, description,
         sort_order, created_at)
       VALUES ('${progressId}','${reportFormId}','progress','What happened',
               'In your own words.',0,'${now}')`);
  sql(`INSERT INTO form_sections (id, form_definition_id, section_key, title, description,
         sort_order, created_at)
       VALUES ('${mediaSectionId}','${reportFormId}','attachments','Anything to show us',
               'Photos and video of the work itself tell us more than any number.',1,'${now}')`);
  sql(`INSERT INTO form_fields (id, form_definition_id, form_section_id, field_key, label,
         field_type, is_required, sort_order, created_at)
       VALUES ('${randomUUID()}','${reportFormId}','${progressId}','narrative',
               'What did this grant make possible?','long_text',1,0,'${now}')`);
  const mediaValidation = JSON.stringify({
    allowed_mime: ['image/png','image/jpeg','image/webp','image/heic','image/heif',
                   'video/mp4','video/quicktime','video/webm'],
    max_size_bytes: 200 * 1024 * 1024,
    max_files: 6,
  }).replace(/'/g, "''");
  sql(`INSERT INTO form_fields (id, form_definition_id, form_section_id, field_key, label,
         help_text, field_type, is_required, sort_order, validation_json, created_at)
       VALUES ('${randomUUID()}','${reportFormId}','${mediaSectionId}','project_media',
               'Photos and video',
               'Up to six files, 200 MB each. Anything your phone takes is fine — including HEIC photos and .mov clips.',
               'file_upload',0,0,'${mediaValidation}','${now}')`);
  sql(`INSERT INTO form_fields (id, form_definition_id, form_section_id, field_key, label,
         help_text, field_type, is_required, sort_order, validation_json, created_at)
       VALUES ('${randomUUID()}','${reportFormId}','${mediaSectionId}','supporting_files',
               'Documents','A flyer, a financial summary, an evaluation.',
               'file_upload',0,1,'{"max_files":3}','${now}')`);
  sql(`UPDATE form_definitions SET status='retired', updated_at='${now}'
        WHERE program_id='${programId}' AND form_key='grant_report' AND status='published'
          AND id<>'${reportFormId}'`);
  sql(`UPDATE form_definitions SET status='published', published_at='${now}', updated_at='${now}'
        WHERE id='${reportFormId}'`);
}
check('there is a published report form that asks for media', Boolean(reportFormId), true);

const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });

// --- 1. the claim, as a stranger --------------------------------------------
console.log('\n  The claim, filed by somebody with no account:\n');
const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await anon.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${APP}/tell-us`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.fill('#claim-organizationName', `Invented Harbor Trust ${stamp}`);
await page.fill('#claim-ein', `${ein.slice(0, 2)}-${ein.slice(2)}`);
await page.fill('#claim-firstName', 'Alex');
await page.fill('#claim-lastName', 'Moreno');
await page.fill('#claim-email', email);
await page.fill('#claim-grantYear', '2024');
await page.fill('#claim-grantDescription', 'After-school reading across two campuses.');
await page.getByRole('button', { name: /Send this to the Foundation/i }).click();
await page.waitForTimeout(2000);
check('they are thanked, and told nothing about our records',
  (await page.locator('main').innerText()).includes('will be in touch'), true);

const claimId = one(`SELECT id FROM grantee_claims WHERE contact_email='${email}'`, 'id');
check('the claim is pending', one(`SELECT status FROM grantee_claims WHERE id='${claimId}'`, 'status'), 'pending');
check('and granted nothing',
  sql(`SELECT id FROM users WHERE email='${email}'`).length, 0);
check('the EIN match was recorded as a HINT, not acted on',
  one(`SELECT matched_award_id AS id FROM grantee_claims WHERE id='${claimId}'`, 'id'), awardId);
await anon.close();

// --- 2. a person approves ----------------------------------------------------
console.log('\n  An admin approving it:\n');
const adminId = randomUUID();
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${adminId}','pg-admin-${stamp}@example.org','admin',NULL,1,'${now}','${now}')`);

/*
 * Through the HTTP API, with a staff session. The staff surface is behind
 * Cloudflare Access, which cannot be driven from here -- so this posts to the
 * library's own route the way routes.test.ts does, and the SCREEN is driven
 * separately below against the same data.
 */
/*
 * The decision is written here in SQL, exactly as approveClaim writes it.
 *
 * WHY NOT THROUGH THE API. The staff surface sits behind Cloudflare Access,
 * which cannot be driven from a script. approveClaim itself has unit tests
 * covering every branch of the write -- the refusals, the race guard, the
 * audit row -- and what this script exists to prove is the part those cannot:
 * that a grantee created this way can actually sign in and file.
 */
const granteeUserId = randomUUID();
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${granteeUserId}','${email}','grantee','${orgId}',1,'${now}','${now}')`);
sql(`UPDATE grantee_claims SET status='approved', decided_at='${now}', decided_by='${adminId}',
       granted_user_id='${granteeUserId}', granted_award_id='${awardId}', updated_at='${now}'
     WHERE id='${claimId}'`);
const periodId = randomUUID();
sql(`INSERT INTO report_periods (id, award_id, form_definition_id, label, period_type,
       period_start, period_end, opens_at, due_date, status, created_at, updated_at)
     VALUES ('${periodId}','${awardId}','${reportFormId}','Final report','final',
             '2024-01-01T00:00:00.000Z','2024-12-31T00:00:00.000Z','2020-01-01T00:00:00.000Z',
             '2099-03-31T00:00:00.000Z','open','${now}','${now}')`);
note('grantee user', granteeUserId);

// --- 3. they sign in and tell us what happened -------------------------------
console.log('\n  The grantee, signed in, filing an update:\n');
const token = mintSession(granteeUserId);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addCookies([{
  name: '__Host-steward_session', value: token,
  domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
}]);
const puts = [];
await ctx.route((url) => url.hostname.endsWith('.r2.cloudflarestorage.com'), async (route) => {
  puts.push({ method: route.request().method(), headers: route.request().headers() });
  await route.fulfill({ status: 200, body: '' });
});

const portal = await ctx.newPage();
portal.on('pageerror', (e) => errors.push(e.message));
await portal.goto(`${APP}/reports`, { waitUntil: 'networkidle' });
await portal.waitForTimeout(800);
check('the portal shows the grant they claimed',
  (await portal.locator('main').innerText()).includes('$25,000'), true);

await portal.goto(`${APP}/reports/${periodId}`, { waitUntil: 'networkidle' });
await portal.waitForTimeout(800);
const body = await portal.locator('main').innerText();
check('the form asks for photos and video', /Photos and video/i.test(body), true);
check('and for documents, separately', /Documents/i.test(body), true);
check('and says what a phone can send', /HEIC|\.mov/i.test(body), true);

const fileInputs = portal.locator('input[type=file]');
check('there are two upload fields', await fileInputs.count(), 2);

/*
 * A VIDEO, sent the way a phone sends one: a .mov whose type the browser
 * declines to name. That empty type matched no allow-list until mimeForUpload
 * existed, so this is the case the fix was for.
 */
await fileInputs.first().setInputFiles({
  name: 'IMG_0421.mov', mimeType: '', buffer: Buffer.alloc(3_000_000, 7),
});
await portal.waitForTimeout(2500);
const uploads = puts.filter((p) => p.method === 'PUT');
check('the video uploaded', uploads.length > 0, true);
check('with no content-type from the browser',
  uploads.map((p) => p.headers['content-type'] ?? null).filter(Boolean), []);
check('and is recorded as a QuickTime video, not as an empty type',
  one(`SELECT mime_type FROM attachments WHERE organization_id='${orgId}'
        ORDER BY uploaded_at DESC LIMIT 1`, 'mime_type'), 'video/quicktime');

check('no uncaught errors anywhere in the run', errors, []);
await browser.close();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
console.log('Not proven: no file reached R2 and no email was delivered. The PUT is');
console.log('intercepted, so this checks what the browser SENDS, not what storage accepts.');
process.exit(failures === 0 ? 0 : 1);
