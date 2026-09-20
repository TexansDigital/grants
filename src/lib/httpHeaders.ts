/**
 * The response headers every response carries, success or failure.
 *
 * Kept in one place because they were previously built twice -- once on the
 * success path and once in the error boundary -- and the two drifted: error
 * responses went out without a Content-Security-Policy. Nobody noticed until
 * the live headers were read side by side.
 *
 * The CSP is restrictive by default and is the floor the applicant form is
 * built against: no inline script, nothing loaded cross-origin, no framing.
 * Setting it now means the UI is written to fit the policy rather than the
 * policy being loosened later to fit the UI.
 */

/**
 * Build the policy.
 *
 * `uploadOrigin` is the ONE exception to "nothing cross-origin", and it exists
 * because a file upload must go direct from the browser to R2: the Worker only
 * authorizes it, and streaming a 15 MB file through the Worker hits the edge
 * request-body limit before the handler runs. So the page has to be allowed to
 * connect to exactly one other origin.
 *
 * IT WAS NOT ALLOWED, and that was a live fault rather than a design choice.
 * `connect-src 'self'` meant the browser refused every presigned PUT before
 * making it -- no request, no R2 error, nothing in any Worker log. No applicant
 * or grantee could have uploaded a file.
 *
 * The exact bucket origin, never a wildcard. `https://*.r2.cloudflarestorage.com`
 * would admit every R2 bucket on every Cloudflare account, which is a much
 * larger permission than "this application may write to its own bucket", and
 * the tighter form costs nothing because the origin is already config.
 *
 * Null when uploads are unconfigured: the policy then allows nothing extra,
 * which is correct, because there is nowhere to upload to.
 */
export function contentSecurityPolicy(uploadOrigin: string | null = null): string {
  const connect = uploadOrigin ? `connect-src 'self' ${uploadOrigin}` : "connect-src 'self'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    connect,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(
  requestId: string,
  uploadOrigin: string | null = null,
): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
    // Nothing here is cacheable: responses are per-session and often carry
    // another organization's data.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'content-security-policy': contentSecurityPolicy(uploadOrigin),
  };
}

/**
 * Headers for the HTML shell of the single-page app.
 *
 * Same policy as every other response, and this is the one that MATTERS: a
 * CSP only governs the document it is served with, so the shell's policy is
 * what decides whether the page may reach R2. The identical header on a JSON
 * response governs nothing, and is kept the same only so the two cannot drift
 * into disagreeing about anything else. The shell is served with no-store
 * because it is delivered from behind Cloudflare Access and names the hashed
 * asset files for the current deployment; a cached shell pointing at assets
 * from a previous deployment is a blank page for whoever kept the tab open.
 */
export function htmlHeaders(
  requestId: string,
  uploadOrigin: string | null = null,
): Record<string, string> {
  return {
    ...securityHeaders(requestId, uploadOrigin),
    'content-type': 'text/html; charset=utf-8',
  };
}

/**
 * Is this state-changing request coming from our own pages?
 *
 * WHAT THIS DEFENDS, which is easy to get backwards. `SameSite=Lax` governs
 * whether a cookie is SENT with a cross-site request. It says nothing about
 * whether a cookie may be SET by the response to one. So a cross-site,
 * top-level form POST that mints a session gets its `Set-Cookie` honoured, and
 * the victim's browser is then authenticated as whoever supplied the token --
 * login CSRF. The attacker does not steal a session; they install one, and
 * everything the victim does next is written into the attacker's organization
 * and readable by them.
 *
 * Two signals, because neither is universal:
 *   - `Sec-Fetch-Site`, which the browser sets and script cannot forge. Present
 *     in every current browser.
 *   - `Origin`, the fallback, which browsers attach to POST even when they omit
 *     it from GET.
 *
 * FAILS CLOSED, deliberately. A request that offers neither signal is refused
 * rather than trusted: this guards routes that are reached by a form in a
 * browser, and a browser always sends at least one. A non-browser caller that
 * legitimately needs these routes can send an Origin header.
 *
 * `allowedOrigin` comes from configuration, never from the request.
 */
export function isSameOriginRequest(request: Request, allowedOrigin: string): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) {
    // 'none' is a direct navigation -- typed, or a bookmark. A form POST is
    // never 'none', so accepting it would readmit exactly what this refuses.
    return site === 'same-origin';
  }

  const origin = request.headers.get('origin');
  if (origin === null) return false;

  const expected = allowedOrigin.trim().replace(/\/+$/, '');
  if (!expected) return false;
  try {
    return new URL(origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}
