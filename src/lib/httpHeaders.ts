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

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(requestId: string): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
    // Nothing here is cacheable: responses are per-session and often carry
    // another organization's data.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'content-security-policy': CSP,
  };
}

/**
 * Headers for the HTML shell of the single-page app.
 *
 * Identical policy to every other response -- same CSP, same nosniff, same
 * DENY -- differing only in content type. The shell is served with no-store
 * because it is delivered from behind Cloudflare Access and names the hashed
 * asset files for the current deployment; a cached shell pointing at assets
 * from a previous deployment is a blank page for whoever kept the tab open.
 */
export function htmlHeaders(requestId: string): Record<string, string> {
  return {
    ...securityHeaders(requestId),
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
