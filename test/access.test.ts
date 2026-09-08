import { describe, it, expect, beforeEach } from 'vitest';
import {
  verifyAccessJwt,
  extractAccessToken,
  certsUrlFor,
  __resetJwksCache,
  ACCESS_JWT_HEADER,
  type JwksFetcher,
} from '../src/lib/access';

/**
 * Cloudflare Access verification, tested against a real RSA keypair generated
 * here. No network, no Cloudflare account needed -- and stronger than clicking
 * through a real login, because these tokens are deliberately malformed in ways
 * a real IdP will never produce.
 */

const TEAM = 'texans.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const CONFIG = { teamDomain: TEAM, aud: AUD };
const NOW = Date.UTC(2026, 5, 1) ;
const NOW_SEC = Math.floor(NOW / 1000);

function b64url(bytes: Uint8Array | string): string {
  const arr = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Signer {
  kid: string;
  jwks: { keys: unknown[] };
  sign: (header: Record<string, unknown>, payload: Record<string, unknown>) => Promise<string>;
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as unknown as Record<string, unknown>;

  return {
    kid,
    jwks: { keys: [{ kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: pub.n, e: pub.e }] },
    async sign(header, payload) {
      const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
      const p = b64url(JSON.stringify(payload));
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`)),
      );
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}

function goodPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://${TEAM}`,
    aud: [AUD],
    email: 'Admin.Primary@Example.org',
    sub: 'user-sub-1',
    iat: NOW_SEC - 60,
    exp: NOW_SEC + 3600,
    ...over,
  };
}

let signer: Signer;
let fetchJwks: JwksFetcher;
let fetchCount = 0;

beforeEach(async () => {
  __resetJwksCache();
  fetchCount = 0;
  signer = await makeSigner('kid-1');
  fetchJwks = async () => {
    fetchCount++;
    return signer.jwks as { keys: never[] };
  };
});

const verify = (token: string, config = CONFIG, now = NOW) =>
  verifyAccessJwt(token, config, { fetchJwks, now });

describe('Access JWT verification', () => {
  it('accepts a correctly signed assertion and normalises the email', async () => {
    const claims = await verify(await signer.sign({}, goodPayload()));
    expect(claims.email).toBe('admin.primary@example.org');
    expect(claims.sub).toBe('user-sub-1');
    expect(claims.aud).toContain(AUD);
  });

  it('builds the certs URL from the team domain, with or without a scheme', () => {
    expect(certsUrlFor(TEAM)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    expect(certsUrlFor(`https://${TEAM}/`)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });
});

describe('Access JWT: algorithm attacks', () => {
  it('rejects alg=none', async () => {
    const h = b64url(JSON.stringify({ alg: 'none', kid: 'kid-1', typ: 'JWT' }));
    const p = b64url(JSON.stringify(goodPayload()));
    await expect(verify(`${h}.${p}.`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects HS256, so the RSA public key cannot be replayed as an HMAC secret', async () => {
    const h = b64url(JSON.stringify({ alg: 'HS256', kid: 'kid-1', typ: 'JWT' }));
    const p = b64url(JSON.stringify(goodPayload()));
    await expect(verify(`${h}.${p}.c2ln`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a token with no kid', async () => {
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const p = b64url(JSON.stringify(goodPayload()));
    await expect(verify(`${h}.${p}.c2ln`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('Access JWT: signature integrity', () => {
  it('rejects a payload tampered with after signing', async () => {
    const token = await signer.sign({}, goodPayload());
    const [h, , s] = token.split('.');
    const forged = b64url(JSON.stringify(goodPayload({ email: 'attacker@example.org' })));
    await expect(verify(`${h}.${forged}.${s}`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a token signed by a different key with the same kid', async () => {
    const impostor = await makeSigner('kid-1');
    const token = await impostor.sign({}, goodPayload());
    // The key set still serves the genuine kid-1 public key.
    await expect(verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a kid that is not in the key set', async () => {
    const other = await makeSigner('kid-unknown');
    await expect(verify(await other.sign({}, goodPayload()))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects a token that is not three segments', async () => {
    await expect(verify('not.a.valid.jwt')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(verify('onlyonepart')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('Access JWT: claim checks', () => {
  it('rejects a token minted for a DIFFERENT Access application', async () => {
    // Correctly signed by the same team, wrong audience. This is the check that
    // stops another app in the same Cloudflare account granting staff access.
    const token = await signer.sign({}, goodPayload({ aud: ['b'.repeat(64)] }));
    await expect(verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('accepts an aud array that contains the configured tag among others', async () => {
    const token = await signer.sign({}, goodPayload({ aud: ['b'.repeat(64), AUD] }));
    await expect(verify(token)).resolves.toMatchObject({ email: 'admin.primary@example.org' });
  });

  it('rejects a mismatched issuer', async () => {
    const token = await signer.sign({}, goodPayload({ iss: 'https://evil.cloudflareaccess.com' }));
    await expect(verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects an expired token, allowing only small clock skew', async () => {
    const expired = await signer.sign({}, goodPayload({ exp: NOW_SEC - 3600 }));
    await expect(verify(expired)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const justExpired = await signer.sign({}, goodPayload({ exp: NOW_SEC - 30 }));
    await expect(verify(justExpired)).resolves.toBeTruthy();
  });

  it('rejects a token with no exp at all', async () => {
    const p = goodPayload();
    delete p.exp;
    await expect(verify(await signer.sign({}, p))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a not-yet-valid token', async () => {
    const token = await signer.sign({}, goodPayload({ nbf: NOW_SEC + 3600 }));
    await expect(verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a token with no email claim', async () => {
    const p = goodPayload();
    delete p.email;
    await expect(verify(await signer.sign({}, p))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('never tells the client which check failed', async () => {
    const token = await signer.sign({}, goodPayload({ iss: 'https://evil.cloudflareaccess.com' }));
    try {
      await verify(token);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      // Internal message is detailed; the client-facing one is not an oracle.
      expect(e.message).toContain('iss');
      expect(e.publicMessage).toBe('Please sign in to continue.');
    }
  });
});

describe('Access JWT: configuration', () => {
  it('fails CLOSED when the team domain or audience is unset', async () => {
    const token = await signer.sign({}, goodPayload());
    // An unconfigured deployment must reject everything, not accept everything.
    await expect(
      verifyAccessJwt(token, { teamDomain: '', aud: AUD }, { fetchJwks, now: NOW }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      verifyAccessJwt(token, { teamDomain: TEAM, aud: '' }, { fetchJwks, now: NOW }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects everything when the certs endpoint returns no usable keys', async () => {
    const token = await signer.sign({}, goodPayload());
    const empty: JwksFetcher = async () => ({ keys: [] });
    await expect(
      verifyAccessJwt(token, CONFIG, { fetchJwks: empty, now: NOW }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('Access JWT: key caching', () => {
  it('reuses the fetched key set across requests', async () => {
    const token = await signer.sign({}, goodPayload());
    await verify(token);
    await verify(token);
    await verify(token);
    expect(fetchCount).toBe(1);
  });

  it('does not refetch on every unknown kid, so a bogus kid cannot hammer the certs endpoint', async () => {
    await verify(await signer.sign({}, goodPayload()));
    expect(fetchCount).toBe(1);

    const bogus = await makeSigner('made-up-kid');
    for (let i = 0; i < 5; i++) {
      await expect(verify(await bogus.sign({}, goodPayload()))).rejects.toBeTruthy();
    }
    expect(fetchCount).toBe(1);
  });
});

describe('extracting the assertion from a request', () => {
  it('reads the Access header', () => {
    const req = new Request('https://example.org/', { headers: { [ACCESS_JWT_HEADER]: ' token-value ' } });
    expect(extractAccessToken(req)).toBe('token-value');
  });

  it('falls back to the CF_Authorization cookie', () => {
    const req = new Request('https://example.org/', {
      headers: { Cookie: 'other=1; CF_Authorization=cookie-token; another=2' },
    });
    expect(extractAccessToken(req)).toBe('cookie-token');
  });

  it('returns null when neither is present', () => {
    expect(extractAccessToken(new Request('https://example.org/'))).toBeNull();
  });

  it('IGNORES the forgeable authenticated-user-email header', () => {
    // Cf-Access-Authenticated-User-Email is a convenience header. Anything that
    // reaches the Worker directly on workers.dev can set it, bypassing Access.
    const req = new Request('https://example.org/', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'admin.primary@example.org' },
    });
    expect(extractAccessToken(req)).toBeNull();
  });
});
