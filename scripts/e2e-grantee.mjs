/**
 * The grantee path, driven end to end in a real browser against a real local
 * Worker and D1.
 *
 *   npm run e2e:grantee
 *
 * WHY A BROWSER, again. Every fault in the applicant path that reached a
 * user-visible state was invisible to the unit tests -- an autosave engine
 * disposed by a StrictMode remount, a render loop from an unstable hook handle,
 * a timestamp in the wrong timezone. The report form reuses all three of those
 * mechanisms. Reusing them is not the same as having driven them.
 *
 * WHAT IT DOES NOT PROVE, and must not be reported as proving:
 *   - No email is delivered; preview has no RESEND_API_KEY.
 *   - No file reaches R2. The upload IS driven and its request inspected --
 *     PUT, and no Content-Type, which is the rule R2 punishes with a 403 that
 *     does not reproduce in curl -- but the PUT is intercepted and answered
 *     locally. Whether R2 accepts it needs real credentials and a real bucket,
 *     and no test in this repository can tell you.
 *   - It is not a security review and not an accessibility test. It checks
 *     that the page renders, saves, survives a reload on another "device",
 *     refuses an incomplete report and files a complete one.
 *
 * PREREQUISITES: `npm run build:web`, then `npm run dev` on 8787, against a
 * local database migrated and seeded. It writes invented data only, to the
 * local preview database.
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

/** One SQL statement against the LOCAL database. Never remote: see CLAUDE.md. */
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

/**
 * Mint a session directly in KV.
 *
 * Driving the real magic link cannot work here: the token is stored hashed and
 * the email carrying it is suppressed, so there is nothing to click. Sign-in
 * has its own tests; this script is about the path after it.
 */
function mintSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const key = `session:${createHash('sha256').update(token).digest('hex')}`;
  const file = join(mkdtempSync(join(tmpdir(), 'steward-e2e-')), 'session.json');
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

console.log('Steward — grantee reporting, end to end\n');

// --- fixtures ---------------------------------------------------------------
// Invented throughout. EINs begin 00, which is not an assignable IRS prefix, so
// a fixture can never collide with a real organization. Never copy a real row.
const ids = { org: randomUUID(), user: randomUUID(), award: randomUUID() };
const now = new Date().toISOString();
const stamp = Date.now().toString().slice(-6);
const ein = `00${stamp}0`;
if (ein.length !== 9) throw new Error(`fixture EIN must be nine digits, got ${ein}`);

const programId = one(
  `SELECT id FROM programs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`, 'id');

/*
 * Metrics, then the report form scaffolded from them.
 *
 * Done through SQL rather than the importer because this script is about the
 * BROWSER; the importer has its own tests. The shapes here match what
 * buildReportForm expects, and if they drift this script fails loudly at the
 * form-scaffold step rather than quietly rendering an empty page.
 */
const metrics = [
  ['individuals_served', 'How many individuals did this grant directly serve?', 'integer', 'people', 1, 10, 'NULL'],
  ['funds_spent', 'How much of the grant has been spent?', 'currency', 'NULL', 1, 20, "'funds_spent_cents'"],
  ['volunteer_hours', 'Volunteer hours contributed', 'decimal', 'hours', 0, 30, 'NULL'],
];
const metricIds = {};
for (const [key, label, type, unit, required, order, promotes] of metrics) {
  const existing = sql(
    `SELECT id FROM metric_definitions WHERE program_id='${programId}' AND metric_key='${key}'`);
  if (existing.length > 0) {
    metricIds[key] = existing[0].id;
    continue;
  }
  const id = randomUUID();
  metricIds[key] = id;
  sql(`INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
          status, promotes_to, created_at, updated_at)
       VALUES ('${id}','${programId}','${key}','${label}','${type}',
               ${unit === 'NULL' ? 'NULL' : `'${unit}'`},${required},${order},
               'active',${promotes},'${now}','${now}')`);
}

/*
 * A published report form.
 *
 * Built here in SQL, mirroring buildReportForm's output, for the same reason as
 * the metrics: the scaffolder has its own tests and 29 mutants behind it. What
 * this script needs is a form on the other end of an HTTP request.
 */
