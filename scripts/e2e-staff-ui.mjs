/**
 * The staff Configuration screen, driven in a real browser.
 *
 *   npm run e2e:staff
 *
 * WHY THIS EXISTS. Every staff surface in Steward sits behind Cloudflare
 * Access, and Access cannot be stood up on a laptop: the Worker verifies an
 * RS256 assertion against a JWKS it fetches over HTTPS from a team domain that
 * only exists in production. The consequence is that the pipeline, the
 * compliance desk and the configuration screen have been shipped on unit tests
 * and a careful read, and had never been RENDERED. The duplicate-organization
 * merge panel is the point where that stopped being acceptable: it is the one
 * screen in the system whose button does something no undo can take back.
 *
 * SO THIS STUBS THE API, and is honest that it does.
 *
 * WHAT IT PROVES: the built bundle renders, the panel loads, the survivor
 * choice defaults where it should and resets a stale plan, the preview
 * addresses the two organizations the RIGHT WAY ROUND, conflicts block the
 * merge, a non-admin gets no merge button, and merging re-reads the list.
 *
 * WHAT IT DOES NOT PROVE, and must never be reported as proving:
 *   - Nothing about Cloudflare Access, the role guards, or the SQL. The API is
 *     a fixture here; `roles: ADMIN_ONLY` on the merge route is enforced by the
 *     Worker and covered by the unit tests, not by this.
 *   - Nothing about the merge itself. No database is touched.
 *   - It is not an accessibility test. It checks that a label exists, not how
 *     a screen reader says it.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const BROWSER =
  process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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
const truthy = (label, value) => {
  const ok = Boolean(value);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(value)}`}`);
};

// ---------------------------------------------------------------------------
// Fixtures. Invented names and invented EINs, per CLAUDE.md -- these are also
// shaped to be the two cases the panel exists for: one nonprofit that typed
// its EIN with a dash one year and without it the next, and one that applied
// twice under names that differ only by punctuation and a suffix.
// ---------------------------------------------------------------------------

const org = (id, legalName, ein, counts) => ({
  id,
  legalName,
  ein,
  status: 'active',
  createdAt: '2024-02-01T00:00:00.000Z',
  applications: 0,
  awards: 0,
  contacts: 0,
  users: 0,
  openReports: 0,
  lastActivityAt: null,
  ...counts,
});

// The lighter record is listed FIRST on purpose. If the screen ever defaults to
// "the first one", creation order silently becomes the decision, and the test
// below is what catches that.
const BAYOU_THIN = org('org-bayou-thin', 'Bayou Bridge Youth', '743210099', {
  applications: 1,
  contacts: 1,
  lastActivityAt: '2026-01-11T00:00:00.000Z',
});
const BAYOU_HEAVY = org('org-bayou-heavy', 'Bayou Bridge Youth Services', '743210099', {
  applications: 3,
  awards: 2,
  contacts: 2,
  users: 1,
  openReports: 1,
  lastActivityAt: '2026-08-04T00:00:00.000Z',
});
const HARBOR_A = org('org-harbor-a', 'Harbor Light Arts, Inc.', null, {
  applications: 2,
  contacts: 1,
  lastActivityAt: '2025-11-20T00:00:00.000Z',
});
const HARBOR_B = org('org-harbor-b', 'Harbor-Light Arts', null, {
  applications: 1,
  awards: 1,
  contacts: 1,
  lastActivityAt: '2026-03-02T00:00:00.000Z',
});

const GROUPS = [
  { reason: 'same_ein', key: '743210099', organizations: [BAYOU_THIN, BAYOU_HEAVY] },
  { reason: 'same_name', key: 'harbor light arts', organizations: [HARBOR_A, HARBOR_B] },
];

/*
 * A health report shaped to exercise every branch the screen has: blocking and
 * attention, a check that found NOTHING (which must still render), a truncated
 * one, an organization row (which links) and an award row (which cannot yet).
 * Already in severity order, because the server sorts and the screen does not.
 */
const HEALTH = {
  generatedAt: '2026-09-20T14:30:00.000Z',
  blocking: 9,
  attention: 1,
  checks: [
    {
      key: 'award_no_w9',
      label: 'Active grants with no W-9',
      guidance: 'Finance cannot disburse without one.',
      severity: 'blocking',
      count: 2,
      truncated: false,
      rows: [
        { id: 'award-bayou-1', kind: 'award', title: 'Bayou Bridge Youth Services',
          detail: 'awarded 2026-03-04', amountCents: 2500000 },
        { id: 'award-harbor-2', kind: 'award', title: 'Harbor Light Arts, Inc.',
          detail: 'awarded 2026-03-11', amountCents: 125050 },
      ],
    },
    {
      key: 'award_no_report_periods',
      label: 'Grants that will never be asked to report',
      guidance: 'Term dates are set but no report periods exist.',
      severity: 'blocking',
      count: 7,
      truncated: true,
      rows: [
        { id: 'award-silent-1', kind: 'award', title: 'Third Ward Music Project',
          detail: 'term 2026-04-01 to 2027-03-31', amountCents: 1000000 },
        { id: 'award-silent-2', kind: 'award', title: 'Cypress Creek Literacy',
          detail: 'term 2026-04-01 to 2027-03-31', amountCents: 500000 },
      ],
    },
    {
      key: 'award_no_agreement',
      label: 'Active grants with no signed agreement',
      guidance: 'The grant is live and nothing is signed for it.',
      severity: 'blocking',
      count: 0,
      truncated: false,
      rows: [],
    },
    {
      key: 'ein_unverified',
      label: 'EINs never checked against the IRS file',
      guidance: 'A mismatch is a flag for a human, never an automatic rejection.',
      severity: 'attention',
      count: 1,
      truncated: false,
      rows: [
        { id: 'org-bayou-heavy', kind: 'organization', title: 'Bayou Bridge Youth Services',
          detail: 'EIN 743210099, never verified', amountCents: null },
      ],
    },
    {
      key: 'duplicate_organizations',
      label: 'Possible duplicate organizations',
      guidance: 'Merge reunites a grantee with the grants and reports they hold.',
      severity: 'informational',
      count: 2, // rewritten per-request below once a merge has happened
      truncated: false,
      rows: [],
    },
    {
      /*
       * A `system` row points at no record -- its id is an error code. The UI
       * prints a truncated id for any kind it cannot open, which would have
       * rendered "REPORT_R" and offered it as something to look up.
       */
      key: 'recorded_errors',
      label: 'Errors the system recorded in the last week',
      guidance: 'Grouped by code, newest first.',
      severity: 'attention',
      count: 1,
      truncated: false,
      rows: [
        {
          id: 'REPORT_REMINDER_NOT_DELIVERED',
          kind: 'system',
          title: 'REPORT_REMINDER_NOT_DELIVERED',
          detail: '2 times, last 2026-10-07 07:00 — the provider refused a reminder',
          amountCents: null,
        },
      ],
    },
  ],
};

