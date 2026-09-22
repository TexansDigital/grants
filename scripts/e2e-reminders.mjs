/**
 * The grant report reminder, driven against a real Worker and a real cron.
 *
 *   npm run e2e:reminders
 *
 * WHY. This is the only job in the system that writes to a few hundred people
 * who did not ask for the message, and it runs unattended at one in the
 * morning. Every unit test here passes against a function called directly; the
 * thing that has actually gone wrong on this project, repeatedly, is a handler
 * nothing wired up. So this fires the SCHEDULED handler the way Cloudflare
 * does and reads what landed in the database afterwards.
 *
 * WHAT IT PROVES. The cron reaches the reminder job at all; a grantee with a
 * report due three days out gets exactly one message however often the cron
 * fires; the message is a report_reminder on the transactional template and
 * carries no sign-in token; the report period records that it was chased; and
 * a grant the organization refused is never chased.
 *
 * WHAT IT DOES NOT PROVE. No mail is delivered -- local dev has no
 * RESEND_API_KEY, so every send is recorded as `suppressed`, which is the
 * correct outcome for a database that must never mail anyone. Deliverability
 * is DNS, and that is verified separately.
 *
 * PREREQUISITES: a migrated and seeded local database, and `npm run dev`.
 *
 * Writes invented data only, to the LOCAL preview database.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const APP = process.env.STEWARD_WORKER ?? 'http://127.0.0.1:8787';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok
        ? ''
        : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
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

const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const now = new Date().toISOString();
const stamp = Date.now().toString().slice(-6);
const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

/*
 * The program and its REPORT form definition.
 *
 * A report period with no form on it is deliberately not chased -- there is
 * nothing for the grantee to file -- so the fixture needs a real published
 * report form or the whole run would be a false negative.
 */
const programId = one(
  `SELECT id FROM programs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`, 'id');
const reportForm = sql(
  `SELECT id FROM form_definitions
    WHERE program_id = ${q(programId)} AND kind = 'report' AND status = 'published'
    ORDER BY version DESC LIMIT 1`);
if (reportForm.length === 0) {
  console.log(
    'SKIP  this program has no published report form, so nothing can be filed\n' +
    '      and nothing should be chased. Build one from the Reports screen and\n' +
    '      run this again.',
  );
  process.exit(0);
}
const formId = reportForm[0].id;

/** Two organizations: one owed a report, one that refused its grant. */
function fixture(kind) {
  const orgId = randomUUID();
  const userId = randomUUID();
  const awardId = randomUUID();
  const periodId = randomUUID();
  const email = `e2e-reminder-${kind}-${stamp}@example-invented.org`;
  const ein = `00${stamp}${kind === 'owed' ? '1' : '2'}`.slice(0, 9);

  sql(`INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (${q(orgId)}, 'Invented Harbour ${kind} ${stamp}', ${q(ein)}, 'active', ${q(now)}, ${q(now)})`);
  sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (${q(userId)}, ${q(email)}, 'grantee', ${q(orgId)}, 1, ${q(now)}, ${q(now)})`);
  sql(`INSERT INTO awards (id, application_id, organization_id, program_id,
         awarded_amount_cents, awarded_at, status, source_system, source_reference,
         created_at, updated_at)
       VALUES (${q(awardId)}, NULL, ${q(orgId)}, ${q(programId)}, 2500000, ${q(now)},
         ${kind === 'refused' ? "'cancelled'" : "'active'"}, 'manual',
         ${q(`e2e-${kind}-${stamp}`)}, ${q(now)}, ${q(now)})`);
  sql(`INSERT INTO report_periods (id, award_id, label, period_type, due_date, opens_at,
         status, form_definition_id, created_at, updated_at)
       VALUES (${q(periodId)}, ${q(awardId)}, 'Final report', 'final', ${q(iso(3))},
         ${q(iso(-1))}, 'open', ${q(formId)}, ${q(now)}, ${q(now)})`);

  return { orgId, userId, awardId, periodId, email };
}

const owed = fixture('owed');
const refused = fixture('refused');
note('grantee owed a report', owed.email);
note('grantee who refused the grant', refused.email);

/*
 * FIRE THE CRON THE WAY CLOUDFLARE DOES. wrangler dev exposes the scheduled
 * handler on this path; hitting the reminder function directly would prove
 * the function works and nothing about whether the cron reaches it, which is
 * the failure this project keeps having.
 */
async function fireCron() {
  const res = await fetch(`${APP}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('0 7 * * *')}`);
  return res.status;
}

const first = await fireCron();
check('the scheduled handler ran', first, 200);

const sent = sql(
  `SELECT template_key AS k, status, subject FROM email_messages
    WHERE to_email = ${q(owed.email)}`);
check('exactly one message for the grantee who owes a report', sent.length, 1);
check('it is the reminder template', sent[0]?.k, 'report_reminder');
note('subject', sent[0]?.subject ?? '(none)');
/*
 * A DUE DATE IS A DAY. This subject read "due September 25, 2026 at 6:40 AM
 * CDT" on the first run of this harness -- formatInZone merges the caller's
 * date options over defaults that include the time, so asking it for a date
 * never removed one. The same fault was in the retention notice, against its
 * own comment, and in the award letter's embargo date.
 */
for (const shape of [' AM ', ' PM ', 'CDT', 'CST', ':']) {
  check(`the subject carries no "${shape.trim()}"`, (sent[0]?.subject ?? '').includes(shape), false);
}
note('send status (local dev has no provider key)', sent[0]?.status ?? '(none)');

check('the grant that was refused is not chased',
  sql(`SELECT id FROM email_messages WHERE to_email = ${q(refused.email)}`).length, 0);

check('the report period records that it was chased',
  one(`SELECT reminder_count AS n FROM report_periods WHERE id = ${q(owed.periodId)}`, 'n'), 1);
check('and when',
  one(`SELECT reminder_last_sent_at IS NOT NULL AS ok FROM report_periods WHERE id = ${q(owed.periodId)}`, 'ok'), 1);

/*
 * A SECOND FIRING THE SAME NIGHT. A retry, an overlapping run, somebody
 * triggering it by hand. The guarantee is the unique index on the idempotency
 * key, not an assumption about how often the scheduler runs.
 */
const second = await fireCron();
check('a second run is accepted', second, 200);
check('and writes no second message',
  sql(`SELECT id FROM email_messages WHERE to_email = ${q(owed.email)}`).length, 1);

/* The letter itself: no credential in it. */
const body = one(
  `SELECT COALESCE(context_json, '') AS ctx FROM email_messages WHERE to_email = ${q(owed.email)}`,
  'ctx');
for (const shape of ['token', 'sign-in/']) {
  check(`the recorded message carries no ${shape}`, body.includes(shape), false);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
console.log(
  'Not proven here: that any mail was delivered. Local dev has no provider key,\n' +
  'so every send is recorded as suppressed, which is the correct outcome for a\n' +
  'database that must never mail anyone.',
);
process.exit(failures === 0 ? 0 : 1);
