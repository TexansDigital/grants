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
  ],
};

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
};

function serveAssets(root) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    // Every route is client-side, so anything that is not a real file is the
    // shell -- exactly what the Worker's static-asset handler does.
    const file = path.startsWith('/assets/') ? join(root, normalize(path)) : join(root, 'index.html');
    readFile(file)
      .then((body) => {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function stubApi(page, { role }) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role } });
    }
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });
    // The health screen links into the pipeline, which fetches this. Stubbed
    // so the console-error check stays meaningful instead of absorbing a 404.
    if (p === '/api/applications') return json(route, { applications: [], total: 0 });

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
    check('every check is on screen, including the clean one', await checks.count(), 5);
    check(
      'in the order the server sorted them, blocking first',
      await checks.locator('.check-head h3').allInnerTexts(),
      [
        'Active grants with no W-9',
        'Grants that will never be asked to report',
        'Active grants with no signed agreement',
        'EINs never checked against the IRS file',
        'Possible duplicate organizations',
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
    await page.getByRole('button', { name: 'Data health' }).click();
    await page.locator('.health-summary').waitFor();
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

    /*
     * Narrow widths, as a standing guard rather than a one-off look. Adding
     * the fourth nav item pushed the masthead 63px past a 320px viewport and
     * scrolled the whole page sideways -- nothing on the health screen itself
     * was at fault, and no assertion about the health screen would have caught
     * it. This one would have.
     */
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

    // ---- as a reviewer -----------------------------------------------------
    mergedAlready = false;
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await stubApi(page2, { role: 'reviewer' });
    await page2.goto(`${base}/configuration`);
    await page2.getByRole('heading', { name: 'Configuration' }).or(page2.locator('.state h1')).first().waitFor();

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
