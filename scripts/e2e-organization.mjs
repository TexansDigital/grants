/**
 * The organization page, driven in a real browser.
 *
 *   npm run e2e:organization
 *
 * WHY THIS EXISTS. CLAUDE.md says the institutional memory -- "this org has
 * applied three times, was funded once for $25,000, filed both reports on
 * time" -- lives in one person's head. This page is where it lives instead,
 * and the state it has to render correctly is a nonprofit with a grant and
 * nothing else: no application, no contacts, no login. That is every one of
 * the thirteen 2025 grantees today.
 *
 * The check that matters most is the one about signing in. A grantee with no
 * account is invisible to every reminder in the system, and the failure is
 * silent -- the report goes overdue, the nightly job finds nobody to email,
 * and the compliance desk shows a red row that nobody caused. The page has to
 * say that out loud, and say it as something a person must do rather than as
 * a status nobody reads.
 *
 * WHAT IT DOES NOT PROVE, and must never be reported as proving:
 *   - Nothing about Cloudflare Access or the role guards. The API is a
 *     fixture; admin-only and 404-not-403 are enforced by the Worker and
 *     covered by test/organizationPage.test.ts.
 *   - Nothing about the SQL. No database is touched.
 *   - It is not an accessibility test.
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
const falsy = (label, value) => {
  const ok = !value;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(value)}`}`);
};

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveAssets(root) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const candidate = join(root, normalize(path));
    const wanted = candidate.startsWith(root) && path !== '/' ? candidate : join(root, 'index.html');
    readFile(wanted)
      .then((body) => {
        res.writeHead(200, { 'content-type': TYPES[extname(wanted)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() =>
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

const ORG_ID = 'b1111111-1111-4111-8111-111111111111';
const AWARD_ID = 'a2222222-2222-4222-8222-222222222222';

/*
 * One of the thirteen, exactly as the importer leaves them: a grant, nothing
 * asked of it yet, nobody who can log in, no contacts and no applications.
 * Invented name and invented EIN, per CLAUDE.md.
 */
const UNCLAIMED = {
  id: ORG_ID,
  legalName: 'Bayou Harbor Trust',
  ein: '871234567',
  einVerifiedAt: null,
  website: null,
  mission: null,
  annualOperatingBudgetCents: null,
  status: 'active',
  mergedIntoId: null,
  mergedIntoName: null,
  awards: [
    {
      id: AWARD_ID,
      programName: 'Inspire Change',
      awardedAmountCents: 3_500_000,
      awardedAt: '2025-10-01T00:00:00.000Z',
      status: 'active',
      termStart: null,
      termEnd: null,
      reportsTotal: 0,
      reportsAccepted: 0,
      reportsOverdue: 0,
      reportsOutstanding: 0,
    },
  ],
  applications: [],
  contacts: [],
  totalAwardedCents: 3_500_000,
  canSignIn: false,
};

/** The same nonprofit once they have claimed, reported, and applied again. */
const ESTABLISHED = {
  ...UNCLAIMED,
  einVerifiedAt: '2025-11-02T00:00:00.000Z',
  website: 'https://bayouharbor.example.org',
  mission: 'Restoring tidal wetlands across the Houston Ship Channel.',
  annualOperatingBudgetCents: 1_250_000_00,
  awards: [
    {
      ...UNCLAIMED.awards[0],
      reportsTotal: 1,
      reportsAccepted: 0,
      reportsOverdue: 1,
      reportsOutstanding: 1,
    },
    {
      id: 'a3333333-3333-4333-8333-333333333333',
      programName: 'Inspire Change',
      awardedAmountCents: 2_500_000,
      awardedAt: '2024-10-01T00:00:00.000Z',
      status: 'closed',
      termStart: '2024-01-01T00:00:00.000Z',
      termEnd: '2024-12-31T00:00:00.000Z',
      reportsTotal: 2,
      reportsAccepted: 2,
      reportsOverdue: 0,
      reportsOutstanding: 0,
    },
  ],
  applications: [
    {
      id: 'app-1',
      status: 'submitted',
      submittedAt: '2026-03-01T00:00:00.000Z',
      requestedAmountCents: 4_000_000,
      projectTitle: 'Tidal marsh restoration',
      cycleName: '2026 Spring',
    },
  ],
  contacts: [
    {
      name: 'Dana Reyes',
      email: 'dana.reyes@example.org',
      jobTitle: 'Executive Director',
      isPrimary: true,
      hasAccount: true,
      lastLoginAt: '2026-09-28T00:00:00.000Z',
    },
    {
      name: 'sam.okafor@example.org',
      email: 'sam.okafor@example.org',
      jobTitle: null,
      isPrimary: false,
      hasAccount: false,
      lastLoginAt: null,
    },
  ],
  totalAwardedCents: 6_000_000,
  canSignIn: true,
};

