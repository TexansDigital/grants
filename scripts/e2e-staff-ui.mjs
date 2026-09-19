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
    await page.goto(`${base}/configuration`);

    const panel = page.locator('section.panel', { hasText: 'Possible duplicate organizations' });
    await panel.waitFor();
    truthy('the duplicates panel renders', await panel.isVisible());
    check(
      'it says how many there are to look at',
      (await panel.locator('.panel-head .meta').first().textContent())?.trim(),
      '2 to look at',
    );

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
    await page.waitForFunction(() => !document.body.innerText.includes('EIN 743210099'));
    check('accepting merges the duplicate into the survivor', mergeCalls, [
      { duplicateId: 'org-bayou-heavy', into: 'org-bayou-thin' },
    ]);
    check(
      'the list re-reads itself afterwards',
      (await panel.locator('.panel-head .meta').first().textContent())?.trim(),
      '1 to look at',
    );

    // A screenshot on demand. The only way to see that a panel built from the
    // applicant form's vocabulary does not paint a white card on a dark ground.
    if (process.env.STEWARD_SHOT) {
      await page.screenshot({ path: process.env.STEWARD_SHOT, fullPage: true });
    }

    check('no console errors on the staff screen', consoleErrors, []);
    await ctx.close();

    // ---- as a reviewer -----------------------------------------------------
    mergedAlready = false;
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await stubApi(page2, { role: 'reviewer' });
    await page2.goto(`${base}/configuration`);
    const bayou2 = page2.locator('article.review-section', { hasText: 'EIN 743210099' });
    await bayou2.waitFor();
    await bayou2.getByRole('button', { name: /Preview merging Bayou Bridge Youth$/ }).click();
    await bayou2.locator('.panel-decide').waitFor();
    check(
      'a reviewer can look but gets no merge button',
      await bayou2.getByRole('button', { name: 'Merge them' }).count(),
      0,
    );
    truthy(
      'and is told who can do it',
      (await bayou2.locator('.panel-decide').innerText()).includes('administrator'),
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
