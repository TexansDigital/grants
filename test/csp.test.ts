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

const connectSrc = (csp: string) =>
  csp.split('; ').find((d) => d.startsWith('connect-src')) ?? '';

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

  it('leaves every other directive alone', () => {
    // Widening one directive must not quietly widen another.
    const csp = contentSecurityPolicy(r2UploadOrigin(envWith()));
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
});
