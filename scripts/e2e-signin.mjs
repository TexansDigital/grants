/**
 * The external front door, driven in a real browser.
 *
 *   npm run e2e:signin
 *
 * WHY THIS EXISTS. The sign-in page was missing entirely: the endpoint, the
 * hashed single-use tokens and the email template were all finished, and no UI
 * ever asked a nonprofit for their address. Every unit test passed. The only
 * way to find it was to open the address a nonprofit would open, which
 * produced an infinite "reload and sign in" loop against Cloudflare Access --
 * an Access the applicant hostname is deliberately not behind.
 *
 * So this checks the things a test of the handler cannot:
 *
 *   - '/' on the APPLICANT hostname lands on the sign-in page, not the staff
 *     pipeline, and not a loop.
 *   - The page is readable. The applicant surface is light and the staff
 *     stylesheet is dark; borrowing a class across them has already produced
 *     near-white text on a near-white ground in this project.
 *   - The acknowledgement is IDENTICAL for a known and an unknown address.
 *     That is what stops this being a way to ask which nonprofits applied for
 *     money, one address at a time, and it is a property no unit test of the
 *     handler can see, because it is about what the page renders.
 *   - It works at 320px. A program director files from a phone.
 *   - Staff routes are not served on this hostname.
 *
 * WHAT IT DOES NOT PROVE, and must not be reported as proving:
 *   - No email is delivered. Local dev has no RESEND_API_KEY, so every send is
 *     recorded as 'suppressed'. This checks what the PAGE does, not the mail.
 *   - Nothing about Turnstile. A site key IS configured now, so the page does
 *     try to load the widget -- but whether it actually renders and returns a
 *     token has to be seen on a deployed environment with real network access
 *     to challenges.cloudflare.com. What this file can and does check is that
 *     the page works with no token in hand; the CSP that lets the widget load
 *     at all is asserted in test/csp.test.ts.
 *   - It is not an accessibility test. Correct markup is not a screen reader.
 *
 * PREREQUISITES: `npm run build:web`, a migrated local database, and:
 *
 *   npm run dev:applicant
 *
 * THAT SCRIPT LOOKS WRONG AND IS NOT. It sets APPLICANT_BASE_URL to the
 * `grants.` hostname, which in production is the STAFF one. The reason is that
 * `wrangler dev` rewrites every incoming request's URL to the first hostname
 * declared in `routes`, so a Worker running locally sees
 * `http://grants.houstontexansfoundation.org/...` no matter what you typed in
 * the browser. Pointing APPLICANT_BASE_URL at that hostname is therefore how
 * you make local dev present the APPLICANT surface -- and plain `npm run dev`,
 * where the two differ, gives you the staff one.
 *
 * Found by probing request.url from inside the Worker after this harness
 * reported the hostname guard inert while its unit tests passed. The guard was
 * correct; the local address was a fiction.
 *
 * Writes invented data only, to the LOCAL preview database.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const APP = process.env.STEWARD_WORKER ?? 'http://127.0.0.1:8787';
const BROWSER = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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

function sql(statement) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'steward-preview', '--local', '--json', '--command', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

/** An invented grantee, so the known-address case has something to match. */
function seedGrantee() {
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `e2e-signin-${randomUUID().slice(0, 8)}@example.org`;
  const now = new Date().toISOString();
  sql(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES ('${orgId}','Invented Reach Collective','009900001','active','${now}','${now}')`,
  );
  sql(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${userId}','${email}','grantee','${orgId}',1,'${now}','${now}')`,
  );
  return email;
}

/** The rendered acknowledgement after submitting one address. */
async function acknowledgementFor(page, address) {
  await page.goto(`${APP}/sign-in`, { waitUntil: 'networkidle' });
  await page.fill('#sign-in-email', address);
  await page.click('button[type="submit"]');
  await page.waitForSelector('h2:has-text("Check your email")', { timeout: 10_000 });
  return (await page.textContent('.sign-in')).replace(/\s+/g, ' ').trim();
}

const run = async () => {
  const browser = await chromium.launch({ executablePath: BROWSER });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // --- the root path ------------------------------------------------------
  await page.goto(`${APP}/`, { waitUntil: 'networkidle' });
  check("'/' lands on the sign-in page", new URL(page.url()).pathname, '/sign-in');
  truthy('a sign-in heading is shown', await page.isVisible('h2:has-text("Sign in")'));
  truthy(
    'the staff pipeline is NOT rendered here',
    !(await page.isVisible('text=Pipeline')),
  );
  truthy(
    'no Cloudflare Access loop is offered',
    !(await page.isVisible('text=Reload and sign in')),
  );

  // --- readability, the cross-surface bug ---------------------------------
  const contrast = await page.evaluate(() => {
    const card = document.querySelector('.sign-in');
    const label = document.querySelector('label[for="sign-in-email"]');
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+/g).map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return {
      surface: document.documentElement.dataset.surface,
      theme: document.documentElement.dataset.theme,
      delta: Math.abs(lum(getComputedStyle(card).backgroundColor) - lum(getComputedStyle(label).color)),
    };
  });
  check('the applicant surface is set', contrast.surface, 'applicant');
  check('the applicant surface is pinned light', contrast.theme, 'light');
  truthy(`label contrasts with the card (delta ${Math.round(contrast.delta)})`, contrast.delta > 80);

  // --- one field, and the right kind --------------------------------------
  const field = await page.getAttribute('#sign-in-email', 'type');
  check('the address field is an email field', field, 'email');
  check(
    'there is exactly one text-ish input on the page',
    await page.locator('input:not([type="hidden"])').count(),
    1,
  );

  // --- ANTI-ENUMERATION ----------------------------------------------------
  const known = seedGrantee();
  const unknown = `nobody-${randomUUID().slice(0, 8)}@example.org`;
  const ackKnown = await acknowledgementFor(page, known);
  const ackUnknown = await acknowledgementFor(page, unknown);
  check('a known and an unknown address get IDENTICAL text', ackKnown, ackUnknown);
  truthy('the acknowledgement does not say "not found"', !/not found|no account/i.test(ackKnown));

  // --- the phone -----------------------------------------------------------
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${APP}/sign-in`, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(`no horizontal overflow at ${width}px`, overflow <= 0, true);
    const box = await page.locator('button[type="submit"]').boundingBox();
    truthy(`the submit button clears 44px at ${width}px (${Math.round(box.height)}px)`, box.height >= 44);
  }

  // --- the hostname split --------------------------------------------------
  const staffRoute = await page.evaluate(async (app) => {
    const res = await fetch(`${app}/api/programs`, { credentials: 'same-origin' });
    return res.status;
  }, APP);
  check('a staff route is not served on this hostname', staffRoute, 404);

  await browser.close();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
