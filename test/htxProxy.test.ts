/**
 * The Houston Texans site's window onto Steward.
 *
 * WHY THESE EXIST AT ALL. This Worker's entire value is what it does when
 * Steward cannot be reached. A marketing page on houstontexans.com must
 * degrade rather than break, and -- far more importantly -- it must never say
 * "nothing is open" when the truth is "we could not ask". Those are different
 * sentences to a nonprofit deciding whether to spend an evening on an
 * application, and conflating them is the one way this Worker could do real
 * harm.
 *
 * AND WHY THEY ARE UNIT TESTS RATHER THAN A CURL SCRIPT. `wrangler dev`
 * persists `caches.default` to disk across restarts and does not honour
 * max-age, so every cache path "passes" locally by returning the same stored
 * copy forever. A stale-copy path verified that way would be verifying
 * nothing. The handler takes its fetch and its cache as arguments so these
 * can drive all four branches directly.
 */

import { describe, it, expect } from 'vitest';
import { handle, type Env, type Deps } from '../integrations/houstontexans-proxy/src/index';

const ENV: Env = {
  STEWARD_ORIGIN: 'https://apply.example.org',
  ALLOWED_ORIGIN: 'https://www.houstontexans.com',
  CACHE_SECONDS: '300',
  FALLBACK_SECONDS: '86400',
};

const CYCLES_UPSTREAM = {
  turnstileSiteKey: '0xSITEKEY',
  cycles: [
    {
      id: 'cy1',
      name: '2027 cycle',
      programName: 'Inspire Change',
      programDescription: 'Grants for nonprofits serving Greater Houston.',
      closesAt: '2027-03-01T05:59:00.000Z',
      closesAtDisplay: 'February 28, 2027',
      opensAtDisplay: 'January 5, 2027',
      guidelinesVersion: 'v3',
      firstStageName: 'Eligibility',
      formDefinitionId: 'fd-internal-1',
      shape: { questions: 10, writtenAnswers: 2, documents: 0 },
      requiresReportsFiled: true,
    },
  ],
};

const GRANTS_UPSTREAM = {
  grants: [
    {
      organizationName: 'Invented Reach Collective',
      programName: 'Inspire Change',
      fiscalYear: 2026,
      projectTitle: 'Literacy Lab',
      awardedAmountCents: 2_500_029,
      awardedYear: '2026',
    },
  ],
};

/** A cache that behaves, so the tests drive the branches rather than a disk. */
function fakeCache() {
  const store = new Map<string, string>();
  return {
    store,
    cache: {
      async match(req: Request | string): Promise<Response | undefined> {
        const url = typeof req === 'string' ? req : req.url;
        const body = store.get(url);
        return body === undefined ? undefined : new Response(body);
      },
      async put(req: Request | string, res: Response): Promise<void> {
        const url = typeof req === 'string' ? req : req.url;
        store.set(url, await res.text());
      },
    } as Pick<Cache, 'match' | 'put'>,
  };
}

function deps(
  over: { fetch?: Deps['fetch']; cache?: Pick<Cache, 'match' | 'put'> } = {},
): { deps: Deps; store: Map<string, string>; pending: Promise<unknown>[] } {
  const { store, cache } = fakeCache();
  const pending: Promise<unknown>[] = [];
  return {
    store,
    pending,
    deps: {
      fetch: over.fetch ?? (async () => new Response('nope', { status: 500 })),
      cache: over.cache ?? cache,
      waitUntil: (p) => pending.push(p),
    },
  };
}

const upstreamOk: Deps['fetch'] = async (input) => {
  const url = String(input);
  if (url.endsWith('/api/public/cycles')) return Response.json(CYCLES_UPSTREAM);
  if (url.endsWith('/api/public/grants')) return Response.json(GRANTS_UPSTREAM);
  return new Response('not found', { status: 404 });
};

const upstreamDown: Deps['fetch'] = async () => {
  throw new TypeError('network');
};

const get = (path: string, origin?: string) =>
  new Request(`https://proxy.example${path}`, {
    method: 'GET',
    ...(origin ? { headers: { origin } } : {}),
  });

const TEXANS = 'https://www.houstontexans.com';

// ---------------------------------------------------------------------------

describe('what it forwards, and what it does not', () => {
  it('projects a cycle down to what a marketing page renders', async () => {
    const d = deps({ fetch: upstreamOk });
    const res = await handle(get('/grants/cycles'), ENV, d.deps);
    const body = await res.json<{ cycles: Record<string, unknown>[] }>();
    const cycle = body.cycles[0]!;

    expect(Object.keys(cycle).sort()).toEqual([
      'applyUrl', 'closesAt', 'closesAtDisplay', 'firstStageName', 'id', 'name',
      'programDescription', 'programName', 'requiresReportsFiled', 'shape',
    ]);
    /*
     * The internal form id and the Turnstile site key are in Steward's public
     * payload and have no business in a public cache on another domain. They
     * are absent because the projection is an allowlist, not a delete list --
     * a field added to Steward tomorrow does not appear here by accident.
     */
    expect(JSON.stringify(body)).not.toContain('fd-internal-1');
    expect(JSON.stringify(body)).not.toContain('0xSITEKEY');
    expect(JSON.stringify(body)).not.toContain('guidelinesVersion');
  });

  it('builds the apply URL here rather than in the CMS page', async () => {
    /*
     * The one string that would otherwise be a hardcoded hostname inside a
     * Pocket block -- the hardest place in the estate to find and redeploy
     * when a domain changes. It points at the eligibility screen, which is
     * the applicant's actual first step, not at the form.
     */
    const d = deps({ fetch: upstreamOk });
    const res = await handle(get('/grants/cycles'), ENV, d.deps);
    const body = await res.json<{ cycles: { applyUrl: string }[] }>();
    expect(body.cycles[0]!.applyUrl).toBe('https://apply.example.org/apply/start/cy1');
  });

  it('formats money once, here, and never forwards cents', async () => {
    /*
     * A Pocket block is a display edge, but it is a different codebase with
     * none of the money helpers, and handing it integer cents hands somebody
     * a division by 100 to get wrong in a page that is hard to test.
     */
    const d = deps({ fetch: upstreamOk });
    const res = await handle(get('/grants/awarded'), ENV, d.deps);
    const body = await res.json<{ grants: Record<string, unknown>[] }>();
    expect(body.grants[0]!.amountDisplay).toBe('$25,000');
    expect(JSON.stringify(body)).not.toContain('2500029');
    expect(JSON.stringify(body)).not.toContain('awardedAmountCents');
  });
});

