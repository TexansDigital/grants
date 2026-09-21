/**
 * The decision-letter desk, driven in a real browser.
 *
 *   npm run e2e:letters
 *
 * WHY. Seven faults on this project reached a running deployment with the unit
 * suite green, and every one was found by opening the page. Three of the seven
 * were a new route missing from the list that loads session data, so the
 * screen hung on "Loading..." forever.
 *
 * WHAT THIS PROVES. Both blocks render; the declines block is visibly locked
 * while an award is untold and says why in words; the award row refuses to
 * offer a send when no award record carries the amount; the decline box is
 * EMPTY, with no wording this system invented; and sending one passes only the
 * paragraphs a person typed.
 *
 * WHAT IT DOES NOT PROVE. The API is a fixture. The acceptances-first rule,
 * the human-release gate and the idempotency are enforced server-side and
 * covered in test/decisionComms.test.ts. Nothing here sends an email.
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

// ---------------------------------------------------------------------------
// Two awards and one decline. Invented organizations.
// ---------------------------------------------------------------------------

function state() {
  return {
    told: new Set(),
    // The second award has no award record yet, so its amount is unknown and
    // its letter cannot go.
    awards: [
      {
        applicationId: 'a1', status: 'awarded', organizationName: 'Invented Guild',
        projectTitle: 'After-school meals', contactEmail: 'one@example.org',
        decidedAt: '2026-09-01T12:00:00.000Z', awardedAmountCents: 2500000,
        announcementDate: '2026-11-05T12:00:00.000Z',
      },
      {
        applicationId: 'a2', status: 'awarded', organizationName: 'Invented Alliance',
        projectTitle: 'Reading corps', contactEmail: 'two@example.org',
        decidedAt: '2026-09-01T12:00:00.000Z', awardedAmountCents: null,
        announcementDate: null,
      },
    ],
    declines: [
      {
        applicationId: 'd1', status: 'declined', organizationName: 'Invented Society',
        projectTitle: 'Summer camp', contactEmail: 'three@example.org',
        decidedAt: '2026-09-01T12:00:00.000Z', awardedAmountCents: null,
        announcementDate: null,
      },
    ],
    sent: [],
  };
}

async function stubApi(page, s) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'admin@example.org', role: 'admin' } });
    }
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });

    if (p === '/api/cycles/cy1/communications') {
      const awards = s.awards.filter((r) => !s.told.has(r.applicationId));
      return json(route, {
        cycleId: 'cy1',
        cycleName: '2026 cycle',
        programName: 'Inspire Change',
        awards,
        declines: s.declines.filter((r) => !s.told.has(r.applicationId)),
        awardsCommunicated: s.awards.filter((r) => s.told.has(r.applicationId)).length,
        declinesUnlocked: awards.length === 0,
      });
    }

    const notify = p.match(/^\/api\/applications\/([^/]+)\/(notify-award|notify-decline|communicated)$/);
    if (notify && method === 'POST') {
      const [, id, kind] = notify;
      const body = JSON.parse(route.request().postData() ?? '{}');
      s.sent.push({ id, kind, body });
      s.told.add(id);
      return json(route, { applicationId: id, communicatedAt: new Date().toISOString() });
    }

    return json(route, {});
  });
}

async function main() {
  const { server, port } = await serveAssets(join(process.cwd(), 'public'));
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    const s = state();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept('ED called them on 12 September.'));
    await stubApi(page, s);

    await page.goto(`${base}/cycles/cy1/letters`);
    /*
     * WAIT FOR CONTENT, NOT FOR THE TITLE.
     *
     * The loading branch of this screen renders the SAME heading, so waiting
     * on the heading and then asserting "Loading…" is absent is a race. This
     * harness failed exactly once during the session it was written, with no
     * output captured and no reproduction in eleven subsequent runs; the same
     * race was later caught deterministically in the dashboard harness, which
     * is very likely what that failure was. Waiting for a section that only
     * exists once the data has arrived removes it either way.
     */
    await page.getByRole('heading', { name: /^Awards to send/ }).waitFor();
    check(
      'the page rendered rather than hanging on Loading',
      await page.getByText('Loading…').count(),
      0,
    );

    check(
      'both blocks are shown with their counts',
      [
        await page.getByRole('heading', { name: 'Awards to send (2)' }).count(),
        await page.getByRole('heading', { name: 'Declines to send (1)' }).count(),
      ],
      [1, 1],
    );

    /*
     * THE GATE, IN WORDS. A greyed-out button nobody can account for is how
     * somebody works around a rule they do not understand. The reason has to
     * be on the screen.
     */
    check(
      'the declines block says why it is locked',
      (await page.locator('body').innerText()).includes('Acceptances go first'),
      true,
    );
    check(
      'and offers no way to write a letter yet',
      await page.getByRole('button', { name: /^Write the letter/ }).isDisabled(),
      true,
    );

    /*
     * An award letter carries the amount, so it cannot go before somebody has
     * created the award record. A decision is not an award.
     */
    check(
      'an award with no award record cannot be sent',
      await page.locator('tbody tr').nth(1).getByRole('button', { name: 'Send award letter' }).isDisabled(),
      true,
    );
    check(
      'and says so rather than showing a blank amount',
      await page.locator('tbody tr').nth(1).getByText('no award record yet').count(),
      1,
    );

    // Send the first, record the second as told by phone -- the path that
    // exists because the largest awards are phoned.
    await page.locator('tbody tr').first().getByRole('button', { name: 'Send award letter' }).click();
    await page.getByText('Sent to Invented Guild.').waitFor();
    await page.locator('tbody tr').first().getByRole('button', { name: 'Told another way' }).click();
    await page.getByText('Recorded for Invented Alliance.').waitFor();

    check(
      'the manual record carries the note it was given',
      s.sent.find((x) => x.kind === 'communicated')?.body.note,
      'ED called them on 12 September.',
    );
    check(
      'every award letter has now gone out',
      (await page.locator('body').innerText()).includes('All 2 award letters have gone out.'),
      true,
    );

    // ---- the declines unlock ---------------------------------------------
    await page.getByRole('button', { name: /^Write the letter/ }).click();
    const box = page.locator('#letter-d1');
    await box.waitFor();

    /*
     * THE BOX IS EMPTY, and this is the assertion that matters most on this
     * screen. There is no standard decline wording in this system because the
     * Foundation has not settled any, and a helpful default that shipped would
     * be this system putting words in its mouth to 250 nonprofits.
     */
    check('the decline box starts empty', await box.inputValue(), '');
    check(
      'and the screen says the omission is deliberate',
      (await page.locator('body').innerText()).includes('no standard wording in this system'),
      true,
    );

    await box.fill(
      'We had far more strong applications this year than we were able to fund.\n\n' +
        'We hope you will apply again next cycle.',
    );
    await page.getByRole('button', { name: 'Send this letter' }).click();
    await page.getByText('Sent to Invented Society.').waitFor();

    const decline = s.sent.find((x) => x.kind === 'notify-decline');
    check(
      'blank lines become paragraphs',
      decline.body.body.length,
      2,
    );
    check(
      'and only the typed words are sent',
      decline.body.body[0],
      'We had far more strong applications this year than we were able to fund.',
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
