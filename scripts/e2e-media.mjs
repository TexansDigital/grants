/**
 * Photos and video, from a grantee's file picker to a row in the database.
 *
 *   npm run e2e:media
 *
 * WHY A SEPARATE SCRIPT FROM e2e-grantee. That one drives a report form this
 * repository wrote by hand in SQL, and the only upload on it is a document. The
 * thing the Foundation actually asked for -- a past grantee showing what their
 * funding did, with pictures and a clip -- runs through a DIFFERENT field with
 * different limits, different types, and a filter on the operating system's
 * file picker that no unit test can see. So this script drives the form
 * planReportForm really produces, through a real Chromium picker.
 *
 * THE FAULT THAT PROMPTED IT, so it is not lost. The accept attribute was
 * built from mime types alone. Chrome on Windows and on Android carries no
 * mapping from image/heic to a file extension, so accept="image/heic" greys
 * out every HEIC photo on the device -- which is every photo an iPhone has
 * taken. There is no error. The file simply cannot be picked, and what the
 * grantee concludes is that their photos are not allowed. The suite was green
 * throughout: validateUploadIntent accepted HEIC perfectly well, and nothing
 * had ever looked at the attribute that decides whether the file reaches it.
 *
 * WHAT IT DOES NOT PROVE, and must not be reported as proving:
 *   - No byte reaches R2. The PUT is intercepted and answered locally. Whether
 *     R2 accepts it needs real credentials and a real bucket; the round trip
 *     was proven once by hand and no test here can tell you it still works.
 *   - It cannot prove the picker filter on a phone. Chromium on Linux applies
 *     accept to its own dialog, which Playwright bypasses by setting files
 *     directly. What is asserted is the ATTRIBUTE -- that the extensions a
 *     phone produces are in it -- which is the part that was wrong.
 *   - A 200 MB video is not uploaded. Generating one to prove a comparison
 *     would cost a gigabyte of disk to test an integer. The limit is asserted
 *     from the rendered field and unit-tested at the boundary.
 *   - Not a security review, not an accessibility test.
 *
 * PREREQUISITES: `npm run build:web`, then `npm run dev` on 8787, against a
 * local database migrated and seeded. Invented data only, local preview only.
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
const truthy = (label, value) => {
  const ok = Boolean(value);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(value)}`}`);
};
const note = (label, value) => console.log(`      ${label}: ${value}`);

function sql(statement) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'steward-preview', '--local', '--json', '--command', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

function one(statement, column) {
  const rows = sql(statement);
  if (rows.length === 0) throw new Error(`no rows for: ${statement}`);
  return rows[0][column];
}

function sessionsNamespaceId() {
  const toml = readFileSync('wrangler.toml', 'utf8');
  const block = toml.split('[[kv_namespaces]]').find((b) => /binding\s*=\s*"SESSIONS"/.test(b));
  const id = block && /\bid\s*=\s*"([^"]+)"/.exec(block)?.[1];
  if (!id) throw new Error('could not find the SESSIONS namespace id in wrangler.toml');
  return id;
}

const workdir = mkdtempSync(join(tmpdir(), 'steward-media-'));

function mintSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const key = `session:${createHash('sha256').update(token).digest('hex')}`;
  const file = join(workdir, 'session.json');
  writeFileSync(
    file,
    JSON.stringify({
      userId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }),
  );
  execFileSync(
    'npx',
    ['wrangler', 'kv', 'key', 'put', key, `--path=${file}`,
     `--namespace-id=${sessionsNamespaceId()}`, '--local'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return token;
}

console.log('Steward — a grantee showing what the money did\n');

// --- fixtures ---------------------------------------------------------------
// Invented throughout. EINs begin 00, which is not an assignable IRS prefix, so
// a fixture can never collide with a real organization.
const ids = { org: randomUUID(), user: randomUUID(), award: randomUUID(), form: randomUUID() };
const now = new Date().toISOString();
const stamp = Date.now().toString().slice(-6);
const ein = `00${stamp}0`;

/*
 * The fixtures program, never the real one.
 *
 * src/seed/secondProgram.ts says in as many words that it exists so anything
 * invented has somewhere to live that is not Inspire Change. Publishing a
 * report form retires whatever was published before it for the same form key,
 * so pointing this at the real program would quietly retire the form the
 * Foundation is about to use.
 */
const programId = one(
  `SELECT id FROM programs WHERE slug='community-futures-fund' AND deleted_at IS NULL`, 'id');
note('program (fixtures)', programId);