const PORTFOLIO = {
  total: 1,
  rows: [
    {
      reportPeriodId: 'rp-1', awardId: 'award-bayou-1', organizationId: 'org-bayou-heavy',
      organizationName: 'Bayou Bridge Youth Services', programName: 'Inspire Change',
      label: 'Final report', periodType: 'final', dueDate: '2027-06-29',
      status: 'scheduled', awardedAmountCents: 2500000, submittedAt: null,
      fundsSpentCents: null, daysUntilDue: 280, overdue: false,
    },
  ],
};

/*
 * An import preview with one of everything a person has to be able to read:
 * a clean row, a row already imported, a row that is blocked, an ignored
 * column and a parse issue.
 */
let importPreview = {
  parse: {
    ok: false,
    rows: 3,
    issues: [{ rowNumber: 4, column: 'awarded_amount', message: 'Enter a dollar amount.' }],
    unknownColumns: ['favourite_colour'],
    report: '',
  },
  plan: {
    ok: true,
    summary: {
      toCreate: 1, toSkip: 1, blocked: 0,
      organizationsToCreate: 1, usersToCreate: 1, totalCents: 2500000,
    },
    rows: [
      { reference: 'IC-2026-001', organization: 'Bayou Reach Collective', kind: 'create',
        reason: null, amountCents: 2500000, createsOrganization: true, createsUser: true },
      { reference: 'IC-2025-002', organization: 'Third Ward Futures Alliance', kind: 'skip',
        reason: 'already imported', amountCents: 7500000,
        createsOrganization: false, createsUser: false },
    ],
  },
};
const importCalls = [];

/** What the next generate run will claim to have done. */
let generateResult = {
  generated: [{ awardId: 'award-silent-1', created: 1, skipped: null }],
  skipped: [{ awardId: 'award-zero-term', created: 0, skipped: 'This award ends on or before it starts.' }],
  periodsCreated: 1,
  more: false,
};
const generateCalls = [];

/** Every merge-preview the page asked for, in order, so order can be asserted. */
const previewCalls = [];
const mergeCalls = [];
let mergedAlready = false;

function planFor(duplicateId, survivorId) {
  const all = [BAYOU_THIN, BAYOU_HEAVY, HARBOR_A, HARBOR_B];
  const merged = all.find((o) => o.id === duplicateId);
  const survivor = all.find((o) => o.id === survivorId);
  // The Harbor pair is the deliberate conflict case, whichever way round it is
  // asked: two records with a live draft in the same cycle cannot both survive.
  const conflicts = duplicateId.startsWith('org-harbor')
    ? ['Both records have a draft application open in the 2026 cycle. Withdraw one first.']
    : [];
  return {
    survivor,
    merged,
    moves: {
      applications: merged.applications,
      awards: merged.awards,
      reportDrafts: 0,
      contacts: merged.contacts,
      contactsRetired: duplicateId === 'org-bayou-thin' ? 1 : 0,
      users: merged.users,
      attachments: 4,
    },
    conflicts,
    ok: conflicts.length === 0,
  };
}

// ---------------------------------------------------------------------------
// A static server for the built bundle. The Worker serves these in production;
// here nothing but the files is needed, because every /api/* call is routed.
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  // The bullhead in the masthead. Without this it is served as
  // application/octet-stream, which a browser will not paint as an image, and
  // the harness would show a broken mark on a page it reported as fine.
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

