/**
 * The applicant sign-in flow.
 *
 * THE INTERSTITIAL, WHICH IS THE WHOLE POINT OF THIS FILE'S SHAPE.
 *
 * A magic link is single-use. Nonprofits run Microsoft Defender Safe Links,
 * Mimecast and Barracuda, all of which FETCH urls in inbound mail to check
 * them. That GET spends the token before the human ever clicks. The applicant
 * then sees "already used", asks for another, and the scanner eats that one
 * too -- a sign-in that simply never works, on deadline night, with nobody to
 * call.
 *
 * So GET /auth/verify consumes NOTHING. It renders a page with a button, and
 * only the POST that button submits redeems the token. Scanners follow links;
 * they do not submit forms.
 *
 * ENUMERATION. Requesting a link answers identically whether or not the
 * address is known. Anything else turns this endpoint into a way to ask "does
 * this nonprofit have an account", which is a question about somebody else's
 * organization.
 */

import type { Env, RequestContext, Session } from '../types';
import { AppError } from './errors';
import { nowIso, formatInZone } from './time';
import { writeAudit } from './audit';
import { consumeLoginToken, issueLoginToken, TOKEN_TTL_MS } from './tokens';
import {
  createSession, signOut, sessionCookie, clearedSessionCookie, readSessionCookie,
  SESSION_TTL_MS,
} from './sessions';
import { sendEmail, transportFor } from './email';
import { SIGN_IN_LINK } from './emailTemplates';
import { checkRateLimit, SIGN_IN_EMAIL_LIMIT, SIGN_IN_IP_LIMIT } from './rateLimit';
import { verifyTurnstile } from './turnstile';

/** What every request-a-link call is told, whatever actually happened. */
const NEUTRAL_ACK =
  'If that address has an application with us, a sign-in link is on its way. It expires in 15 minutes.';

export interface RequestLinkBody {
  email?: unknown;
  turnstileToken?: unknown;
}

/**
 * Send a sign-in link, if the address is known.
 *
 * Returns the same body and status in every case: address unknown, address
 * known, address belongs to staff. Only rate limiting and a failed Turnstile
 * produce a different answer, and neither reveals anything about an account.
 */
export async function requestSignInLink(
  request: Request,
  env: Env,
  ctx: RequestContext,
  opts: { fetcher?: typeof fetch } = {},
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as RequestLinkBody;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  const turnstile = await verifyTurnstile(
    env,
    typeof body.turnstileToken === 'string' ? body.turnstileToken : null,
    ctx.ip,
    opts.fetcher,
  );
  if (!turnstile.ok) {
    throw new AppError('FORBIDDEN', 'We could not verify that you are a person. Please try again.', {
      internalMessage: `turnstile ${turnstile.reason}`,
      severity: 'warn',
      context: { reason: turnstile.reason },
    });
  }

  // Rate limit BEFORE looking anything up, and on the IP even when the address
  // is malformed -- otherwise the cheapest request is the one that probes.
  const byIp = await checkRateLimit(env, SIGN_IN_IP_LIMIT, ctx.ip ?? 'unknown');
  if (!byIp.allowed) throw tooMany(byIp.retryAfterSeconds);

  if (email) {
    const byEmail = await checkRateLimit(env, SIGN_IN_EMAIL_LIMIT, email);
    if (!byEmail.allowed) throw tooMany(byEmail.retryAfterSeconds);
  }

  if (email) {
    const user = await env.DB.prepare(
      `SELECT id, email, role FROM users
        WHERE email = ? AND deleted_at IS NULL AND is_active = 1
          AND role IN ('applicant','grantee')`,
    )
      .bind(email)
      .first<{ id: string; email: string; role: string }>();

    if (user) {
      // issueLoginToken supersedes any outstanding link first, so the newest
      // email is the one that works.
      const issued = await issueLoginToken(env.DB, ctx, { userId: user.id, email: user.email });
      const base = (env.APPLICANT_BASE_URL ?? '').replace(/\/+$/, '');

      await sendEmail(
        env,
        ctx,
        {
          template: SIGN_IN_LINK,
          to: user.email,
          // Keyed on the TOKEN, not the user: every request is a distinct
          // message, so asking for a second link actually sends one rather
          // than de-duplicating against the first.
          idempotencyKey: `sign_in_link:${issued.tokenId}`,
          vars: {
            url: `${base}/auth/verify?token=${encodeURIComponent(issued.token)}`,
            expiresInMinutes: Math.round(TOKEN_TTL_MS / 60000),
            destination: 'Inspire Change application',
            requestedAtDisplay: formatInZone(nowIso(), env.DISPLAY_TIMEZONE),
            requestAnotherUrl: `${base}/sign-in`,
          },
          context: { user_id: user.id, token_id: issued.tokenId },
        },
        transportFor(env),
      );

      await writeAudit(env.DB, ctx, {
        action: 'auth.magic_link_requested',
        entityType: 'user',
        entityId: user.id,
        // The token itself never appears here. The row records THAT a link was
        // issued and which one, so a support question has an answer without
        // the audit trail holding a live credential.
        after: { token_id: issued.tokenId, email: user.email },
      });
    }
  }

  return json({ message: NEUTRAL_ACK });
}

