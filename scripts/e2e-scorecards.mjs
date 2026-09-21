/**
 * The offline scorecard desk, driven in a real browser.
 *
 *   npm run e2e:scorecards
 *
 * WHY. Eight faults on this project reached a running deployment with the unit
 * suite green, and every one was found by opening the page. Four of the eight
 * were a new route missing from the list that loads session data.
 *
 * WHAT THIS PROVES. The page renders; the download is a real link rather than
 * a button that does nothing; a bad file shows its issues and leaves the
 * Import button disabled; a clean file shows what would change before anything
 * does; and editing the pasted file after a check discards the plan, so
 * nobody can apply a preview of a file they have replaced.
 *
 * WHAT IT DOES NOT PROVE. The API is a fixture. The rubric-version stamp, the
 * conflict and recusal refusals, and the single-parse guarantee are enforced
 * server-side and covered in test/scorecards.test.ts.
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

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const CLEAN_PLAN = {
  ok: true,
  rubricId: 'r1',
  rubricVersion: 2,
  issues: [],
  assignments: [
    {
      assignmentId: 'ra1', organization: 'Invented Guild', reviewerEmail: 'dana@example.org',
      scored: 3, cleared: 0, unchanged: 0,
    },
  ],
  totalScores: 3,
};

const BAD_PLAN = {
  ok: false,
  rubricId: 'r1',
  rubricVersion: 2,
  issues: [
    {
      row: null,
      message:
        'This scorecard was made for a different rubric (version 1). This cycle scores ' +
        'against version 2. Export a fresh one.',
    },
  ],
  assignments: [],
  totalScores: 0,
};

async function stubApi(page, s) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'admin@example.org', role: 'admin' } });
    }
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });

    if (p === '/api/cycles/cy1/reviewers') {
      return json(route, {
        cycleId: 'cy1',
        reviewers: [
          { reviewerUserId: 'u9', email: 'dana@example.org', assigned: 6, completed: 0, conflicts: 0 },
          { reviewerUserId: 'u8', email: 'sam@example.org', assigned: 3, completed: 3, conflicts: 1 },
        ],
      });
    }
    if (p === '/api/cycles/cy1/scorecard/preview' && method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      s.previews.push(body.csv);
      return json(route, body.csv.includes('STALE') ? BAD_PLAN : CLEAN_PLAN);
    }
    if (p === '/api/cycles/cy1/scorecard/import' && method === 'POST') {
      s.imports.push(JSON.parse(route.request().postData() ?? '{}').csv);
      return json(route, { applied: 3, assignments: 1 });
    }
    return json(route, {});
  });
}

async function main() {
  const { server, port } = await serveAssets(join(process.cwd(), 'public'));
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    const s = { previews: [], imports: [] };
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await stubApi(page, s);

    await page.goto(`${base}/cycles/cy1/scorecards`);
    // Wait for content rather than for the title: the reviewer table is what
    // arrives with the data, and the title is on screen before it. See the
    // note in e2e-letters.mjs.
    await page.getByRole('link', { name: /^Download/ }).first().waitFor();
    check(
      'the page rendered rather than hanging on Loading',
      await page.getByText('Loading…').count(),
      0,
    );

    /*
     * THE SCREEN SAYS WHAT THIS COSTS. CLAUDE.md is explicit that offline
     * scorecards carry no conflict declaration and no evidence of who filled
     * one in, and that this is a fallback rather than the path. The person
     * choosing it is the one who should be told.
     */
    check(
      'the screen says this is a fallback and why',
      (await page.locator('body').innerText()).includes('no evidence that the person'),
      true,
    );

    check(
      'every reviewer is offered a download',
      await page.getByRole('link', { name: /^Download/ }).count(),
      2,
    );
    check(
      'and it is a real link, so the browser saves the file',
      await page.getByRole('link', { name: /dana/ }).getAttribute('href'),
      '/api/cycles/cy1/scorecard/u9',
    );

    // ---- a file made for the wrong rubric ---------------------------------
    await page.locator('#scorecard-csv').fill('assignment_id,rubric_version\nSTALE,1');
    check(
      'Import is refused before anything has been checked',
      await page.getByRole('button', { name: 'Import' }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: 'Check it' }).click();
    await page.getByText('This file was not imported').waitFor();
    check(
      'the version mismatch is named precisely, not as sixty row errors',
      await page.getByText(/different rubric \(version 1\)/).count(),
      1,
    );
    check(
      'and Import stays refused',
      await page.getByRole('button', { name: 'Import' }).isDisabled(),
      true,
    );
    check('nothing was imported', s.imports.length, 0);

    // ---- a clean file -----------------------------------------------------
    await page.locator('#scorecard-csv').fill('assignment_id,rubric_version\nra1,2');
    /*
     * EDITING THE FILE DISCARDS THE PLAN. A plan describes a file; once the
     * file changes it describes nothing, and leaving it on screen invites
     * somebody to apply a preview of the file they just replaced.
     */
    check(
      'changing the file clears the previous result',
      await page.getByText('This file was not imported').count(),
      0,
    );

    await page.getByRole('button', { name: 'Check it' }).click();
    await page.getByText(/3 scores would change/).waitFor();
    check(
      'a clean file shows what would change, before it does',
      await page.locator('tbody tr').filter({ hasText: 'Invented Guild' }).count(),
      1,
    );

    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByText('Imported 3 scores across 1 review.').waitFor();
    check('the file was imported once', s.imports.length, 1);
    check(
      'and the box is cleared, so it cannot be applied twice',
      await page.locator('#scorecard-csv').inputValue(),
      '',
    );

    await ctx.close();
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
