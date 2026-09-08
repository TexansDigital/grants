/**
 * Cloudflare Access JWT verification.
 *
 * Access sits in front of the staff surface and, on success, forwards the
 * request with a signed assertion. That assertion is the ONLY thing that says
 * who a staff member is, so everything here fails closed and nothing is
 * trusted that has not been cryptographically verified.
 *
 * Specifically NOT trusted:
 *   - the `Cf-Access-Authenticated-User-Email` header, which is a convenience
 *     header and is trivially forgeable by anything that can reach the Worker
 *     directly on its workers.dev hostname, bypassing Access entirely
 *   - the JWT payload before the signature is checked
 *   - the `alg` header field, which is attacker-controlled
 *
 * The verification is deliberately explicit rather than delegated to a JWT
 * library: the algorithm allowlist, the audience check and the clock handling
 * are the parts that get silently wrong, and they should be readable.
 */

import { AppError } from './errors';

/** The assertion header Access sets. Also available as the CF_Authorization cookie. */
export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const ACCESS_COOKIE = 'CF_Authorization';

/**
 * Only RS256. Access signs with RS256; accepting anything else is how
 * algorithm-confusion attacks work -- notably `none`, and HS256 where the
 * RSA public key is replayed as an HMAC secret.
 */
const ALLOWED_ALG = 'RS256';

/** Small tolerance for clock skew between Cloudflare and the edge. */
const CLOCK_SKEW_SECONDS = 60;

/** How long a fetched key set is reused before refetching. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Floor between refetches triggered by an unknown key id, so a bogus kid cannot be used to hammer the certs endpoint. */
const JWKS_MIN_REFETCH_MS = 60 * 1000;

export interface AccessClaims {
  email: string;
  sub: string;
  /** Access application audience tag. */
  aud: string[];
  iss: string;
  exp: number;
  iat: number;
  /** Identity provider name, when Access includes it. */
  idp?: string;
}

export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

/** Injectable so tests can supply a locally generated key set. */
export type JwksFetcher = (certsUrl: string) => Promise<{ keys: Jwk[] }>;

interface CacheEntry {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/**
 * Module-scoped key cache.
 *
 * A Worker isolate is short-lived, so this is a warm-path optimisation, not
 * durable state. Keys are public, so caching them carries no secret.
 */
const jwksCache = new Map<string, CacheEntry>();

function unauthenticated(internal: string): AppError {
  return new AppError('UNAUTHENTICATED', 'Please sign in to continue.', {
    internalMessage: internal,
    severity: 'warn',
  });
}

function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
  } catch {
    throw unauthenticated('access token segment is not valid JSON');
  }
}

const defaultFetcher: JwksFetcher = async (certsUrl) => {
  const res = await fetch(certsUrl, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw unauthenticated(`access certs fetch failed with ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
};

export function certsUrlFor(teamDomain: string): string {
  const host = teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${host}/cdn-cgi/access/certs`;
}

async function importKeys(jwks: { keys: Jwk[] }): Promise<Map<string, CryptoKey>> {
  const map = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys ?? []) {
    // Skip anything that is not an RSA signing key rather than trying to use it.
    if (jwk.kty !== 'RSA') continue;
    if (jwk.alg && jwk.alg !== ALLOWED_ALG) continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: ALLOWED_ALG, ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      map.set(jwk.kid, key);
    } catch {
      // A malformed key in the set must not take down verification for the
      // other keys, which is what happens during a key rotation.
      continue;
    }
  }
  return map;
}

async function keysFor(
  config: AccessConfig,
  fetcher: JwksFetcher,
  wantKid: string,
  now: number,
): Promise<Map<string, CryptoKey>> {
  const url = certsUrlFor(config.teamDomain);
  const cached = jwksCache.get(url);

  const fresh = cached && now - cached.fetchedAt < JWKS_TTL_MS;
  if (fresh && cached!.keys.has(wantKid)) return cached!.keys;

  // Refetch when stale, or when the key id is unknown (a rotation). The floor
  // stops an attacker forcing a fetch per request with a made-up kid.
  const mayRefetch = !cached || now - cached.fetchedAt >= JWKS_MIN_REFETCH_MS;
  if (!mayRefetch) {
    if (cached) return cached.keys;
    throw unauthenticated('no access keys available and refetch is rate limited');
  }

  const keys = await importKeys(await fetcher(url));
  if (keys.size === 0) throw unauthenticated('access certs contained no usable RSA keys');
  jwksCache.set(url, { keys, fetchedAt: now });
  return keys;
}