function serveAssets(root) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    /*
     * A REAL FILE IF THERE IS ONE, the shell otherwise -- which is what the
     * Worker's static-asset handler does and what this comment always claimed.
     *
     * It used to serve only /assets/* and hand back index.html for everything
     * else. That was indistinguishable from correct while index.html and the
     * hashed bundle were the only files in ./public. The moment a static file
     * landed beside them -- /bullhead.png -- the harness answered an image
     * request with HTML, and the browser showed a broken image on a page the
     * harness reported as fine.
     *
     * The traversal guard matters because the path now reaches the filesystem
     * for any request, not just ones under a fixed prefix.
     */
    const candidate = join(root, normalize(path));
    const wanted = candidate.startsWith(root) && path !== '/' ? candidate : join(root, 'index.html');
    readFile(wanted)
      .then((body) => {
        res.writeHead(200, { 'content-type': TYPES[extname(wanted)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() =>
        // Not a file on disk, so it is a client-side route: serve the shell.
        readFile(join(root, 'index.html')).then(
          (body) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(body);
          },
          () => {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
          },
        ),
      );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/*
 * Configuration writes, recorded.
 *
 * Stateful on purpose: the list starts empty and gains the created row, so
 * "the screen re-read itself after writing" is observable rather than assumed.
 */
let programsState = [];
let cyclesState = [];
const configCalls = { programs: [], cycles: [], status: [] };

function resetConfigState() {
  programsState = [];
  cyclesState = [];
  configCalls.programs.length = 0;
  configCalls.cycles.length = 0;
  configCalls.status.length = 0;
}

const updateRequestCalls = [];
const reportFormBuilds = [];

async function stubApi(page, { role }) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role } });
    }
    if (p === '/api/programs' && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      configCalls.programs.push(body);
      programsState = [
        {
          id: 'p1',
          name: body.name,
          slug: 'created-program',
          status: 'draft',
          fiscal_year: body.fiscal_year ?? null,
          compliance_policy: body.compliance_policy ?? 'warn',
        },
      ];
      return json(route, { program: programsState[0] });
    }
    if (p === '/api/programs') return json(route, { programs: programsState });

    const newCycle = p.match(/^\/api\/programs\/([^/]+)\/cycles$/);
    if (newCycle && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      configCalls.cycles.push({ programId: decodeURIComponent(newCycle[1]), ...body });
      cyclesState = [
        {
          id: 'c1',
          program_id: 'p1',
          name: body.name,
          opens_at: body.opens_at,
          closes_at: body.closes_at,
          status: 'draft',
          draft_grace_hours: body.draft_grace_hours ?? 0,
          opens_at_display: '5 Jan 2027, 8:00 AM CST',
          closes_at_display: '1 Mar 2027, 11:59 PM CST',
        },
      ];
      return json(route, { cycle: cyclesState[0] });
    }

    const status = p.match(/^\/api\/cycles\/([^/]+)\/(open|closed)$/);
    if (status && route.request().method() === 'POST') {
      configCalls.status.push({ id: decodeURIComponent(status[1]), next: status[2] });
      cyclesState = cyclesState.map((c) => ({ ...c, status: status[2] === 'open' ? 'open' : 'closed' }));
      return json(route, { cycle: cyclesState[0] });
    }

    if (p === '/api/cycles') return json(route, { cycles: cyclesState });
    if (p === '/api/forms') return json(route, { forms: [] });
    // The health screen links into the pipeline, which fetches this. Stubbed
    // so the console-error check stays meaningful instead of absorbing a 404.
    if (p === '/api/applications') return json(route, { applications: [], total: 0 });

    if (p === '/api/awards/import/preview') return json(route, importPreview);
    if (p === '/api/awards/import') {
      importCalls.push(JSON.parse(route.request().postData() ?? '{}'));
      return json(route, {
        awardsCreated: 1, organizationsCreated: 1, usersCreated: 1, skipped: 1,
      });
    }
    if (p === '/api/reports') return json(route, PORTFOLIO);
    /*
     * The screens added with the Grants/Organizations restructure. This stub
     * answered neither, so walking into the Grants section fetched a 404 and
     * the console-error check -- the one assertion here that catches things
     * nobody thought to assert -- went red for a reason that had nothing to
     * do with what the test was about.
     */
    if (p === '/api/awards') return json(route, { rows: [], total: 0 });
    if (p === '/api/organizations') return json(route, { rows: [], total: 0 });
    if (p === '/api/todo') return json(route, { items: [], generatedAt: 'x', complete: true });
    if (p === '/api/impact') {
      return json(route, { generatedAt: 'x', year: null, years: [], programs: [] });
    }
    if (p === '/api/report-periods/generate') {
      generateCalls.push(1);
      return json(route, generateResult);
    }

    if (p === '/api/data-health') {
      if (role !== 'admin') {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Only an administrator can do that.' } }),
        });
      }
      // The duplicates check counts what the merge panel below it shows, so
      // they must not disagree once a merge has happened.
      const report = structuredClone(HEALTH);
      const dup = report.checks.find((c) => c.key === 'duplicate_organizations');
      if (dup) dup.count = mergedAlready ? 1 : 2;
      return json(route, report);
    }

    /*
     * Storage. Deliberately shaped like the state that actually exists today:
     * photographs and video that nothing will ever delete, a cost well under
     * the threshold, and a report document that DOES carry a deletion date so
     * the two figures cannot be the same number by accident.
     */
    if (p === '/api/storage') {
      return json(route, {
        totalBytes: 1_400_000_000,
        byParent: [
          { parentType: 'application', files: 12, bytes: 200_000_000 },
          { parentType: 'report_submission', files: 9, bytes: 1_200_000_000 },
        ],
        unretainedBytes: 1_150_000_000,
        mediaBytes: 1_100_000_000,
        mediaFiles: 7,
        estimatedMonthlyUsd: 0.02,
        overWatchThreshold: false,
      });
    }

    /*
     * The update request. Two calls with the same shape: a dry run that writes
     * nothing, then the real one. The stub records which it was asked for,
     * because "the panel asked for a dry run first" is the property that stops
     * a press creating obligations nobody has seen.
     */
    if (/\/api\/programs\/[^/]+\/report-form$/.test(p)) {
      reportFormBuilds.push(1);
      return json(route, {
        formDefinitionId: 'fd-new', version: reportFormBuilds.length, fieldCount: 9,
      });
    }

    if (/\/api\/programs\/[^/]+\/request-updates$/.test(p)) {
      const body = JSON.parse(route.request().postData() ?? '{}');
      updateRequestCalls.push(body);
      const willAsk = [
        { awardId: 'aw1', organizationName: 'Invented Bayou Youth Collective',
          awardedAmountCents: 2500000, awardedAt: '2025-04-12T00:00:00.000Z', skipped: null },
        { awardId: 'aw2', organizationName: 'Invented Third Ward Arts Trust',
          awardedAmountCents: 4000000, awardedAt: '2025-03-05T00:00:00.000Z', skipped: null },
      ];
      return json(route, {
        label: body.label, dueDate: body.dueDate, formDefinitionId: null,
        willAsk,
        skipped: [{ awardId: 'aw3', organizationName: 'Invented Harbor Trust',
          awardedAmountCents: 1500000, awardedAt: '2025-06-01T00:00:00.000Z',
          skipped: 'this award was cancelled' }],
        created: body.dryRun ? 0 : willAsk.length,
        dryRun: Boolean(body.dryRun),
      });
    }

    if (p === '/api/organizations/duplicates') {
      // After a merge the pair is gone, which is how "the list re-read itself"
      // is observable at all.
      return json(route, { groups: mergedAlready ? GROUPS.slice(1) : GROUPS });
    }

    const preview = p.match(/^\/api\/organizations\/([^/]+)\/merge-preview$/);
    if (preview) {
      const duplicateId = decodeURIComponent(preview[1]);
      const into = url.searchParams.get('into');
      previewCalls.push({ duplicateId, into });
      return json(route, planFor(duplicateId, into));
    }

    const merge = p.match(/^\/api\/organizations\/([^/]+)\/merge$/);
    if (merge) {
      const duplicateId = decodeURIComponent(merge[1]);
      const body = JSON.parse(route.request().postData() ?? '{}');
      mergeCalls.push({ duplicateId, into: body.into });
      mergedAlready = true;
      return json(route, { survivorId: body.into, mergedId: duplicateId });
    }

    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

/**
 * Radio groups are named per duplicate group. If that name were shared, picking
 * a survivor in one group would silently clear the choice in the other.
 */
async function harborRadiosChecked(page) {
  return page
    .locator('article.review-section', { hasText: 'Similar name' })
    .locator('input[type=radio]:checked')
    .count();
}

// ---------------------------------------------------------------------------

/**
 * Open a section by name, wherever the navigation currently keeps it.
 *
 * The bar reached twelve items and was split: six stay, four moved behind a
 * "More" menu, and two were renamed ("Configuration" became "Programs",
 * "Reporting" became a view inside Grants). This harness clicked the bar
 * directly and went red the day that happened -- and stayed red, because
 * nothing runs it but a person remembering to.
 *
 * Asking for a section by name, and letting this function work out whether it
 * is a button, a menu entry or a view inside a section, is what makes the next
 * reshuffle a non-event here.
 */
