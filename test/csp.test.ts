/**
 * The Content-Security-Policy on the page that has to reach R2.
 *
 * WHY THIS FILE EXISTS. `connect-src 'self'` blocked every presigned upload.
 * The browser refused the cross-origin PUT before making it, so there was no
 * request, no 403 from R2, and nothing in any Worker log -- only a console line
 * on a page nobody was watching. No applicant or grantee could have uploaded a
 * file, and three uploads are required to submit an Inspire Change application.
 *
 * NOTHING COULD SEE IT. The unit tests never asserted on the policy. The
 * applicant browser harness drives Vite's dev server, which serves no CSP at
 * all, so its upload assertions passed against a page with no policy on it.
 * The fault lived only where the Worker writes headers, which nothing checked.
 *
 * So these tests assert the two halves that have to agree: that the origin the
 * signer sends the browser to is the origin the policy admits, and that the
 * permission is exactly that one bucket rather than a wildcard.
 */

import { describe, it, expect } from 'vitest';
import { contentSecurityPolicy, htmlHeaders } from '../src/lib/httpHeaders';
import { r2Origin, r2UploadOrigin } from '../src/lib/uploads';
import type { Env } from '../src/types';

const envWith = (over: Partial<Env> = {}): Env =>
  ({ R2_BUCKET_NAME: 'steward-preview-files', R2_ACCOUNT_ID: 'acct123', ...over }) as Env;

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `) || d === name) ?? '';
const connectSrc = (csp: string) => directive(csp, 'connect-src');

describe('the page may reach exactly one other origin', () => {
  it('admits the bucket the signer actually sends the browser to', () => {
    const env = envWith();
    const origin = r2UploadOrigin(env);
    expect(origin).toBe(r2Origin('steward-preview-files', 'acct123'));
    // The agreement that was broken: the policy must name the SAME origin the
    // presigned URL is built from. One definition, asserted from both ends.
    expect(connectSrc(contentSecurityPolicy(origin))).toBe(
      `connect-src 'self' https://steward-preview-files.acct123.r2.cloudflarestorage.com`,
    );
  });

  it('never admits every R2 bucket on every account', () => {
    // A wildcard would work and would be a much larger permission than "this
    // application may write to its own bucket".
    const csp = contentSecurityPolicy(r2UploadOrigin(envWith()));
    expect(csp).not.toContain('*.r2.cloudflarestorage.com');
    expect(csp).not.toContain("connect-src 'self' *");
  });

  it('allows nothing extra when uploads are unconfigured', () => {
    expect(r2UploadOrigin(envWith({ R2_ACCOUNT_ID: '' }))).toBeNull();
    expect(r2UploadOrigin(envWith({ R2_BUCKET_NAME: '' }))).toBeNull();
    expect(connectSrc(contentSecurityPolicy(null))).toBe("connect-src 'self'");
  });

  it('puts the upload origin on the HTML shell, which is the document that matters', () => {
    // A CSP governs only the document it is served with. The identical header
    // on a JSON response governs nothing.
    const headers = htmlHeaders('req-1', r2UploadOrigin(envWith()));
    expect(headers['content-security-policy']).toContain(
      'https://steward-preview-files.acct123.r2.cloudflarestorage.com',
    );
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('lets the Turnstile widget load, which it could not', () => {
    /*
     * THE BUG THIS PREVENTS, and it is the upload fault again in a second
     * place. Turnstile loads a script from challenges.cloudflare.com and
     * renders its challenge in an iframe from the same origin. Under
     * `script-src 'self'` the browser refused the script and `default-src
     * 'self'` refused the frame, so the widget never appeared and no token was
     * ever produced -- on the sign-in page and the eligibility screen, the two
     * doors every applicant and grantee comes through.
     *
     * Nothing in the suite could see it: the applicant harness drives Vite,
     * which serves no policy. The browser console said so on every load.
     */
    const csp = contentSecurityPolicy(r2UploadOrigin(envWith()), true);
    expect(directive(csp, 'script-src')).toBe(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(directive(csp, 'frame-src')).toBe('frame-src https://challenges.cloudflare.com');
    // Widening for Turnstile must not widen anything else.
    expect(connectSrc(csp)).toBe(
      "connect-src 'self' https://steward-preview-files.acct123.r2.cloudflarestorage.com",
    );
    expect(csp).not.toContain('*');
  });

  it('allows nothing for Turnstile when no site key is configured', () => {
    // An environment with no key renders no widget, so there is nothing to
    // allow -- the same rule the upload origin follows.
    const csp = contentSecurityPolicy(null, false);
    expect(directive(csp, 'script-src')).toBe("script-src 'self'");
    expect(directive(csp, 'frame-src')).toBe("frame-src 'none'");
    expect(csp).not.toContain('challenges.cloudflare.com');
  });

  it('puts the Turnstile permission on the shell only when the key is set', () => {
    expect(htmlHeaders('req-1', null, true)['content-security-policy'])
      .toContain('https://challenges.cloudflare.com');
    expect(htmlHeaders('req-1', null, false)['content-security-policy'])
      .not.toContain('challenges.cloudflare.com');
  });

  it('leaves every other directive alone', () => {
    // Widening one directive must not quietly widen another.
    const csp = contentSecurityPolicy(r2UploadOrigin(envWith()));
    for (const d of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
    ]) {
      expect(csp).toContain(d);
    }
  });
});