/**
 * Every field this harness drives. The reuse check below requires ALL of them.
 */
const DRIVEN_FIELDS = [
  'narrative',
  'challenges',
  'metric_individuals_served',
  'metric_funds_spent',
  'metric_volunteer_hours',
  'supporting_files',
];

/*
 * A published report form THAT HAS THE FIELDS THIS SCRIPT DRIVES.
 *
 * Two different ways this has gone wrong, both silent:
 *
 *   A published definition is immutable by trigger, so a run that published one
 *   before writing its fields leaves an empty form behind -- and a check for
 *   "has any fields" is what that trap needs.
 *
 *   Then a check for "has any fields" turned out to be its own trap. When this
 *   script grew an attachments section, every existing database already held a
 *   published form from the OLDER revision, which satisfied "any fields" and so
 *   was reused forever. The new section was never built and the new assertion
 *   failed thirty seconds away from the cause.
 *
 * So: require exactly the set this script actually drives. Adding a field above
 * now forces a fresh form instead of quietly reusing a stale one.
 */
let formId = sql(
  `SELECT fd.id FROM form_definitions fd
    WHERE fd.program_id='${programId}' AND fd.kind='report' AND fd.status='published'
      AND fd.deleted_at IS NULL
      AND (SELECT COUNT(*) FROM form_fields ff
            WHERE ff.form_definition_id = fd.id
              AND ff.field_key IN (${DRIVEN_FIELDS.map((f) => `'${f}'`).join(',')})
          ) = ${DRIVEN_FIELDS.length}
    LIMIT 1`)[0]?.id;

if (!formId) {
  formId = randomUUID();
  /*
   * DRAFT first, published last.
   *
   * form_definitions is immutable once published -- 0003 enforces it with a
   * trigger on form_sections and form_fields, not by convention -- so writing
   * the fields into an already-published definition is refused outright. That
   * is the schema working; the script just has to do it in the right order.
   */
  const version = 1 + Number(sql(
    `SELECT COALESCE(MAX(version),0) AS v FROM form_definitions
      WHERE program_id='${programId}' AND form_key='grant_report'`)[0].v);
  sql(`INSERT INTO form_definitions
         (id, program_id, form_key, stage_id, kind, name, version, status,
          created_at, updated_at)
       VALUES ('${formId}','${programId}','grant_report',NULL,'report','Grant report',
               ${version},'draft','${now}','${now}')`);

  const sections = [
    ['progress', 'What happened', 'In your own words. Short and specific beats long and general.', 0],
    ['metrics', 'The numbers', 'Your best available figures.', 1],
    // Mirrors what reportForm.ts generates for every program. Optional on the
    // form and, until this section existed here, driven by nothing at all.
    ['attachments', 'Anything to show us', 'Optional. Photos, a flyer, a financial summary.', 2],
  ];
  const sectionIds = {};
  for (const [key, title, description, order] of sections) {
    const id = randomUUID();
    sectionIds[key] = id;
    sql(`INSERT INTO form_sections (id, form_definition_id, section_key, title, description, sort_order, created_at)
         VALUES ('${id}','${formId}','${key}','${title}','${description}',${order},'${now}')`);
  }

  const fields = [
    ['progress', 'narrative', 'What did this grant make possible?', 'long_text', 1, 0, 'NULL', 'NULL'],
    ['progress', 'challenges', 'What got in the way?', 'long_text', 0, 1, 'NULL', 'NULL'],
    ['metrics', 'metric_individuals_served', 'How many individuals did this grant directly serve?',
     'integer', 1, 0, `'{"min":0,"unit_label":"people"}'`, `'${metricIds.individuals_served}'`],
    ['metrics', 'metric_funds_spent', 'How much of the grant has been spent?',
     'currency', 1, 1, 'NULL', `'${metricIds.funds_spent}'`],
    ['metrics', 'metric_volunteer_hours', 'Volunteer hours contributed',
     'decimal', 0, 2, `'{"min":0,"unit_label":"hours"}'`, `'${metricIds.volunteer_hours}'`],
    ['attachments', 'supporting_files', 'Attach up to three files',
     'file_upload', 0, 0, `'{"max_files":3}'`, 'NULL'],
  ];
  for (const [section, key, label, type, required, order, validation, metricId] of fields) {
    sql(`INSERT INTO form_fields
           (id, form_definition_id, form_section_id, field_key, label, field_type,
            is_required, sort_order, validation_json, metric_definition_id, created_at)
         VALUES ('${randomUUID()}','${formId}','${sectionIds[section]}','${key}','${label}',
                 '${type}',${required},${order},${validation},${metricId},'${now}')`);
  }

  // Retire any earlier published version first: only one published form per
  // (program, form_key) is permitted, and an empty one from a failed run is
  // exactly what that index is there to stop being used.
  sql(`UPDATE form_definitions SET status='retired', updated_at='${now}'
        WHERE program_id='${programId}' AND form_key='grant_report'
          AND status='published' AND id<>'${formId}'`);
  sql(`UPDATE form_definitions SET status='published', published_at='${now}', updated_at='${now}'
        WHERE id='${formId}'`);
}
note('report form', formId);