async function goTo(page, label) {
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const bar = page.locator('.mainnav > button').filter({ hasText: exact });
  if (await bar.count()) {
    await bar.first().click();
    return;
  }
  /*
   * The section nav is rendered by the screen you have just navigated TO, so
   * asking for it the instant after a click finds nothing and falls through to
   * the More menu, where it waits thirty seconds for an entry that is not
   * there. Give it a moment to appear before concluding it does not exist.
   * This passed run after run and failed under load, which is the worst way
   * for a harness to be wrong.
   */
  const view = page.locator('.sectionnav button').filter({ hasText: exact });
  await view
    .first()
    .waitFor({ state: 'attached', timeout: 3_000 })
    .catch(() => undefined);
  if (await view.count()) {
    await view.first().click();
    return;
  }
  await page.getByRole('button', { name: /^More/ }).click();
  await page.locator('.navmore-menu').waitFor({ timeout: 10_000 });
  await page.locator('.navmore-menu button').filter({ hasText: exact }).first().click();
}

async function main() {
  const { server, port } = await serveAssets('public');
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    // ---- as an admin ------------------------------------------------------
    const ctx = await browser.newContext({ colorScheme: process.env.STEWARD_SCHEME ?? 'light' });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await stubApi(page, { role: 'admin' });
    await page.goto(`${base}/data-health`);

    /*
     * The storage panel. Its endpoint existed for a day with nothing rendering
     * it, which is the same fault shape as every other one this week: a
     * correct half nobody had joined to anything. The request was "flag it if
     * this goes over $5 a month", and a figure on no screen flags nothing.
     */
    const storage = page.locator('article.storage-usage');
    await storage.waitFor();
    const storageText = await storage.innerText();
    truthy('the storage panel renders', await storage.isVisible());
    truthy('it says how much is stored', storageText.includes('1.3 GB'));
    truthy('it says what that costs', storageText.includes('$0.02'));
    truthy('it says whether that is past the figure worth a conversation',
      /below the \$5/i.test(storageText));
    truthy('it names the photographs and video separately', storageText.includes('7 photos and video'));
    truthy('and says plainly that nothing deletes them',
      /nothing ever deletes these/i.test(storageText));
    truthy('it reports what carries no deletion date at all',
      /1\.1 GB attached to reports has no deletion date/i.test(storageText));
    // The two figures are different facts and must not be printed as one.
    truthy('media and unretained are not the same number',
      !storageText.includes('1.1 GB attached to reports has no deletion date, 1.1 GB'));

    const panel = page.locator('article.check', { hasText: 'Possible duplicate organizations' });
    await panel.waitFor();
    truthy('the duplicates panel renders', await panel.isVisible());
    check('it says how many there are to look at', await panel.locator('.tag').innerText(), '2');

    const bayou = page.locator('article.review-section', { hasText: 'EIN 743210099' });
    check('the EIN group is titled by its EIN', await bayou.locator('h3').textContent(), 'EIN 743210099');

    // Both records, with what each one actually holds -- the whole point of
    // the screen being a table rather than two names.
    const rowText = (name) => bayou.locator('tr', { hasText: name }).innerText();
    truthy('the heavier record shows its awards', (await rowText('Bayou Bridge Youth Services')).includes('2'));

    // The default survivor. Not the first row.
    const checkedLabel = await bayou
      .locator('tr', { has: page.locator('input[type=radio]:checked') })
      .locator('th[scope=row]')
      .textContent();
    check('it defaults to keeping the record with the most on it', checkedLabel, 'Bayou Bridge Youth Services');

    // Radios are addressed by their visually hidden label, which is also the
    // only thing a screen reader has to tell the two rows apart.
    const keep = (scope, name) => scope.getByRole('radio', { name: `Keep ${name}`, exact: true });

    // ---- preview, the right way round ------------------------------------
    await bayou.getByRole('button', { name: /Preview merging Bayou Bridge Youth$/ }).click();
    await bayou.locator('.panel-decide').waitFor();
    check(
      'the preview asks about the duplicate, into the survivor -- not transposed',
      previewCalls.at(-1),
      { duplicateId: 'org-bayou-thin', into: 'org-bayou-heavy' },
    );
    if (process.env.STEWARD_SHOT_PLAN) {
      await page.screenshot({ path: process.env.STEWARD_SHOT_PLAN, fullPage: true });
    }
    // The WHOLE sentence, not a substring of it. 'includes("1 application")' is
    // satisfied by "1 applications" -- a pluralisation bug passes a test that
    // looks like it checks for one.
    const sentence = (await bayou.locator('.panel-decide p').first().innerText()).replace(/\s+/g, ' ');
    check(
      'the plan says exactly what moves, and reads as English',
      sentence,
      'Merging Bayou Bridge Youth into Bayou Bridge Youth Services moves 1 application, ' +
        '1 contact, 4 files, and retires 1 duplicate contact already held under the same address.',
    );

    // One button per duplicate. Offering the survivor as its own duplicate is
    // an invitation to merge a record into itself.
    const offered = await bayou.getByRole('button', { name: /^Preview merging / }).allInnerTexts();
    check('only the records that are not being kept are offered', offered, [
      'Preview merging Bayou Bridge Youth',
    ]);

    // ---- changing the survivor must discard the plan ----------------------
    // Switching to the OTHER record. A plan built a moment ago now describes a
    // merge in the opposite direction, and leaving it on screen under a Merge
    // button is how somebody reunites a grantee the wrong way round.
    await keep(bayou, 'Bayou Bridge Youth').check();
    check(
      'changing the survivor drops a plan that no longer describes the merge',
      await bayou.locator('.panel-decide').count(),
      0,
    );
    check(
      'the survivor choice is exclusive within a group',
      await bayou.locator('input[type=radio]:checked').count(),
      1,
    );
    check(
      'and does not reach into the other group',
      await harborRadiosChecked(page),
      1,
    );

    // ---- a conflict blocks the merge --------------------------------------
    const harbor = page.locator('article.review-section', { hasText: 'Similar name' });
    check(
      'a similar-name group is titled after every record in it, not the first',
      await harbor.locator('h3').textContent(),
      'Harbor Light Arts, Inc. \u00b7 Harbor-Light Arts',
    );
    await harbor.getByRole('button', { name: /Preview merging Harbor Light Arts, Inc\.$/ }).click();
    await harbor.locator('[role=alert]').waitFor();
    truthy(
      'a conflict is stated in words',
      (await harbor.locator('[role=alert]').innerText()).includes('Withdraw one first'),
    );
    check(
      'a conflicted plan offers no merge button',
      await harbor.getByRole('button', { name: 'Merge them' }).count(),
      0,
    );

    // ---- the merge itself --------------------------------------------------
    await bayou.getByRole('button', { name: /Preview merging Bayou Bridge Youth Services$/ }).click();
    await bayou.locator('.panel-decide').waitFor();
    // The other direction: plural throughout, and nothing retired. A plan that
    // retires no contact must not say it retires none -- a count of zero in a
    // sentence about losing records is alarming and meaningless.
    check(
      'a plan with nothing retired says nothing about retiring',
      (await bayou.locator('.panel-decide p').first().innerText()).replace(/\s+/g, ' '),
      'Merging Bayou Bridge Youth Services into Bayou Bridge Youth moves 3 applications, ' +
        '2 awards, 2 contacts, 1 sign-in, 4 files.',
    );
    page.once('dialog', (d) => d.dismiss());
    await bayou.getByRole('button', { name: 'Merge them' }).click();
    await page.waitForTimeout(200);
    check('dismissing the confirm merges nothing', mergeCalls.length, 0);

    page.once('dialog', (d) => d.accept());
    await bayou.getByRole('button', { name: 'Merge them' }).click();
    // Scoped to the merge panel: the EIN also appears in the ein_unverified
    // check's detail line further up the same screen, so a whole-page text
    // search would wait forever on text that is not the group heading.
    await panel
      .locator('article.review-section', { hasText: 'EIN 743210099' })
      .waitFor({ state: 'detached', timeout: 15000 });
    check('accepting merges the duplicate into the survivor', mergeCalls, [
      { duplicateId: 'org-bayou-heavy', into: 'org-bayou-thin' },
    ]);
    check(
      'the list re-reads itself afterwards, and the count above it agrees',
      await panel.locator('.tag').innerText(),
      '1',
    );

    // A screenshot on demand. The only way to see that a panel built from the
    // applicant form's vocabulary does not paint a white card on a dark ground.
    if (process.env.STEWARD_SHOT) {
      await page.screenshot({ path: process.env.STEWARD_SHOT, fullPage: true });
    }

    // ---- the data health screen -------------------------------------------
    const summary = page.locator('.health-summary');
    await summary.waitFor();

    check(
      'the summary leads with what is blocking',
      (await summary.innerText()).replace(/\s+/g, ' ').trim(),
      '9 things are blocking 1 needs attention',
    );
    check(
      'it says when it was checked, in Central time',
      (await page.locator('.panel-head .meta').first().innerText()).trim(),
      'checked September 20, 2026 at 9:30 AM CDT',
    );

    const checks = page.locator('article.check');
    if (process.env.STEWARD_SHOT_HEALTH) {
      await page.screenshot({ path: process.env.STEWARD_SHOT_HEALTH, fullPage: true });
    }
    check('every check is on screen, including the clean one', await checks.count(), 6);
    check(
      'in the order the server sorted them, blocking first',
      await checks.locator('.check-head h3').allInnerTexts(),
      [
        'Active grants with no W-9',
        'Grants that will never be asked to report',
        'Active grants with no signed agreement',
        'EINs never checked against the IRS file',
        'Possible duplicate organizations',
        // Attention, so it sorts after every blocking check.
        'Errors the system recorded in the last week',
      ],
    );

    // A check that found nothing must still be visible, saying so.
    const clean = page.locator('article.check', { hasText: 'no signed agreement' });
    check('a clean check says none rather than vanishing', await clean.locator('.tag').innerText(), 'none');
    check('and lists nothing', await clean.locator('.findings').count(), 0);
    check('and is not striped as a problem', await clean.getAttribute('data-found'), 'false');
    check(
      'the stripe follows the finding, not the category',
      await clean.evaluate((el) => getComputedStyle(el).borderLeftColor),
      await page
        .locator('article.check', { hasText: 'Possible duplicate organizations' })
        .evaluate((el) => getComputedStyle(el).borderLeftColor),
    );

    const w9 = page.locator('article.check', { hasText: 'no W-9' });
    check('severity is on the element, not just in the words', await w9.getAttribute('data-severity'), 'blocking');
    check('the count is the count', await w9.locator('.tag').innerText(), '2');
    check(
      'money is formatted at the display edge, from integer cents',
      await w9.locator('.findings .amount').allInnerTexts(),
      ['$25,000', '$1,250.50'],
    );
    check(
      'an award shows a short id, because it has no screen yet',
      await w9.locator('.findings .ref').first().innerText(),
      'award-ba',
    );

    const truncated = page.locator('article.check', { hasText: 'never be asked to report' });
    truthy(
      'a truncated check says how many it is not showing',
      (await truncated.locator('.more').innerText()).includes('Showing 2 of 7'),
    );

    // The organization row is the one finding that can be opened today.
    const ein = page.locator('article.check', { hasText: 'never checked against the IRS' });
    check('an attention check is striped as one', await ein.getAttribute('data-severity'), 'attention');
    await ein.getByRole('button', { name: /^Applications/ }).click();
    check(
      'and opens the pipeline filtered to that organization',
      new URL(page.url()).pathname + new URL(page.url()).search,
      '/pipeline?organization_id=org-bayou-heavy',
    );

    // Back, and the merge panel is embedded in its check rather than beside it.
    await goTo(page, 'Data health');
    await page.locator('.health-summary').waitFor();

    /*
     * AN ERROR CODE IS NOT A ROW ID. Every kind the UI cannot open falls
     * through to printing the first eight characters of the id, which for
     * REPORT_REMINDER_NOT_DELIVERED is "REPORT_R" -- offered in the reference
     * column as though it were something to go and look up.
     */
    {
      const errs = page.locator('article.check', { hasText: 'Errors the system recorded' });
      await errs.first().waitFor({ timeout: 10_000 });
      const text = await errs.first().innerText();
      truthy('a recorded error names its code in full', /REPORT_REMINDER_NOT_DELIVERED/.test(text));
      truthy('and says how many times and when', /2 times/.test(text));
      check(
        'and offers no truncated id as though it were a record',
        /REPORT_R\b(?!EMINDER)/.test(text),
        false,
      );
    }

    const dupCheck = page.locator('article.check', { hasText: 'Possible duplicate organizations' });
    await dupCheck.locator('article.review-section').first().waitFor();
    check(
      'the merge panel is inside the check, not a second panel',
      await dupCheck.locator('section.panel').count(),
      0,
    );
    check(
      'and does not repeat the heading the check already carries',
      await page.getByRole('heading', { name: 'Possible duplicate organizations' }).count(),
      1,
    );

    // ---- importing a year of grants ---------------------------------------
    await goTo(page, 'Programs');
    const importPanel = page.locator('section.panel', { hasText: 'Import grants from a spreadsheet' });
    await importPanel.waitFor();

    const checkBtn = importPanel.getByRole('button', { name: 'Check this file' });
    truthy('the check button is dead until a file is chosen', await checkBtn.isDisabled());

    const CSV =
      'external_reference,organization_name,ein,program_slug,awarded_amount,awarded_date,' +
      'grantee_contact_name,grantee_contact_email\n' +
      'IC-2026-001,Bayou Reach Collective,00-1234567,inspire-change,25000,2026-03-14,' +
      'Dana Okonkwo,dana@example-bayoureach.org\n';
    /*
     * Attach, then CHECK IT STUCK, and retry if it did not.
     *
     * The first version attached once and waited for the button. It sat
     * disabled for fifteen seconds with `input.files.length === 0` and no
     * console error: the file had not been attached at all. A re-render
     * between Playwright resolving the input and the browser applying the
     * files replaces the DOM node, and a file input loses its file with the
     * node -- silently, because nothing errors.
     */
    let attached = false;
    for (let i = 0; i < 5 && !attached; i += 1) {
      await importPanel.locator('#awards-csv').setInputFiles({
        name: 'fy26-awards.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV),
      });
      await page.waitForTimeout(150);
      attached =
        (await page.evaluate(() => document.querySelector('#awards-csv')?.files?.length ?? 0)) > 0;
    }
    truthy('the file attaches to the input', attached);
    /*
     * Polls the control itself. Reading the file is async -- File.text() is a
     * promise and React re-renders after it settles -- so there is a real
     * moment where a file is chosen and the button is still dead.
     *
     * An earlier version of this used page.waitForFunction with a predicate
     * that read `!buttons.find(...)?.disabled`. While the button says
     * "Reading…" that find returns undefined, `undefined?.disabled` is
     * undefined, and `!undefined` is TRUE -- so it resolved instantly no
     * matter what the button was doing. A predicate that cannot fail is worse
     * than no predicate.
     */
    let enabled = false;
    for (let i = 0; i < 60 && !enabled; i += 1) {
      enabled = !(await checkBtn.isDisabled());
      if (!enabled) await page.waitForTimeout(250);
    }
    truthy('and alive once the file has been read', enabled);

    await checkBtn.click();
    await importPanel.locator('.panel-decide').waitFor();

    truthy(
      'a broken row is named by the line number the spreadsheet shows',
      (await importPanel.locator('[role=alert] .tally').innerText()).includes('Row 4, awarded_amount'),
    );
    truthy(
      'a column it does not understand is named, not silently dropped',
      (await importPanel.locator('.banner').innerText()).includes('favourite_colour'),
    );
    check(
      'nothing can be imported while a row is unreadable',
      await importPanel.getByRole('button', { name: /^Import / }).count(),
      0,
    );
    check(
      'the plan lists what each row would do',
      await importPanel.locator('tbody th[scope=row]').allInnerTexts(),
      ['IC-2026-001', 'IC-2025-002'],
    );
    truthy(
      'and money is formatted from integer cents',
      (await importPanel.locator('tbody .num').first().innerText()) === '$25,000',
    );

    // Fix the file: the button appears.
    importPreview = { ...importPreview, parse: { ...importPreview.parse, ok: true, issues: [] } };
    await checkBtn.click();
    const importBtn = importPanel.getByRole('button', { name: 'Import 1 grant' });
    await importBtn.waitFor();

    page.once('dialog', (d) => d.dismiss());
    await importBtn.click();
    await page.waitForTimeout(200);
    check('dismissing the confirm imports nothing', importCalls.length, 0);

    page.once('dialog', (d) => d.accept());
    await importBtn.click();
    await importPanel.locator('[role=status]').waitFor();
    check('accepting sends the file once', importCalls.length, 1);
    truthy('and sends the file, not a plan the browser made up', importCalls[0].csv.includes('IC-2026-001'));
    truthy(
      'the result says what it created',
      (await importPanel.locator('[role=status]').innerText()).includes('Imported 1 grant'),
    );
    // The result must SURVIVE. It used to be wiped a moment later by a reload
    // that unmounted the panel, leaving an admin with no idea what happened.
    await page.waitForTimeout(600);
    truthy(
      'and the confirmation is still there a moment later',
      (await importPanel.locator('[role=status]').count()) === 1,
    );
    truthy(
      'and points at the step without which nobody is ever asked to report',
      (await importPanel.locator('[role=status]').innerText()).includes('Create missing report obligations'),
    );

    // ---- creating the report obligations ----------------------------------
    //
    // The single most important control for "can a nonprofit file a report at
    // all": until this existed nothing in the running system could produce a
    // report period, so an imported grant was one nobody would ever be asked
    // about.
    await goTo(page, 'Grants');
    await goTo(page, 'Reports');
    const generate = page.getByRole('button', { name: 'Create missing report obligations' });
    await generate.waitFor();

    page.once('dialog', (d) => d.dismiss());
    await generate.click();
    await page.waitForTimeout(200);
    check('dismissing the confirm creates nothing', generateCalls.length, 0);

    page.once('dialog', (d) => d.accept());
    await generate.click();
    await page.locator('[role=status]').waitFor();
    check('accepting runs it once', generateCalls.length, 1);
    check(
      'and says what it created, in obligations and in grants',
      (await page.locator('[role=status] .meta').first().innerText()).replace(/\s+/g, ' ').trim(),
      'Created 1 report obligation across 1 grant. Reload to see them.',
    );
    truthy(
      'a grant it could not schedule is named, not swallowed',
      (await page.locator('[role=status] .tally').innerText()).includes('ends on or before it starts'),
    );

    // Pressing it again with nothing left must not read as a failure.
    generateResult = { generated: [], skipped: [], periodsCreated: 0, more: false };
    page.once('dialog', (d) => d.accept());
    await generate.click();
    await page.waitForFunction(
      () => document.querySelector('[role=status] .meta')?.textContent?.includes('Nothing to do'),
    );
    check('a second run says there is nothing to do, not that it failed', generateCalls.length, 2);

    /*
     * Narrow widths, as a standing guard rather than a one-off look. Adding
     * the fourth nav item pushed the masthead 63px past a 320px viewport and
     * scrolled the whole page sideways -- nothing on the health screen itself
     * was at fault, and no assertion about the health screen would have caught
     * it. This one would have.
     */
    await goTo(page, 'Data health');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('.health-summary').waitFor();
      check(
        `no sideways scroll at ${width}px`,
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
        0,
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    check('no console errors on the staff screen', consoleErrors, []);
    await ctx.close();

    // ---- configuration, from a browser that is NOT in Central --------------
    /*
     * THE POINT OF THE TIMEZONE. A deadline typed by somebody in Houston and
     * the same deadline typed by a consultant in London must be the same
     * instant. `<input type="datetime-local">` hands back a naive string and
     * the browser reads it in the browser's zone, so this drives the form from
     * Europe/London and asserts the UTC instant that leaves is Central.
     *
     * Get this wrong and applications are rejected as late by five hours, with
     * nothing on any screen saying why.
     */
    resetConfigState();
    const ctxTz = await browser.newContext({ timezoneId: 'Europe/London' });
    const pageTz = await ctxTz.newPage();
    const tzErrors = [];
    pageTz.on('console', (m) => { if (m.type() === 'error') tzErrors.push(m.text()); });
    pageTz.on('pageerror', (e) => tzErrors.push(String(e)));
    await stubApi(pageTz, { role: 'admin' });
    await pageTz.goto(`${base}/configuration`);
    await pageTz.locator('.state h1, .panel h2').first().waitFor();

    truthy('an admin is offered a way to create a program',
      await pageTz.getByRole('button', { name: 'New program' }).isVisible());

    await pageTz.getByRole('button', { name: 'New program' }).click();
    await pageTz.fill('#program-name', 'Neighborhood Resilience Fund');
    await pageTz.fill('#program-fiscal-year', '2027');
    await pageTz.selectOption('#program-compliance', 'block');
    await pageTz.getByRole('button', { name: 'Create program' }).click();
    await pageTz.waitForFunction(() => document.querySelectorAll('.panel h2').length > 0, { timeout: 10_000 });

    check('the program is created with what was typed', configCalls.programs, [
      { name: 'Neighborhood Resilience Fund', compliance_policy: 'block', fiscal_year: 2027 },
    ]);
    truthy('and the screen re-reads, so the new program is on it',
      (await pageTz.locator('.panel h2').first().innerText()).includes('Neighborhood Resilience Fund'));

    /*
     * BUILDING A REPORT FORM SAYS SO.
     *
     * This returned silently on success. The new draft lands in a table below
     * the fold, so an admin saw a button stop being busy and nothing else, and
     * pressed it again -- three identical drafts in the real preview database
     * is how it was found. A silent success is indistinguishable from a silent
     * failure, and no test here could tell them apart either.
     */
    const buildBtn = pageTz.getByRole('button', { name: /Build a report form/ });
    await buildBtn.click();
    const built = pageTz.locator('[role="status"]', { hasText: /Draft version/ });
    await built.waitFor();
    const builtText = (await built.innerText()).replace(/\s+/g, ' ');
    check('building a report form happened once', reportFormBuilds.length, 1);
    truthy('and the button says what it made', /Draft version 1 built, with 9 questions/i.test(builtText));
    truthy('and points at the next step rather than leaving them guessing',
      /then Publish it/i.test(builtText));
    truthy('and warns that pressing again makes another',
      /again makes another draft/i.test(builtText));

    /*
     * Asking past grantees for an update. The reason this is driven rather than
     * unit-tested alone: the panel's whole job is to make somebody look at the
     * list BEFORE thirteen obligations exist, and "did the confirm step happen"
     * is not visible from the server.
     */
    const ask = pageTz.locator('section.request-updates');
    await ask.waitFor();
    truthy('the update-request panel renders', await ask.isVisible());

    await ask.locator('input[type="text"]').fill('2025 grant update');
    const dates = ask.locator('input[type="date"]');
    await dates.nth(0).fill('2025-01-01');
    await dates.nth(1).fill('2025-12-31');
    await dates.nth(2).fill('2027-11-14');

    check('nothing has been asked of the server yet', updateRequestCalls.length, 0);
    await ask.getByRole('button', { name: /what this would do/i }).click();
    await ask.locator('.request-updates-plan').waitFor();

    check('the first call is a DRY RUN', updateRequestCalls.map((c) => c.dryRun), [true]);
    const planText = (await ask.locator('.request-updates-plan').innerText()).replace(/\s+/g, ' ');
    truthy('it says how many would be asked', /2 grants would be asked/i.test(planText));
    truthy('it names them', planText.includes('Invented Bayou Youth Collective'));
    truthy('it shows what it would skip, and why',
      /Invented Harbor Trust .* cancelled/i.test(planText));
    truthy('it warns that no report form is published',
      /nothing to fill in until one is/i.test(planText));
    truthy('the due date is the one typed', planText.includes('2027-11-14'));

    /*
     * CHANGING A FIELD MUST THROW THE PLAN AWAY.
     *
     * It did not, and the result was a panel that lied at the only moment it
     * matters. The confirm dialog quotes the DRY RUN's due date; the write
     * sends whatever is in the field right now. Dry-run one date, change the
     * date, press the button, and you confirm a date that is not the one being
     * committed -- against every grant in the window, on an action that cannot
     * be re-dated, because a second run skips any award that already has a
     * period.
     *
     * So the list must disappear the moment it stops describing the inputs.
     */
    await dates.nth(2).fill('2027-11-21');
    check('changing the due date retracts the plan',
      await ask.locator('.request-updates-plan').count(), 0);
    check('and asks the server for nothing on its own', updateRequestCalls.length, 1);

    await ask.locator('input[type="text"]').fill('2025 grant update, reworded');
    await ask.getByRole('button', { name: /what this would do/i }).click();
    await ask.locator('.request-updates-plan').waitFor();
    truthy('a fresh dry run quotes the NEW date',
      (await ask.locator('.request-updates-plan').innerText()).includes('2027-11-21'));

    // Put the original wording back, then re-plan, so the assertions below
    // still describe what an admin would be confirming.
    await ask.locator('input[type="text"]').fill('2025 grant update');
    await dates.nth(2).fill('2027-11-14');
    await ask.getByRole('button', { name: /what this would do/i }).click();
    await ask.locator('.request-updates-plan').waitFor();

    // The confirm is the whole point. Refuse it and nothing must be written.
    pageTz.once('dialog', (d) => void d.dismiss());
    await ask.getByRole('button', { name: /^Ask 2 organizations$/ }).click();
    await pageTz.waitForTimeout(400);
    check('dismissing the confirm asks for nothing',
      updateRequestCalls.filter((c) => !c.dryRun).length, 0);

    pageTz.once('dialog', (d) => void d.accept());
    await ask.getByRole('button', { name: /^Ask 2 organizations$/ }).click();
    await ask.locator('[role="status"]').waitFor();
    check('accepting it sends the real one',
      updateRequestCalls.filter((c) => !c.dryRun).length, 1);
    check('and it carries the window and the date the admin typed',
      (() => { const w = updateRequestCalls.find((c) => !c.dryRun);
        return { from: w.awardedFrom, to: w.awardedTo, due: w.dueDate, label: w.label }; })(),
      { from: '2025-01-01', to: '2025-12-31', due: '2027-11-14', label: '2025 grant update' });
    truthy('and it says what happened',
      /2 update requests created, due 2027-11-14/i.test(
        await ask.locator('[role="status"]').innerText()));


    // ---- a cycle, with the deadline that matters ---------------------------
    await pageTz.getByRole('button', { name: /^New cycle/ }).click();
    await pageTz.fill('#cycle-name-p1', 'FY2027 Spring');
    await pageTz.fill('#cycle-opens-p1', '2027-01-05T08:00');
    await pageTz.fill('#cycle-closes-p1', '2027-03-01T23:59');
    await pageTz.fill('#cycle-grace-p1', '24');

    truthy('the form says which zone the times are in, before saving',
      (await pageTz.locator('[data-testid="cycle-zone-echo"]').innerText()).includes('CST'));

    await pageTz.getByRole('button', { name: 'Create cycle' }).click();
    await pageTz.waitForFunction(() => document.querySelectorAll('tbody tr').length > 0, { timeout: 10_000 });

    check('the cycle name and grace window arrive intact',
      configCalls.cycles.map((c) => [c.programId, c.name, c.draft_grace_hours]),
      [['p1', 'FY2027 Spring', 24]]);

    /*
     * 8:00 AM Central on 5 January 2027 is 14:00 UTC (CST, -6).
     * 11:59 PM Central on 1 March 2027 is 05:59 UTC the next day.
     * A browser in London reading these as local time would send 08:00 and
     * 23:59 UTC instead -- six hours and six hours wrong.
     */
    check('a Central wall time leaves as the right UTC instant, from a London browser',
      [configCalls.cycles[0]?.opens_at, configCalls.cycles[0]?.closes_at],
      ['2027-01-05T14:00:00.000Z', '2027-03-02T05:59:00.000Z']);

    // ---- opening it --------------------------------------------------------
    pageTz.once('dialog', (d) => d.accept());
    await pageTz.getByRole('button', { name: /^Open / }).click();
    // The real observable is the control flipping: an open cycle offers Close.
    // Waiting on the word "open" appearing anywhere matched nothing, because
    // the column header reads "Opens" and includes() is case-sensitive.
    await pageTz.getByRole('button', { name: /^Close / }).waitFor({ timeout: 10_000 });
    check('opening a cycle asks first, then opens exactly that cycle',
      configCalls.status, [{ id: 'c1', next: 'open' }]);

    check('no console errors while configuring', tzErrors, []);
    await ctxTz.close();

    // ---- a reviewer is offered none of it ----------------------------------
    resetConfigState();
    const ctxRev = await browser.newContext();
    const pageRev = await ctxRev.newPage();
    await stubApi(pageRev, { role: 'reviewer' });
    // A program exists, so the absence below is about the ROLE rather than
    // about an empty screen with nothing on it to act on.
    programsState = [
      { id: 'p1', name: 'Existing Program', slug: 'existing', status: 'open',
        fiscal_year: 2027, compliance_policy: 'warn' },
    ];
    cyclesState = [
      { id: 'c1', program_id: 'p1', name: 'FY2027 Spring', opens_at: '2027-01-05T14:00:00.000Z',
        closes_at: '2027-03-02T05:59:00.000Z', status: 'draft', draft_grace_hours: 0,
        opens_at_display: '5 Jan 2027, 8:00 AM CST', closes_at_display: '1 Mar 2027, 11:59 PM CST' },
    ];
    await pageRev.goto(`${base}/configuration`);
    await pageRev.locator('.panel h2').first().waitFor();

    check('a reviewer is offered no way to create a program',
      await pageRev.getByRole('button', { name: 'New program' }).count(), 0);
    check('a reviewer is offered no way to create a cycle',
      await pageRev.getByRole('button', { name: /^New cycle/ }).count(), 0);
    check('a reviewer cannot open a cycle, which would make a form public',
      await pageRev.getByRole('button', { name: /^Open FY2027/ }).count(), 0);
    truthy('but a reviewer can still see the cycle exists',
      (await pageRev.locator('tbody').innerText()).includes('FY2027 Spring'));
    await ctxRev.close();
    // Hand the stub back empty. The sections below this one were written when
    // /api/programs always answered with an empty list, and they wait on the
    // "No programs yet" state that a leftover program would hide.
    resetConfigState();

    // ---- as a reviewer -----------------------------------------------------
    mergedAlready = false;
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await stubApi(page2, { role: 'reviewer' });
    await page2.goto(`${base}/configuration`);
    await page2.getByRole('heading', { name: 'Configuration' }).or(page2.locator('.state h1')).first().waitFor();

    /*
     * ON THE CONFIGURATION SCREEN, which is where the panel lives for an
     * admin, and after it has rendered.
     *
     * The first version asked this question from the Reporting screen, where
     * the import panel would never appear for anybody -- so it passed for an
     * admin too, and a mutation that showed the panel to everyone survived it.
     * Counting zero of something proves nothing unless you are standing where
     * it would have been.
     */
    check(
      'a reviewer is offered no way to import grants',
      await page2.locator('section.panel', { hasText: 'Import grants from a spreadsheet' }).count(),
      0,
    );

    await page2.goto(`${base}/reporting`);
    await page2.getByRole('heading', { name: 'Grant reports' }).waitFor();
    check(
      'a reviewer cannot create obligations against somebody else\u2019s grant',
      await page2.getByRole('button', { name: 'Create missing report obligations' }).count(),
      0,
    );
    await goTo(page2, 'Programs');

    check(
      'a reviewer is not offered a door that answers FORBIDDEN',
      await page2.getByRole('button', { name: 'Data health' }).count(),
      0,
    );
    // The merge panel moved to the admin-only screen with the rest of data
    // health, so a reviewer no longer reaches it from anywhere in the UI. The
    // API still permits a staff READ -- that guard, and the admin-only merge,
    // are covered in test/merge.test.ts where they belong.
    check(
      'and the merge panel is gone from configuration',
      await page2.locator('article.review-section').count(),
      0,
    );
    await ctx2.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