const metricSpecs = [
  { metric_key: `served_${stamp}`, label: 'How many people did this reach?',
    metric_type: 'integer', unit: 'people', is_required: 1, sort_order: 10, promotes_to: null },
  /*
   * No promotes_to, deliberately. Only one metric per program may promote to
   * funds_spent_cents -- the schema enforces it, and it caught this on the
   * second run of this script. Rerunning a harness must not depend on being
   * the first thing to claim a slot, and what promotion does has its own tests.
   */
  { metric_key: `spent_${stamp}`, label: 'How much of the grant has been spent?',
    metric_type: 'currency', unit: null, is_required: 1, sort_order: 20,
    promotes_to: null },
];
const metrics = metricSpecs.map((spec) => {
  const id = randomUUID();
  sql(`INSERT INTO metric_definitions
         (id, program_id, metric_key, label, help_text, metric_type, unit, is_required,
          sort_order, status, promotes_to, created_at, updated_at)
       VALUES ('${id}','${programId}','${spec.metric_key}','${spec.label}',NULL,
               '${spec.metric_type}',${spec.unit ? `'${spec.unit}'` : 'NULL'},
               ${spec.is_required},${spec.sort_order},'active',
               ${spec.promotes_to ? `'${spec.promotes_to}'` : 'NULL'},'${now}','${now}')`);
  return { ...spec, id, help_text: null };
});

/*
 * The form, from the real planner.
 *
 * Not hand-written SQL. See scripts/buildReportFormSql.ts for why that matters
 * more than it looks: the hand-written copy in e2e-grantee.mjs has drifted from
 * reportForm.ts twice, and both times the drift was silent.
 */
const formKey = `grant_report_media_${stamp}`;
const version = 1;
const emitted = execFileSync(
  'npm',
  ['run', '--silent', 'reportform:build', '--',
   programId, ids.form, formKey, String(version), JSON.stringify(metrics)],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const sqlPath = join(workdir, 'report-form.sql');
writeFileSync(sqlPath, emitted);
execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'steward-preview', '--local', `--file=${sqlPath}`],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
note('report form', ids.form);

/*
 * The form is the real one, so ASSERT that before driving it. A planner change
 * that dropped the media field would otherwise show up as a confusing missing
 * element forty lines below.
 */
const mediaField = sql(
  `SELECT field_type, validation_json, is_required FROM form_fields
    WHERE form_definition_id='${ids.form}' AND field_key='project_media'`)[0];
truthy('the real planner puts a photos-and-video field on a report form', mediaField);
check('and it is a file upload', mediaField?.field_type, 'file_upload');
check('and it is optional, because evidence of joy is not a condition of funding',
  mediaField?.is_required, 0);
const mediaValidation = JSON.parse(mediaField?.validation_json ?? '{}');
check('and it accepts more than one file', mediaValidation.max_files, 6);
truthy('and it allows video', (mediaValidation.allowed_mime ?? []).includes('video/quicktime'));

sql(`INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES ('${ids.org}','Invented Bayou Youth Collective ${stamp}','${ein}','active','${now}','${now}')`);
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${ids.user}','media-${stamp}@example-invented.org','grantee','${ids.org}',1,'${now}','${now}')`);
sql(`INSERT INTO awards
       (id, organization_id, program_id, awarded_amount_cents, awarded_at, status,
        source_system, source_reference, term_start, term_end, created_at, updated_at)
     VALUES ('${ids.award}','${ids.org}','${programId}',1500000,'${now}','active',
             'spreadsheet','E2E-MEDIA-${stamp}','2025-01-01T00:00:00.000Z',
             '2025-12-31T00:00:00.000Z','${now}','${now}')`);

const periodId = randomUUID();
sql(`INSERT INTO report_periods
       (id, award_id, form_definition_id, label, period_type, period_start, period_end,
        opens_at, due_date, status, created_at, updated_at)
     VALUES ('${periodId}','${ids.award}','${ids.form}','Final report','final',
             '2025-01-01T00:00:00.000Z','2025-12-31T00:00:00.000Z','2026-01-01T00:00:00.000Z',
             '2026-03-31T00:00:00.000Z','scheduled','${now}','${now}')`);

// --- the files a grantee actually has ---------------------------------------
/*
 * Real bytes, because Chromium types a file from its contents and extension
 * and an empty file is not typed at all. None of these are valid media beyond
 * their opening bytes -- nothing decodes them, here or in the Worker, which is
 * itself worth remembering: R2 does no malware scanning and neither does this.
 */