sql(`INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES ('${ids.org}','Invented Harbor Trust ${stamp}','${ein}','active','${now}','${now}')`);
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${ids.user}','grantee-${stamp}@example-invented.org','grantee','${ids.org}',1,'${now}','${now}')`);
sql(`INSERT INTO awards
       (id, organization_id, program_id, awarded_amount_cents, awarded_at, status,
        source_system, source_reference, term_start, term_end, created_at, updated_at)
     VALUES ('${ids.award}','${ids.org}','${programId}',2500000,'${now}','active',
             'spreadsheet','E2E-${stamp}','2025-01-01T00:00:00.000Z','2025-12-31T00:00:00.000Z',
             '${now}','${now}')`);

const periodId = randomUUID();
sql(`INSERT INTO report_periods
       (id, award_id, form_definition_id, label, period_type, period_start, period_end,
        opens_at, due_date, status, created_at, updated_at)
     VALUES ('${periodId}','${ids.award}','${formId}','Final report','final',
             '2025-01-01T00:00:00.000Z','2025-12-31T00:00:00.000Z','2026-01-01T00:00:00.000Z',
             '2026-03-31T00:00:00.000Z','scheduled','${now}','${now}')`);

const token = mintSession(ids.user);
note('organization', ids.org);
note('award', ids.award);
note('report period', periodId);

// --- drive ------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: BROWSER });
const context = await browser.newContext();
// The __Host- prefix requires secure, path=/ and no domain attribute. Playwright
// needs the domain spelled out anyway, and Chrome accepts secure on 127.0.0.1.
await context.addCookies([{
  name: '__Host-steward_session', value: token,
  domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
}]);
/*
 * THE UPLOAD, intercepted.
 *
 * Nothing leaves this machine: the presigned URL points at a bucket these
 * invented credentials cannot reach, and sending bytes is not what is being
 * checked. What IS being checked is the SHAPE of the request the browser makes,
 * because that is where this has failed before and where the failure does not
 * reproduce from curl:
 *
 *   signQuery signs only the host header. Any Content-Type the browser adds is
 *   outside the signature, and R2 answers 403 -- while the identical request
 *   made by hand, without that header, succeeds. CLAUDE.md records this as
 *   "learned the hard way, do not deviate".
 *
 * So the assertions below are: PUT, and no content-type. Everything else about
 * R2's answer needs real credentials and a real bucket, and is not provable
 * here. See the header of this file.
 */
const puts = [];
// A PREDICATE, not a glob. The glob spelling used elsewhere in this repo
// silently matched nothing here, so the upload went out un-inspected and the
// assertions below reported "no upload" while the file uploaded fine. A
// predicate says exactly what it means and cannot be read two ways.
await context.route(
  (url) => url.hostname.endsWith('.r2.cloudflarestorage.com'),
  async (route) => {
    const r = route.request();
    puts.push({ method: r.method(), headers: r.headers(), url: r.url() });
    /*
     * A DOWNLOAD, NOT A NAVIGATION, for the GET. `content-disposition:
     * attachment` is what the real signed URL carries, and it is also what
     * stops Chromium replacing the portal page when the grantee opens a file
     * they filed.
     */
    await route.fulfill({
      status: 200,
      body: '',
      headers:
        r.method() === 'GET'
          ? { 'content-disposition': 'attachment; filename="x.pdf"' }
          : {},
    });
  },
);

