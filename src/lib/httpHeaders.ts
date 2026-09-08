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
