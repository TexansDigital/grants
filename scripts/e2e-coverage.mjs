/**
 * Review coverage and the conflict desk, driven in a real browser.
 *
 *   npm run e2e:coverage
 *
 * WHY. Both endpoints behind this screen existed with no door. `reviewCoverage`
 * has answered "which applications are short of reviewers" since Phase 3 and
 * nothing ever called it; a declared conflict blocked its reviewer and could
 * only be acted on by somebody who knew an assignment id that appeared on no
 * screen. A handler with no page is a feature that does not exist, and the
 * only way to find that out is to open the page.
 *
 * WHAT THIS PROVES. The screen renders; a shortfall is marked rather than left
 * for somebody to compare two columns in their head; both resolutions demand
 * words before they will fire; "not a conflict" and "recuse" send what they
 * say they send; and the list refreshes afterwards so a resolved disclosure
 * leaves the desk.
 *
 * WHAT IT DOES NOT PROVE. The API is a fixture. Who may call these endpoints,
 * what a clear does to the record, and the seven places that had to learn the
 * difference between a declared conflict and an outstanding one are covered in
 * test/reviewAssign.test.ts, test/scoring.test.ts and test/scorecards.test.ts.
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

const COVERAGE = {
  cycleId: 'cy1',
  target: 2,
  under: 1,
  rows: [
    {
      application_id: 'app1', project_title: 'After-school meals',
      organization_name: 'Invented Collective', reviewers: 1, conflicts: 1, completed: 0,
    },
    {
      application_id: 'app2', project_title: 'Literacy Lab',
      organization_name: 'Invented Reach', reviewers: 2, conflicts: 0, completed: 2,
    },
  ],
};

function state() {
  return {
    sent: [],
    conflicts: [
      {
        assignmentId: 'ra1', applicationId: 'app1',
        projectTitle: 'After-school meals', organizationName: 'Invented Collective',
        reviewerEmail: 'consultant@example.org',
        declaredAt: '2026-03-02T12:00:00.000Z',
        note: 'I think I know somebody on their board.',
      },
    ],
  };
}

async function stubApi(page, s) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'admin@example.org', role: 'admin' } });
    }
    if (p === '/api/programs') {
      return json(route, { programs: [{ id: 'p1', name: 'Inspire Change', status: 'active' }] });
    }
    if (p === '/api/cycles') {
      return json(route, {
        cycles: [{
          id: 'cy1', program_id: 'p1', name: '2026 cycle',
          opens_at: '2026-01-01T06:00:00.000Z', closes_at: '2026-03-01T05:59:00.000Z',
          status: 'open', draft_grace_hours: null,
          opens_at_display: 'January 1, 2026', closes_at_display: 'February 28, 2026',
        }],
      });
    }
    if (p === '/api/forms') return json(route, { forms: [] });
    if (p === '/api/cycles/cy1/review-coverage') return json(route, COVERAGE);
    if (p === '/api/cycles/cy1/conflicts') return json(route, { conflicts: s.conflicts });

    if (p === '/api/review/assignments/ra1/conflict/clear' && method === 'POST') {
      s.sent.push({ kind: 'clear', body: JSON.parse(route.request().postData() ?? '{}') });
      s.conflicts = [];
      return json(route, { ok: true });
    }
    if (p === '/api/review/assignments/ra1/recuse' && method === 'POST') {
      s.sent.push({ kind: 'recuse', body: JSON.parse(route.request().postData() ?? '{}') });
      s.conflicts = [];
      return json(route, { ok: true });
    }
    return json(route, {});
  });
}

async function main() {
  const { server, port } = await serveAssets(join(process.cwd(), 'public'));
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    // ---- the screen renders, with the shortfall marked --------------------
    const s = state();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await stubApi(page, s);

    await page.goto(`${base}/cycles/cy1/coverage`);
    // Wait for content, not for the heading: the loading branch renders the
    // same one, and waiting on it is a race this project has lost before.
    await page.getByRole('heading', { name: /Disclosures to act on/ }).waitFor();

    const body = await page.locator('body').innerText();
    check(
      'the page rendered rather than falling into the error boundary',
      body.includes('Something went wrong on this page'),
      false,
    );
    check('the shortfall is stated in words, not left as two columns to compare',
      body.includes('1 application has fewer than 2 reviewers'), true);
    check('the disclosure names the reviewer and what they said', [
      body.includes('consultant@example.org'),
      body.includes('I think I know somebody on their board.'),
      body.includes('Invented Collective'),
    ], [true, true, true]);
    check(
      'and the screen says why it matters, because the reviewer cannot act on it',
      body.includes('cannot score that application until this is resolved'),
      true,
    );

    // ---- neither resolution fires without words ---------------------------
    await page.getByRole('button', { name: /Not a conflict/ }).click();
    await page.getByRole('heading', { name: /Record that this is not a conflict/ }).waitFor();
    check(
      'an empty resolution cannot be recorded',
      await page.getByRole('button', { name: 'Record it' }).isDisabled(),
      true,
    );
    check(
      'the panel names the reviewer and says the declaration is kept',
      (await page.locator('.panel-decide').innerText()).includes('stays on the record'),
      true,
    );

    await page.locator('#conflict-words').fill('Different person. Checked the board list.');
    check(
      'and is enabled once there is something to record',
      await page.getByRole('button', { name: 'Record it' }).isDisabled(),
      false,
    );
    await page.getByRole('button', { name: 'Record it' }).click();
    await page.getByText('Recorded as not a conflict').waitFor();

    check('exactly one call went out', s.sent.length, 1);
    check('it was the clear, not the recusal', s.sent[0].kind, 'clear');
    check('and it carried the words that were typed',
      s.sent[0].body.resolution, 'Different person. Checked the board list.');
    check(
      'the desk is empty afterwards, because the list reloaded',
      (await page.locator('body').innerText()).includes('Nothing is waiting.'),
      true,
    );

    // ---- recusal is the other branch, and says what it costs --------------
    const s2 = state();
    const page2 = await ctx.newPage();
    await stubApi(page2, s2);
    await page2.goto(`${base}/cycles/cy1/coverage`);
    await page2.getByRole('heading', { name: /Disclosures to act on/ }).waitFor();
    await page2.getByRole('button', { name: /^Recuse/ }).click();
    await page2.getByRole('heading', { name: /Recuse consultant@example.org/ }).waitFor();
    check(
      'a recusal says it leaves the application short a reviewer',
      (await page2.locator('.panel-decide').innerText()).includes('one reviewer short'),
      true,
    );
    await page2.locator('#conflict-words').fill('Safer to step back.');
    await page2.getByRole('button', { name: 'Recuse them' }).click();
    await page2.getByText('has been recused from').waitFor();
    check('the recusal carried its reason', s2.sent[0].body.reason, 'Safer to step back.');
    check('and nothing was cleared', s2.sent.filter((x) => x.kind === 'clear').length, 0);

    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
  console.log('Not proven here: who may call these endpoints, and what a clear');
  console.log('does to the record. Those are unit tests, not a browser.');
  process.exit(failures === 0 ? 0 : 1);
}

await main();