const MERGED = {
  ...UNCLAIMED,
  status: 'merged',
  mergedIntoId: 'b9999999-9999-4999-8999-999999999999',
  mergedIntoName: 'Bayou Harbor Trust Inc',
};

async function stubApi(page, { role, org }) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role } });
    }
    if (p.startsWith('/api/organizations/')) return json(route, org);
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });
    if (p === '/api/applications') return json(route, { applications: [], total: 0 });
    return json(route, {});
  });
}

async function open(browser, org, base, opts = {}) {
  const page = await browser.newPage(opts);
  await stubApi(page, { role: 'admin', org });
  await page.goto(`${base}/organizations/${ORG_ID}`);
  await page.getByRole('heading', { name: 'Bayou Harbor Trust', exact: true }).waitFor({
    timeout: 10_000,
  });
  return page;
}

async function main() {
  const root = normalize(join(process.cwd(), 'public'));
  const { server, port } = await serveAssets(root);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    // ---- 1. a funded nonprofit nobody can reach ---------------------------
    {
      const errors = [];
      const page = await browser.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      await stubApi(page, { role: 'admin', org: UNCLAIMED });
      await page.goto(`${base}/organizations/${ORG_ID}`);
      await page.getByRole('heading', { name: 'Bayou Harbor Trust', exact: true }).waitFor({
        timeout: 10_000,
      });

      const banner = await page.getByRole('status').first().innerText();
      truthy(
        'the page says no reminder can reach them',
        /no reminder from Steward can reach them/i.test(banner),
      );
      truthy(
        'and names what a person has to do about it',
        /somebody has to write to them/i.test(banner),
      );

      const body = await page.locator('main').innerText();
      truthy('the EIN is shown as it is printed', /87-1234567/.test(body));
      truthy('and flagged as unverified', /unverified/i.test(body));
      truthy('the total is in dollars', /\$35,000\b/.test(body));
      /*
       * "Nothing asked yet" rather than a dash. A dash in a reporting column
       * reads as a clean record, and this grant's reporting has not been
       * clean -- nobody has asked for it.
       */
      truthy('an unasked grant says so', /Nothing asked yet/i.test(body));
      truthy(
        'and the empty sections explain themselves',
        /never been funded|No applications|No contacts/i.test(body),
      );
      falsy(
        'no null, undefined or NaN reaches the screen',
        /\bnull\b|\bundefined\b/i.test(body) || /\bNaN\b/.test(body),
      );
      falsy('no console errors on the emptiest organization', errors.length > 0);
      await page.close();
    }

    // ---- 2. an established grantee ----------------------------------------
    {
      const page = await open(browser, ESTABLISHED, base);
      const body = await page.locator('main').innerText();
      falsy(
        'no sign-in banner once somebody can sign in',
        /no reminder from Steward can reach them/i.test(body),
      );
      truthy('both grants are listed', /\$35,000\b/.test(body) && /\$25,000\b/.test(body));
      truthy('the total is the sum', /\$60,000\b/.test(body));
      truthy('an overdue report is called out', /1 overdue/.test(body));
      truthy('and a clean one is counted', /2 of 2 accepted/.test(body));
      truthy('a contact with no name falls back to the address', /sam\.okafor@example\.org/.test(body));
            /*
       * Asserted on the row rather than on the page: "No" appears in enough
       * places that a page-wide match would pass whatever the table said.
       */
      const samRow = page.locator('tr', { hasText: 'sam.okafor@example.org' });
      truthy(
        'and their missing account is visible on their own row',
        /\bNo\b/.test(await samRow.innerText()),
      );

      // The grant row reaches the grant.
      await page.getByRole('button', { name: /Open the grant awarded 2025-10-01/ }).click();
      await page.waitForURL(`${base}/awards/${AWARD_ID}`, { timeout: 10_000 });
      check('a grant row reaches the grant', new URL(page.url()).pathname, `/awards/${AWARD_ID}`);
      await page.close();
    }

    // ---- 3. a merged record says so before anything else -------------------
    {
      const page = await open(browser, MERGED, base);
      const banner = await page.getByRole('status').first().innerText();
      truthy('a merged record says it was merged', /merged into/i.test(banner));
      truthy('and names the live record', /Bayou Harbor Trust Inc/.test(banner));
      truthy(
        'and warns that what follows is only the audit trail',
        /audit trail/i.test(banner),
      );
      await page.close();
    }

    // ---- 4. the grant page reaches the nonprofit --------------------------
    {
      const page = await browser.newPage();
      await page.route('**/api/**', async (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p === '/api/session') {
          return json(route, { user: { id: 'u1', email: 'staff@example.org', role: 'admin' } });
        }
        if (p.startsWith('/api/organizations/')) return json(route, UNCLAIMED);
        if (p === `/api/awards/${AWARD_ID}/paperwork`) {
          return json(route, {
            awardId: AWARD_ID, organizationName: 'Bayou Harbor Trust', status: 'active',
            awardedAmountCents: 3_500_000, termStart: null, termEnd: null,
            announcementDate: null, updatedAt: '2026-10-01T00:00:00.000Z',
            acceptedAt: null, declinedByGranteeAt: null, granteeResponseNote: null,
            documents: [], outstanding: 3, scheduledCents: 0,
          });
        }
        if (p === `/api/awards/${AWARD_ID}/amendments`) return json(route, { amendments: [] });
        if (p === `/api/awards/${AWARD_ID}/payments`) {
          return json(route, {
            awardId: AWARD_ID, organizationName: 'Bayou Harbor Trust',
            awardedAmountCents: 3_500_000, scheduledCents: 0, paidCents: 0,
            unscheduledCents: 3_500_000, payments: [],
          });
        }
        if (p.startsWith('/api/awards/')) {
          return json(route, {
            awardId: AWARD_ID, organizationId: ORG_ID, organizationName: 'Bayou Harbor Trust',
            programId: 'p1', programName: 'Inspire Change', cycleId: null, cycleName: null,
            applicationId: null, projectTitle: null, awardedAmountCents: 3_500_000,
            awardedAt: '2025-10-01T00:00:00.000Z', announcementDate: null,
            termStart: null, termEnd: null, status: 'active', isMultiYear: false,
            isPublic: false, sourceSystem: 'spreadsheet', sourceReference: 'IC-2025-004',
            acceptedAt: null, declinedByGranteeAt: null, parent: null, renewals: [],
            reports: [], whyNoReports: 'no_term_dates',
          });
        }
        if (p === '/api/programs') return json(route, { programs: [] });
        if (p === '/api/cycles') return json(route, { cycles: [] });
        if (p === '/api/forms') return json(route, { forms: [] });
        return json(route, {});
      });
      await page.goto(`${base}/awards/${AWARD_ID}`);
      await page.getByRole('button', { name: 'All their grants' }).click();
      await page.waitForURL(`${base}/organizations/${ORG_ID}`, { timeout: 10_000 });
      check(
        'the grant page reaches the nonprofit',
        new URL(page.url()).pathname,
        `/organizations/${ORG_ID}`,
      );
      await page.close();
    }

    // ---- 5. phone width ---------------------------------------------------
    {
      const page = await open(browser, ESTABLISHED, base, { viewport: { width: 390, height: 780 } });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check('no sideways scroll at 390px', overflow <= 0, true);
      await page.screenshot({ path: '/tmp/organization-narrow.png', fullPage: true });
      await page.close();
    }

    // Pictures, for a human. The unclaimed case in both themes, because that
    // is the one the Foundation will actually be looking at this month.
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: 1280, height: 1000 },
      });
      const page = await ctx.newPage();
      await stubApi(page, { role: 'admin', org: ESTABLISHED });
      await page.goto(`${base}/organizations/${ORG_ID}`);
      await page.getByRole('heading', { name: 'Bayou Harbor Trust', exact: true }).waitFor({
        timeout: 10_000,
      });
      await page.screenshot({ path: `/tmp/organization-${scheme}.png`, fullPage: true });
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