describe('when Steward cannot be reached', () => {
  it('serves the last known good copy rather than a blank panel', async () => {
    const { cache, store } = fakeCache();

    const warm = deps({ fetch: upstreamOk, cache });
    await handle(get('/grants/cycles'), ENV, warm.deps);
    await Promise.all(warm.pending);
    expect(store.size).toBe(2);

    // Simulate the five-minute copy expiring while the day-long one survives.
    for (const k of [...store.keys()]) if (k.includes('/fresh')) store.delete(k);

    const cold = deps({ fetch: upstreamDown, cache });
    const res = await handle(get('/grants/cycles'), ENV, cold.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('stale');
    const body = await res.json<{ cycles: unknown[] }>();
    expect(body.cycles.length).toBe(1);
  });

  it('answers 503 rather than an empty list when it has nothing to serve', async () => {
    /*
     * THE MOST IMPORTANT LINE IN THIS WORKER. An empty list means "no
     * programs are open", which the block renders as "Nothing is open right
     * now" -- a sentence that would send a nonprofit away when in fact the
     * Foundation simply could not be reached. The page has to be able to tell
     * those apart, so a failure is a status code it can branch on.
     */
    const d = deps({ fetch: upstreamDown });
    const res = await handle(get('/grants/cycles'), ENV, d.deps);
    expect(res.status).toBe(503);
    const body = await res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('upstream_unavailable');
    // And it must not be cached, or the outage outlives itself.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('treats a non-200 from Steward the same as no answer at all', async () => {
    // A 500 that returned an empty body would otherwise project to an empty
    // list and read as "nothing is open".
    const d = deps({ fetch: async () => new Response('boom', { status: 500 }) });
    expect((await handle(get('/grants/cycles'), ENV, d.deps)).status).toBe(503);
  });
});

describe('who may read it', () => {
  it('echoes CORS only for the Texans site', async () => {
    const d = deps({ fetch: upstreamOk });
    const allowed = await handle(get('/grants/cycles', TEXANS), ENV, d.deps);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(TEXANS);
    // The response differs by Origin, so a shared cache must not hand one
    // origin's copy to another. This is how a locked endpoint quietly opens.
    expect(allowed.headers.get('vary')).toBe('Origin');
  });

  it('gives a stranger no CORS headers at all', async () => {
    const d = deps({ fetch: upstreamOk });
    const res = await handle(get('/grants/cycles', 'https://evil.example'), ENV, d.deps);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never answers with a wildcard', async () => {
    for (const origin of [TEXANS, 'https://evil.example', undefined]) {
      const d = deps({ fetch: upstreamOk });
      const res = await handle(get('/grants/cycles', origin), ENV, d.deps);
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    }
  });

  it('serves only the two routes it declares, and a health check', async () => {
    const d = deps({ fetch: upstreamOk });
    expect((await handle(get('/grants/secrets'), ENV, d.deps)).status).toBe(404);
    expect((await handle(get('/api/public/cycles'), ENV, d.deps)).status).toBe(404);
    expect((await handle(get('/health'), ENV, d.deps)).status).toBe(200);
  });

  it('refuses anything that is not a GET', async () => {
    const d = deps({ fetch: upstreamOk });
    const post = new Request('https://proxy.example/grants/cycles', { method: 'POST' });
    expect((await handle(post, ENV, d.deps)).status).toBe(405);
  });

  it('answers a preflight, for the day somebody adds a header to the block', async () => {
    const d = deps({ fetch: upstreamOk });
    const pre = new Request('https://proxy.example/grants/cycles', {
      method: 'OPTIONS',
      headers: { origin: TEXANS },
    });
    const res = await handle(pre, ENV, d.deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });
});

describe('caching', () => {
  it('reads the fresh copy without touching Steward', async () => {
    const { cache } = fakeCache();
    const warm = deps({ fetch: upstreamOk, cache });
    await handle(get('/grants/cycles'), ENV, warm.deps);
    await Promise.all(warm.pending);

    let asked = 0;
    const counted: Deps['fetch'] = async (...args) => {
      asked += 1;
      return upstreamOk(...args);
    };
    const second = deps({ fetch: counted, cache });
    const res = await handle(get('/grants/cycles'), ENV, second.deps);
    expect(res.headers.get('x-cache')).toBe('hit');
    expect(asked).toBe(0);
  });

  it('keys the two routes apart', async () => {
    // One cache entry serving both routes would put the grants list under the
    // cycles URL, which is the kind of thing that looks like a Steward bug.
    const { cache, store } = fakeCache();
    const d1 = deps({ fetch: upstreamOk, cache });
    await handle(get('/grants/cycles'), ENV, d1.deps);
    await Promise.all(d1.pending);
    const d2 = deps({ fetch: upstreamOk, cache });
    await handle(get('/grants/awarded'), ENV, d2.deps);
    await Promise.all(d2.pending);
    expect(store.size).toBe(4);
  });
});