const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));
// A bare "404 (Not Found)" in the console names nothing. Record the URL, so a
// missing asset is a fact rather than a mystery.
const notFound = [];
page.on('response', (r) => {
  if (r.status() === 404) notFound.push(r.url());
});

// ---- the one page ----------------------------------------------------------
await page.goto(`${APP}/reports`, { waitUntil: 'networkidle' });

check('the page names the organization', await page.locator('h2').first().innerText(),
  `Invented Harbor Trust ${stamp}`);
truthy('the award amount is shown in dollars, not cents',
  (await page.locator('.portal-amount').first().innerText()).includes('$25,000'));
check('the outstanding report is called out', await page.locator('#todo-heading').innerText(),
  'One report to file');

const fileButton = page.getByRole('button', { name: 'File this report' });
truthy('there is one button to file it', await fileButton.isVisible());

// ---- three clicks: open, fill, send ----------------------------------------
await fileButton.click();
await page.waitForURL(`**/reports/${periodId}`);
await page.waitForSelector('#field-narrative', { timeout: 10_000 });
note('landed on', page.url());

check('the report names itself', await page.locator('h2').first().innerText(), 'Final report');
truthy('the questions come from the metric definitions',
  await page.locator('#field-metric_individuals_served').isVisible());
truthy('the unit from the spreadsheet reaches the screen',
  (await page.locator('#field-metric_volunteer_hours').innerText()).includes('hours'));

// ---- an incomplete report is refused, in the grantee's own words -----------
await page.getByRole('button', { name: 'Send this report' }).click();
await page.waitForSelector('.summary', { timeout: 5_000 });
const listed = await page.locator('.summary li').allInnerTexts();
check('it refuses an incomplete report and lists what is missing', listed.length, 3);
truthy('it names the question, not the field key',
  listed.some((t) => t.includes('How many individuals did this grant directly serve?')));
check('nothing was filed', sql(
  `SELECT COUNT(*) AS n FROM report_submissions WHERE report_period_id='${periodId}'`)[0].n, 0);

// ---- autosave --------------------------------------------------------------
await page.fill('#field-narrative textarea',
  'We ran a summer reading programme across three branch libraries.');
await page.locator('#field-metric_individuals_served input').fill('412');
await page.locator('#field-metric_individuals_served input').blur();

/*
 * "Saved" is not the same as "nothing pending".
 *
 * The indicator reads "Saved just now — new changes not yet saved" while an
 * edit is still in flight, and a predicate of startsWith('Saved') matches that
 * happily. The run then read the draft out of D1 before the metric had been
 * written and reported that autosave had lost it -- a false failure, and on a
 * faster machine it would have been a false PASS instead, which is worse.
 */
await page.waitForFunction(
  () => {
    const t = document.querySelector('.actions .counter')?.textContent ?? '';
    return t.startsWith('Saved') && !t.includes('not yet saved');
  },
  { timeout: 15_000 },
);
note('indicator', await page.locator('.actions .counter').innerText());

const draftRow = sql(
  `SELECT answers_json FROM report_drafts WHERE report_period_id='${periodId}' AND submitted_at IS NULL`);
check('the draft reached the server, not just this browser', draftRow.length, 1);
truthy('and it holds what was typed',
  JSON.parse(draftRow[0].answers_json).metric_individuals_served === '412');

// ---- another device ---------------------------------------------------------
const second = await context.newPage();
await second.goto(`${APP}/reports/${periodId}`, { waitUntil: 'networkidle' });
await second.waitForSelector('#field-narrative', { timeout: 10_000 });
check('a second device sees the same answers',
  await second.locator('#field-metric_individuals_served input').inputValue(), '412');
await second.close();

// ---- an attachment -----------------------------------------------------------
// Optional on every generated report form ("Anything to show us"), and until
// now driven by nothing. A grantee attaching a photo or a financial summary is
// the ordinary case, not an edge one.
const attachPath = join(mkdtempSync(join(tmpdir(), 'steward-e2e-')), 'summer-reading-summary.pdf');
writeFileSync(attachPath, `%PDF-1.4\n% invented fixture ${stamp}\n`);

