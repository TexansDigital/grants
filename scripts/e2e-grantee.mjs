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
 *   - No file reaches R2. Uploads are not exercised here at all.
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
/*
 * A published report form WITH FIELDS IN IT.
 *
 * The `EXISTS` is not defensive padding. A published definition is immutable by
 * trigger, so a run that published one before writing its fields leaves an
 * empty form behind that every later run would happily reuse -- rendering a
 * report with no questions and failing somewhere far from the cause. Ask for
 * what is actually needed.
 */
let formId = sql(
  `SELECT fd.id FROM form_definitions fd
    WHERE fd.program_id='${programId}' AND fd.kind='report' AND fd.status='published'
      AND fd.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM form_fields ff WHERE ff.form_definition_id = fd.id)
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

await page.waitForFunction(
  () => document.querySelector('.actions .counter')?.textContent?.startsWith('Saved'),
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

check('no console errors', consoleErrors, []);
check('nothing on the page 404s', notFound, []);

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
console.log(
  'Not covered here: email delivery, R2 uploads, accessibility, security. ' +
  'Those need their own verification.',
);
process.exit(failures === 0 ? 0 : 1);