const files = {};
function makeFile(name, header, padBytes) {
  const path = join(workdir, name);
  writeFileSync(path, Buffer.concat([Buffer.from(header), Buffer.alloc(padBytes, 7)]));
  files[name] = path;
  return path;
}
// A genuine 1x1 PNG, signature and all.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
writeFileSync(join(workdir, 'classroom.png'), PNG_1x1);
files['classroom.png'] = join(workdir, 'classroom.png');
// An MP4 ftyp box. Enough for the browser to name it; not a playable video.
makeFile('opening-day.mp4', [
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
], 4096);
// The one an iPhone produces, and the one the accept attribute used to hide.
makeFile('IMG_4821.HEIC', [
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
], 2048);
// A document, offered to the media field on purpose. It must be refused.
makeFile('budget.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34], 512);

const token = mintSession(ids.user);
note('organization', ids.org);
note('report period', periodId);

// --- drive ------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: BROWSER });
const context = await browser.newContext();
await context.addCookies([{
  name: '__Host-steward_session', value: token,
  domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
}]);

/*
 * The upload, intercepted. Nothing leaves this machine.
 *
 * What is checked is the SHAPE of the request: PUT, and no Content-Type.
 * signQuery signs only the host header, so any Content-Type the browser adds
 * falls outside the signature and R2 answers 403 -- while the identical request
 * made by hand, without the header, succeeds. CLAUDE.md records it as learned
 * the hard way.
 */
const puts = [];
await context.route(
  (url) => url.hostname.endsWith('.r2.cloudflarestorage.com'),
  async (route) => {
    const r = route.request();
    puts.push({ method: r.method(), headers: r.headers(), url: r.url() });
    await route.fulfill({
      status: 200,
      body: '',
      headers: r.method() === 'GET' ? { 'content-disposition': 'attachment; filename="x"' } : {},
    });
  },
);

const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`${APP}/reports`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'File this report' }).click();
await page.waitForSelector('#field-project_media', { timeout: 15_000 });

// ---- the picker's filter ---------------------------------------------------
/*
 * The assertion this whole script was written for.
 *
 * accept is what the operating system's file dialog filters on. A mime type the
 * browser cannot map to an extension filters out every matching file with no
 * error at all, and the two types a phone produces -- HEIC photos and .mov
 * clips -- are exactly the two Chrome cannot map on Windows or Android.
 */
const mediaInput = page.locator('#field-project_media input[type="file"]');
truthy('the report form offers somewhere to put photos and video', await mediaInput.count() > 0);
const accept = (await mediaInput.getAttribute('accept')) ?? '';
note('accept', accept);
for (const ext of ['.heic', '.heif', '.mov', '.mp4', '.png', '.jpg']) {
  truthy(`a file picker filtering on accept will show ${ext} files`, accept.includes(ext));
}
truthy('and the mime types are still there for the browsers that map them',
  accept.includes('image/heic') && accept.includes('video/quicktime'));
check('a grantee can choose several at once', await mediaInput.getAttribute('multiple'), '');

const docInput = page.locator('#field-supporting_files input[type="file"]');
const docAccept = (await docInput.getAttribute('accept')) ?? '';
truthy('the documents field filters to documents', docAccept.includes('.pdf'));
truthy('and does not offer to take a video', !docAccept.includes('.mov'));

// ---- a photo and a clip ----------------------------------------------------
/*
 * Not input.files.length. UploadField clears the input after every batch so the
 * same file can be picked twice, so polling that reads a value the component
 * resets by design. A finished upload is the one with a Remove beside it.
 */
/*
 * COUNT the finished uploads, do not merely look for one.
 *
 * The first version of this waited for any Remove button in the container.
 * After the first batch there is always one, so the second call returned true
 * instantly while the file it was given had in fact been refused -- and the
 * check reported PASS forty lines above the assertion that caught it. A
 * harness that can pass without the thing happening is worse than no harness.
 */