const fileInput = page.locator('#field-supporting_files input[type="file"]');
truthy('the report form offers somewhere to attach a file', await fileInput.count() > 0);

/*
 * ATTACH AND VERIFY, not attach and hope.
 *
 * setInputFiles can silently fail to stick when a re-render replaces the input
 * node between the call and the event: no error is thrown and the rest of the
 * harness then tests nothing. Found the hard way on the staff import screen.
 *
 * But the thing to verify is NOT input.files.length. UploadField clears the
 * input on purpose -- `inputRef.current.value = ''` -- so that picking the same
 * file twice fires a change event at all. Polling files.length therefore reads
 * a value the component resets by design, and reports failure while the upload
 * is working perfectly. Wait for the UPLOAD to appear instead, which is both
 * the real effect and what the grantee actually sees.
 */
let shown = false;
for (let attempt = 0; attempt < 3 && !shown; attempt += 1) {
  await fileInput.setInputFiles(attachPath);
  shown = await page
    .waitForSelector('#field-supporting_files .upload-name', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
}
if (!shown) {
  // Say WHY. An upload that failed puts its reason on the page, and a harness
  // that reports only "timed out" throws that reason away.
  const errs = await page.locator('#field-supporting_files .upload-errors').allInnerTexts();
  note('upload errors on the page', errs.length ? errs.join(' | ') : '(none shown)');
}
truthy('the attached file is shown back to the grantee', shown);

/*
 * WAIT FOR DONE, not for a name.
 *
 * .upload-name renders for an IN-FLIGHT upload as well as a finished one, so
 * seeing it means "the browser has started", not "the bytes went". The
 * assertions below then ran while the upload was still authorizing and
 * reported that no PUT had been made -- of a PUT that was made a moment later
 * and worked. A finished upload is the one with a Remove control beside it.
 */
await page.waitForSelector('#field-supporting_files button:has-text("Remove")', { timeout: 15_000 });

check('the grantee is shown what they attached',
  await page.locator('#field-supporting_files .upload-name').first().innerText(),
  'summer-reading-summary.pdf');

const uploads = puts.filter((p) => p.method === 'PUT');
truthy('the browser did issue an upload', uploads.length > 0);
check('every upload was a PUT', [...new Set(uploads.map((p) => p.method))], ['PUT']);
// The rule from CLAUDE.md. A content-type here is a 403 from R2 that does not
// reproduce in curl, and it is the single most expensive way to get this wrong.
check('the browser sent no content-type on the upload',
  uploads.map((p) => p.headers['content-type'] ?? null).filter(Boolean), []);

const attached = sql(
  `SELECT parent_type, parent_id, filename, size_bytes, r2_key FROM attachments
    WHERE uploaded_by='${ids.user}' AND deleted_at IS NULL`);
check('one attachment was recorded', attached.length, 1);
check('it belongs to a report, not an application', attached[0].parent_type, 'report_submission');
check('and is UNCLAIMED until the report is sent', attached[0].parent_id, null);
truthy('the object key is scoped to the organization',
  String(attached[0].r2_key).includes(ids.org));

// ---- file it ----------------------------------------------------------------
await page.locator('#field-metric_funds_spent input').fill('18,750.25');
await page.locator('#field-metric_funds_spent input').blur();
truthy('the money field reads the amount back to them',
  (await page.locator('#field-metric_funds_spent').innerText()).includes('$18,750.25'));

await page.getByRole('button', { name: 'Send this report' }).click();
await page.waitForSelector('.portal-done', { timeout: 15_000 });
check('it confirms in words a person would use',
  await page.locator('.portal-done h2').innerText(), 'Thank you — that is filed');

// ---- what landed ------------------------------------------------------------
const submission = sql(
  `SELECT id, funds_spent_cents FROM report_submissions WHERE report_period_id='${periodId}'`);
check('one submission', submission.length, 1);
check('money landed as integer cents', submission[0].funds_spent_cents, 1875025);

const values = sql(
  `SELECT md.metric_key, mv.value_int, mv.value_real, mv.value_text
     FROM metric_values mv JOIN metric_definitions md ON md.id = mv.metric_definition_id
    WHERE mv.report_submission_id='${submission[0].id}' ORDER BY md.sort_order`);
check('the metrics were promoted', values, [
  { metric_key: 'individuals_served', value_int: 412, value_real: null, value_text: null },
  { metric_key: 'funds_spent', value_int: 1875025, value_real: null, value_text: null },
]);

check('the period is marked submitted', one(
  `SELECT status FROM report_periods WHERE id='${periodId}'`, 'status'), 'submitted');
check('the draft is closed', sql(
  `SELECT COUNT(*) AS n FROM report_drafts
    WHERE report_period_id='${periodId}' AND submitted_at IS NULL`)[0].n, 0);
const claimed = sql(
  `SELECT parent_id FROM attachments WHERE uploaded_by='${ids.user}' AND deleted_at IS NULL`);
check('the attachment is claimed by the submission it was filed with',
  claimed[0].parent_id, submission[0].id);

check('it is audited', sql(
  `SELECT COUNT(*) AS n FROM audit_log
    WHERE action='report.submitted' AND entity_id='${submission[0].id}'`)[0].n, 1);

// ---- back to the page -------------------------------------------------------
await page.getByRole('button', { name: 'Back to your grants' }).click();
await page.waitForURL('**/reports');
await page.waitForSelector('.portal-award', { timeout: 10_000 });
check('nothing is outstanding any more', await page.locator('#todo-heading').count(), 0);
truthy('and the report reads as sent',
  (await page.locator('.portal-chip').first().innerText()) === 'Sent');

/*
 * AND WHAT THEY SENT WITH IT IS STILL READABLE.
 *
 * "Did I send the right budget?" is asked most often AFTER submitting, which
 * is exactly the moment this page could not answer. A grantee could attach a
 * document to a report and never see it again -- the same gap the application
 * form had, in the place a grantee comes back to.
 */
const filed = page.locator('.portal-files button');
check('the file filed with the report is listed afterwards', await filed.count(), 1);
check('and it is named, not called "attachment"',
  await filed.first().innerText(), 'summer-reading-summary.pdf');

const downloads = [];
page.on('request', (r) => {
  if (r.url().includes('/api/portal/attachments/') && r.method() === 'POST') downloads.push(r.url());
});
await filed.first().click();
await page.waitForTimeout(900);
check('opening it asked the portal for a download URL', downloads.length, 1);
const reads = puts.filter((p) => p.method === 'GET');
check('and the browser fetched exactly one object', reads.length, 1);
check('the signed read forces a download rather than a render',
  [
    decodeURIComponent(reads[0].url).includes('attachment;'),
    decodeURIComponent(reads[0].url).includes('application/octet-stream'),
  ],
  [true, true]);
check('the grantee stayed on their own page',
  new URL(page.url()).pathname, '/reports');

/*
 * THE WAY OUT OF THIS PAGE, which it did not have.
 *
 * The portal shell carries no navigation -- correct when this was only a
 * grantee's reporting page and there was genuinely nowhere else to go. There
 * are three external destinations now, and a signed-in nonprofit wanting to
 * apply again, or to check whether an application went through, reached a dead
 * end and had to be sent a link or type a path.
 */
const applyRegion = page.locator('section', {
  has: page.getByRole('heading', { name: /Your applications|Apply for a grant/ }),
});
const hasApplySection = (await applyRegion.count()) > 0;
note('applications section present', String(hasApplySection));
if (hasApplySection) {
  /*
   * WHICH BUTTON IS SHOWN DEPENDS ON WHETHER A CYCLE IS OPEN, and this
   * database may have none. Both wordings are acceptable; what is not
   * acceptable is a page with neither, which is what shipped.
   */
  const out = await applyRegion.getByRole('button', {
    name: /See open grant programs|Apply for another grant|Carry on|View/,
  }).count();
  truthy('the portal offers somewhere to go', out > 0);
} else {
  note('no applications and no open cycle', 'section correctly renders nothing');
}

check('no console errors', consoleErrors, []);
check('nothing on the page 404s', notFound, []);

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
console.log(
  'Not covered here: email delivery, R2 uploads, accessibility, security. ' +
  'Those need their own verification.',
);
process.exit(failures === 0 ? 0 : 1);