/** Test seam. Never called in production. */
export function __resetJwksCache(): void {
  jwksCache.clear();
}

/**
 * Verify an Access assertion and return its claims.
 *
 * Throws UNAUTHENTICATED for every failure, with the reason recorded only in
 * the internal message. A client is never told which check failed: that
 * distinction is a probing oracle and is worth nothing to a legitimate user.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  opts: { fetchJwks?: JwksFetcher; now?: number } = {},
): Promise<AccessClaims> {
  if (!config.teamDomain || !config.aud) {
    // Unconfigured means every staff route is closed, loudly. The alternative
    // -- treating "no config" as "no checks" -- is an open door.
    throw new AppError('UNAUTHENTICATED', 'Sign-in is not configured.', {
      internalMessage: 'ACCESS_TEAM_DOMAIN or ACCESS_AUD is empty; staff auth fails closed',
      severity: 'fatal',
    });
  }

  const nowMs = opts.now ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const fetcher = opts.fetchJwks ?? defaultFetcher;

  const parts = token.split('.');
  if (parts.length !== 3) throw unauthenticated('access token is not a three-part JWS');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJson(headerB64);
  if (header.alg !== ALLOWED_ALG) {
    throw unauthenticated(`access token alg is ${String(header.alg)}, only ${ALLOWED_ALG} is accepted`);
  }
  const kid = typeof header.kid === 'string' ? header.kid : null;
  if (!kid) throw unauthenticated('access token header has no kid');

  const keys = await keysFor(config, fetcher, kid, nowMs);
  const key = keys.get(kid);
  if (!key) throw unauthenticated(`access token kid ${kid} is not in the key set`);

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(signatureB64);
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    signature as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  );
  // Nothing below this line may read the payload before this check passes.
  if (!ok) throw unauthenticated('access token signature did not verify');

  const payload = decodeJson(payloadB64);

  const expectedIss = `https://${config.teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  if (payload.iss !== expectedIss) {
    throw unauthenticated(`access token iss ${String(payload.iss)} does not match ${expectedIss}`);
  }

  // aud may be a string or an array. The configured tag must be present; a
  // token minted for a DIFFERENT Access application in the same account is
  // correctly signed and must still be refused.
  const audClaim = payload.aud;
  const audList = Array.isArray(audClaim) ? audClaim.map(String) : typeof audClaim === 'string' ? [audClaim] : [];
  if (!audList.includes(config.aud)) {
    throw unauthenticated('access token audience does not include this application');
  }

  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (exp === null) throw unauthenticated('access token has no exp');
  if (nowSec > exp + CLOCK_SKEW_SECONDS) throw unauthenticated('access token has expired');

  if (typeof payload.nbf === 'number' && nowSec + CLOCK_SKEW_SECONDS < payload.nbf) {
    throw unauthenticated('access token is not yet valid');
  }
  if (typeof payload.iat === 'number' && nowSec + CLOCK_SKEW_SECONDS < payload.iat) {
    throw unauthenticated('access token was issued in the future');
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) throw unauthenticated('access token carries no email claim');

  return {
    email,
    sub: typeof payload.sub === 'string' ? payload.sub : '',
    aud: audList,
    iss: String(payload.iss),
    exp,
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
    ...(typeof payload.identity_nonce === 'string' ? {} : {}),
    ...(typeof payload.idp === 'string' ? { idp: payload.idp } : {}),
  };
}

/** Pull the assertion from the header, falling back to the cookie Access sets. */
export function extractAccessToken(request: Request): string | null {
  const header = request.headers.get(ACCESS_JWT_HEADER);
  if (header) return header.trim();

  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === ACCESS_COOKIE && rest.length > 0) return rest.join('=').trim();
  }
  return null;
}