async function attach(locator, containerId, paths, expectedTotal) {
  await locator.setInputFiles(paths);
  try {
    await page.waitForFunction(
      ([id, n]) =>
        /*
         * Rows that have a Remove control, not rows.
         *
         * UploadField renders TWO upload-lists: the finished attachments and
         * the ones still in the air. Counting `li` counts both, so two files
         * mid-upload satisfied a wait for two attachments and this returned
         * while nothing had reached storage yet -- which is how the run above
         * reported three uploads and intercepted none. The in-flight row has a
         * progress element and no buttons; the finished one has Open and
         * Remove. That difference is the whole test.
         */
        [...document.querySelectorAll(`#${id} .upload-list li`)]
          .filter((li) => li.querySelector('button')).length === n,
      [containerId, expectedTotal],
      { timeout: 20_000 },
    );
    return true;
  } catch {
    const errs = await page.locator(`#${containerId} .upload-errors`).allInnerTexts();
    note('upload errors on the page', errs.length ? errs.join(' | ') : '(none shown)');
    note('attached now', (await page.locator(`#${containerId} .upload-name`).allInnerTexts()).join(', '));
    return false;
  }
}

truthy('a photo and a video upload together',
  await attach(mediaInput, 'field-project_media',
    [files['classroom.png'], files['opening-day.mp4']], 2));
const shown = await page.locator('#field-project_media .upload-name').allInnerTexts();
check('both are shown back to the grantee', shown.sort(),
  ['classroom.png', 'opening-day.mp4']);

// The photo an iPhone takes, which the old accept attribute hid.
truthy('a HEIC photo straight off a phone is accepted',
  await attach(mediaInput, 'field-project_media', [files['IMG_4821.HEIC']], 3));

check('every upload was a PUT', [...new Set(puts.map((p) => p.method))], ['PUT']);
check('and the browser sent no content-type on any of them',
  puts.map((p) => p.headers['content-type'] ?? null).filter(Boolean), []);

// ---- a document offered to the media field ---------------------------------
/*
 * Refused, with a reason a person can act on. The server refuses it too; this
 * is about whether the grantee is told why before waiting for an upload.
 */
await mediaInput.setInputFiles([files['budget.pdf']]);
await page.waitForSelector('#field-project_media .upload-errors', { timeout: 10_000 });
const refusal = (await page.locator('#field-project_media .upload-errors').innerText()).trim();
note('refusal', refusal);
truthy('a PDF offered as a photo is refused', refusal.includes('budget.pdf'));
truthy('and the refusal says what would be accepted instead',
  /image or video/i.test(refusal));
// "a image or video file" is not a sentence anybody wrote on purpose.
truthy('and it is written in English', !/\ba image\b/i.test(refusal));
check('nothing was uploaded for it', puts.length, 3);

// ---- file the report -------------------------------------------------------
await page.fill('textarea[name="narrative"]',
  'We ran the summer program for twelve weeks and the photos are from the last day.');
await page.fill(`input[name="metric_served_${stamp}"]`, '312');
await page.fill(`input[name="metric_spent_${stamp}"]`, '15000.00');
await page.getByRole('button', { name: 'Send this report' }).click();
await page.waitForSelector('text=/thank|received|filed/i', { timeout: 20_000 });

// ---- what actually landed --------------------------------------------------
const submissionId = sql(
  `SELECT id FROM report_submissions WHERE report_period_id='${periodId}'
     AND submitted_at IS NOT NULL`)[0]?.id;
truthy('the report is filed', submissionId);

const stored = sql(
  `SELECT filename, mime_type FROM attachments
    WHERE parent_type='report_submission' AND parent_id='${submissionId}'
    ORDER BY filename`);
check('all three files are attached to the submission', stored.length, 3);
check('and the filenames survived', stored.map((r) => r.filename),
  ['IMG_4821.HEIC', 'classroom.png', 'opening-day.mp4']);
note('stored mime types', stored.map((r) => `${r.filename}=${r.mime_type || '(empty)'}`).join(' '));
/*
 * The HEIC one is the point. Whatever Chromium declared -- and on some
 * platforms it declares nothing at all -- what is STORED has to be a type the
 * field allows, because that is what the retention screen and any future
 * viewer read. mimeForUpload fills the blank from the extension; this is the
 * only place that path is driven by a real browser.
 */
const heic = stored.find((r) => r.filename === 'IMG_4821.HEIC');
check('the phone photo is stored as a photo, whatever the browser called it',
  heic?.mime_type, 'image/heic');
check('the video is stored as a video', stored.find((r) => r.filename === 'opening-day.mp4')?.mime_type,
  'video/mp4');

const metricRows = sql(
  `SELECT COUNT(*) AS n FROM metric_values mv
     JOIN report_submissions rs ON rs.id = mv.report_submission_id
    WHERE rs.id='${submissionId}'`);
check('the numbers were recorded alongside the pictures', metricRows[0]?.n, 2);

check('no console errors', consoleErrors, []);

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
