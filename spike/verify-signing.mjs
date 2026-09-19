/**
 * PHASE A SPIKE -- THROWAWAY, deleted with spike/.
 *
 *   node spike/verify-signing.mjs
 *
 * Checks the one part of the spike that can be checked without credentials:
 * that the self-signed JWT we hand Google is actually well formed and actually
 * verifies against the key that signed it.
 *
 * Worth doing because Google answers a mangled private key and a clock that is
 * two minutes fast with the SAME opaque error -- "invalid_grant" -- and gives
 * no hint which. Proving the signing here means that if the real run says
 * invalid_grant, the key is fine and the clock is the suspect.
 *
 * It signs with a keypair generated here and thrown away. No real credential is
 * read, and nothing leaves the machine.
 */

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
};
const truthy = (label, v) => {
  const ok = Boolean(v);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(v)}`}`);
};

// Bundle the Worker so its exports can be imported by Node. Node 22 has
// WebCrypto, atob and btoa, so the module runs unchanged outside Workers.
const out = '.spikebuild.mjs';
execFileSync(
  'npx',
  ['esbuild', 'spike/worker.ts', '--bundle', '--platform=neutral',
   '--format=esm', `--outfile=${out}`, '--log-level=warning'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

try {
  const mod = await import(`./../${out}`);
  const { signAssertion, readServiceAccount } = mod;

  // A throwaway keypair, shaped exactly like Google's: PKCS#8 PEM.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const sa = {
    client_email: 'steward-uploads@example-project.iam.gserviceaccount.com',
    private_key: privateKey,
  };

  // ---- the .dev.vars round trip ---------------------------------------
  const b64 = Buffer.from(JSON.stringify(sa)).toString('base64');
  truthy('the base64 blob is one line', !b64.includes('\n'));
  const read = readServiceAccount({ GOOGLE_SERVICE_ACCOUNT_B64: b64 });
  check('the key survives base64 -> JSON -> PEM intact', read.private_key, privateKey);
  check('and so does the address', read.client_email, sa.client_email);

  // A missing secret must say what to do, not throw something cryptic.
  let missing = '';
  try { readServiceAccount({}); } catch (e) { missing = e.message; }
  truthy('a missing secret names the file to put it in', missing.includes('.dev.vars'));

  // ---- the assertion ---------------------------------------------------
  const scope = 'https://www.googleapis.com/auth/drive.file';
  const jwt = await signAssertion(read, scope);
  const parts = jwt.split('.');
  check('three segments', parts.length, 3);

  const b64urlToJson = (s) =>
    JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

  check('header is RS256', b64urlToJson(parts[0]), { alg: 'RS256', typ: 'JWT' });

  const claims = b64urlToJson(parts[1]);
  check('issuer is the service account', claims.iss, sa.client_email);
  check('audience is the token endpoint', claims.aud, 'https://oauth2.googleapis.com/token');
  check('scope is the narrow one', claims.scope, scope);
  check('lifetime is one hour', claims.exp - claims.iat, 3600);
  truthy('issued now, not in some other epoch', Math.abs(claims.iat - Math.floor(Date.now() / 1000)) < 5);

  // No '+', '/' or '=' anywhere: base64url, not base64. Getting this wrong
  // produces a signature Google rejects maybe one time in twenty, depending on
  // the bytes -- the worst kind of bug to meet in production.
  truthy('base64url throughout, no padding', /^[A-Za-z0-9_.-]+$/.test(jwt));

  // ---- does it actually verify? ---------------------------------------
  const sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const v = createVerify('RSA-SHA256');
  v.update(`${parts[0]}.${parts[1]}`);
  truthy('the signature verifies against the signing key', v.verify(publicKey, sig));

  // And fails when it should -- otherwise the check above proves nothing.
  const tampered = createVerify('RSA-SHA256');
  tampered.update(`${parts[0]}.${parts[1]}x`);
  check('and does NOT verify over different bytes', tampered.verify(publicKey, sig), false);
} finally {
  rmSync(out, { force: true });
}

console.log(failures === 0 ? '\nsigning is sound' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