function tooMany(retryAfterSeconds: number): AppError {
  return new AppError(
    'RATE_LIMITED',
    'Too many sign-in requests. Please wait a few minutes and try again.',
    { internalMessage: 'sign-in rate limit', severity: 'warn', context: { retryAfterSeconds } },
  );
}

// ---------------------------------------------------------------------------
// The interstitial
// ---------------------------------------------------------------------------

/**
 * GET /auth/verify?token=...
 *
 * Renders a page and consumes NOTHING. Server-rendered with a plain form and
 * no JavaScript, so it works in every mail client's embedded browser and does
 * not depend on the app bundle having loaded.
 */
export function renderVerifyInterstitial(url: URL): Response {
  const token = url.searchParams.get('token') ?? '';
  const html = verifyPage(token);
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached, never stored: the URL contains a credential.
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      // The URL contains a credential, so it must not travel in a Referer to
      // anything the page links to or loads.
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * POST /api/auth/verify
 *
 * Redeems the token and starts a session. This is the only thing that spends
 * a link.
 */
export async function completeSignIn(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const token = form ? String(form.get('token') ?? '') : '';

  if (!token) return signInFailure('missing');

  // A redemption attempt is cheap for us and expensive to brute force, but it
  // is still an unauthenticated endpoint that writes.
  const byIp = await checkRateLimit(env, SIGN_IN_IP_LIMIT, ctx.ip ?? 'unknown');
  if (!byIp.allowed) throw tooMany(byIp.retryAfterSeconds);

  const outcome = await consumeLoginToken(env.DB, ctx, token);
  if (!outcome.ok) return signInFailure(outcome.reason);

  const session = await createSession(env, outcome.userId);

  await writeAudit(env.DB, ctx, {
    action: 'auth.logged_in',
    entityType: 'user',
    entityId: outcome.userId,
    after: { method: 'magic_link', token_id: outcome.tokenId },
  });

  // 303 so the browser follows with a GET and the token leaves the address bar.
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': sessionCookie(session.sessionToken, Math.floor(SESSION_TTL_MS / 1000)),
      'cache-control': 'no-store',
    },
  });
}

export async function signOutRoute(
  request: Request,
  env: Env,
  ctx: RequestContext,
  session: Session,
): Promise<Response> {
  await signOut(env, readSessionCookie(request), session.userId);
  await writeAudit(env.DB, ctx, {
    action: 'auth.logged_out',
    entityType: 'user',
    entityId: session.userId,
    after: { all_devices: true },
  });
  return new Response(null, {
    status: 303,
    headers: { location: '/sign-in', 'set-cookie': clearedSessionCookie(), 'cache-control': 'no-store' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function signInFailure(reason: string): Response {
  const message =
    reason === 'already_used'
      ? 'That sign-in link has already been used. Links work once, so please request a new one.'
      : reason === 'superseded'
        ? 'A newer sign-in link was sent to you. Please use the most recent email, or request another.'
        : 'That sign-in link has expired. Links last 15 minutes, so please request a new one.';
  return new Response(failurePage(message), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Pages
//
// Server-rendered, self-contained, no JavaScript and no external assets. These
// are reached from an email client, sometimes inside an embedded browser, and
// must work when nothing else has loaded.
// ---------------------------------------------------------------------------

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const PAGE_CSS = `
  :root { color-scheme: light; }
  body { margin:0; background:#f4f6f8; color:#021018;
         font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; }
  .wrap { max-width:520px; margin:0 auto; padding:48px 20px; }
  .card { background:#fff; border:1px solid #d7dde2; border-radius:8px; padding:28px; }
  h1 { margin:0 0 12px; font-size:22px; line-height:1.3; }
  p { margin:0 0 16px; }
  .muted { color:#4a555e; font-size:14px; }
  button { font:inherit; font-weight:600; background:#0075b5; color:#fff; border:0;
           border-radius:6px; padding:14px 24px; min-height:48px; cursor:pointer; }
  button:hover { background:#005f93; }
  button:focus-visible { outline:3px solid #021018; outline-offset:2px; }
  a { color:#0075b5; }
  .brand { background:#021018; color:#fff; padding:18px 28px; border-radius:8px 8px 0 0;
           font-weight:700; font-size:15px; }
  .card { border-radius:0 0 8px 8px; border-top:0; }
`;

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style>${PAGE_CSS}</style>
</head><body>
<div class="wrap">
  <div class="brand">Houston Texans Foundation</div>
  <div class="card">${inner}</div>
</div>
</body></html>`;
}

function verifyPage(token: string): string {
  return shell(
    'Sign in',
    `<h1>Sign in to your application</h1>
     <p>Select the button below to finish signing in.</p>
     <form method="POST" action="/api/auth/verify">
       <input type="hidden" name="token" value="${escape(token)}">
       <button type="submit">Sign in</button>
     </form>
     <p class="muted" style="margin-top:20px;">
       This step is here so that automatic link checkers used by email systems
       cannot use up your sign-in link before you do.
     </p>`,
  );
}

function failurePage(message: string): string {
  return shell(
    'Sign-in link',
    `<h1>This link cannot be used</h1>
     <p>${escape(message)}</p>
     <p><a href="/sign-in">Request a new sign-in link</a></p>
     <p class="muted">Your application is safe. Signing in again picks up exactly where you left off.</p>`,
  );
}

