/**
 * The Houston Texans site's read-only window onto Steward.
 *
 * WHY THIS EXISTS RATHER THAN AN IFRAME. `houstontexans.com` and
 * `houstontexansfoundation.org` are different registrable domains, so an
 * iframe of Steward on a Pocket page is third-party and its session cookie is
 * a third-party cookie -- which Safari blocks outright and Chrome is removing.
 * Anything behind sign-in cannot work there, and half-working is worse than
 * not offering it. So the Pocket page renders native blocks in the Texans
 * design system, reads public data through here, and links out for anything
 * that needs a session.
 *
 * WHY A PROXY RATHER THAN FETCHING STEWARD DIRECTLY. This Worker calls Steward
 * server-side, where CORS does not apply, so Steward needs no allow-list, no
 * new header, and no knowledge that houstontexans.com exists. It also gives
 * the marketing page a cache and a fallback that Steward should not have to
 * care about.
 *
 * WHAT IT WILL NOT DO, and each of these is a decision:
 *
 *   - It forwards nothing but the fields the blocks render. Steward's public
 *     payload can grow without changing what sits in a public cache, and a
 *     block cannot come to depend on a field nobody meant to publish.
 *   - It sends no cookies, reads no headers from the caller, and has no
 *     secrets. There is nothing here to steal.
 *   - It never answers "nothing is open" when it simply could not reach
 *     Steward. Those are different sentences to a nonprofit deciding whether
 *     to spend an evening on an application, and conflating them is the one
 *     way this Worker could do real harm.
 */

/*
 * `caches.default` is a Cloudflare extension and is not on the standard
 * `CacheStorage` type, so it is declared rather than cast at the call site. A
 * cast there would have to be repeated three times and would silently accept
 * a typo in the method name.
 */
declare global {
  interface CacheStorage {
    readonly default: Cache;
  }
}

export interface Env {
  STEWARD_ORIGIN: string;
  ALLOWED_ORIGIN: string;
  CACHE_SECONDS: string;
  FALLBACK_SECONDS: string;
}

/** Public, read-only, and the whole surface. */
const ROUTES = {
  '/grants/cycles': '/api/public/cycles',
  '/grants/awarded': '/api/public/grants',
} as const;

type RoutePath = keyof typeof ROUTES;

const isRoute = (p: string): p is RoutePath => p in ROUTES;

const num = (value: string | undefined, fallback: number): number => {
  const n = Number((value ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * CORS, locked to one origin and echoed only when it matches.
 *
 * NOT `*`. A wildcard would work identically for the browser and would also
 * let any page anywhere embed the Foundation's grant data as if it were their
 * own -- which costs nothing technically and is exactly the kind of thing
 * nobody notices until it turns up somewhere embarrassing.
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  /*
   * `Vary: Origin` ON BOTH BRANCHES, and the reason is the opposite of the
   * obvious one.
   *
   * This header used to sit inside the allowed-origin return, which is the
   * branch where it matters least: that response carries an ACAO naming
   * houstontexans.com, so a shared cache handing it to some other site gives
   * that site nothing it can read.
   *
   * The direction that actually hurts is the other one. A response to any
   * other origin has NO ACAO, and without Vary a shared cache -- a corporate
   * proxy, an ISP, anything between the visitor and here -- may store it under
   * the bare URL and later serve it to www.houstontexans.com. The browser
   * then blocks the block's own fetch and the module renders nothing, for some
   * visitors, intermittently, with no error anywhere anyone would look.
   *
   * Found by running the three curls against the deployed Worker and noticing
   * that `vary` was present on one response and absent on the next.
   */
  if (origin !== env.ALLOWED_ORIGIN) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '86400',
  };
}

function json(body: unknown, status: number, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * A cycle, as a marketing page needs it.
 *
 * `applyUrl` is built HERE and not in the block. It is the one piece of this
 * that would otherwise be a hardcoded hostname inside a CMS page -- the sort
 * of string nobody can find when a domain changes, in the one place that is
 * hardest to redeploy.
 *
 * `closesAt` travels as well as `closesAtDisplay` so the block can hide a
 * cycle that closed while this response sat in the cache. Five minutes is
 * nothing against a deadline months out and everything on the last afternoon.
 */
interface CycleOut {
  id: string;
  name: string;
  programName: string;
  programDescription: string | null;
  closesAt: string;
  closesAtDisplay: string;
  firstStageName: string | null;
  requiresReportsFiled: boolean;
  shape: { questions: number; writtenAnswers: number; documents: number } | null;
  applyUrl: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function projectCycles(payload: unknown, stewardOrigin: string): { cycles: CycleOut[] } {
  const raw = (payload as { cycles?: unknown })?.cycles;
  const list = Array.isArray(raw) ? raw : [];
  const cycles = list
    .map((c) => c as Record<string, unknown>)
    .filter((c) => str(c.id) !== '' && str(c.closesAt) !== '')
    .map((c) => {
      const shape = c.shape as Record<string, unknown> | null | undefined;
      return {
        id: str(c.id),
        name: str(c.name),
        programName: str(c.programName),
        programDescription: strOrNull(c.programDescription),
        closesAt: str(c.closesAt),
        closesAtDisplay: str(c.closesAtDisplay),
        firstStageName: strOrNull(c.firstStageName),
        requiresReportsFiled: c.requiresReportsFiled === true,
        shape: shape
          ? {
              questions: int(shape.questions),
              writtenAnswers: int(shape.writtenAnswers),
              documents: int(shape.documents),
            }
          : null,
        // The applicant's first step is the eligibility screen, not the form.
        applyUrl: `${stewardOrigin}/apply/start/${encodeURIComponent(str(c.id))}`,
      };
    });
  return { cycles };
}

interface GrantOut {
  organizationName: string;
  programName: string;
  projectTitle: string | null;
  awardedYear: string;
  fiscalYear: number | null;
  /** Formatted here. See the note below. */
  amountDisplay: string;
}

/**
 * Money is formatted here and the cents are NOT forwarded.
 *
 * Steward's rule is that money is integer cents everywhere and is formatted
 * once, at the display edge. A Pocket block IS a display edge, but it is a
 * different codebase with none of the helpers, and handing it raw cents is
 * handing somebody a division by 100 to get wrong in a page that is hard to
 * test. One formatted string, and nothing to divide.
 */
function projectGrants(payload: unknown): { grants: GrantOut[] } {
  const raw = (payload as { grants?: unknown })?.grants;
  const list = Array.isArray(raw) ? raw : [];
  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
  const grants = list
    .map((g) => g as Record<string, unknown>)
    .filter((g) => str(g.organizationName) !== '')
    .map((g) => {
      const cents = g.awardedAmountCents;
      const safe = typeof cents === 'number' && Number.isFinite(cents) && cents >= 0 ? cents : 0;
      return {
        organizationName: str(g.organizationName),
        programName: str(g.programName),
        projectTitle: strOrNull(g.projectTitle),
        awardedYear: str(g.awardedYear),
        fiscalYear: typeof g.fiscalYear === 'number' ? g.fiscalYear : null,
        amountDisplay: money.format(safe / 100),
      };
    });
  return { grants };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * TWO CACHE ENTRIES, and the second is the point.
 *
 * `fresh` is the five-minute copy everything normally reads. `backup` is a
 * last-known-good copy kept for a day, read ONLY when Steward cannot be
 * reached at all. A blip in the grants platform should cost the Foundation's
 * page a slightly stale deadline, not a blank panel on houstontexans.com.
 *
 * Cache keys are synthetic URLs on a reserved host. `caches.default` keys on
 * the whole request URL, so a real one would collide with anything else this
 * account caches for that address.
 */
const key = (kind: 'fresh' | 'backup', path: string): Request =>
  new Request(`https://cache.invalid/${kind}${path}`, { method: 'GET' });

// ---------------------------------------------------------------------------

/**
 * What the handler needs from the outside world.
 *
 * INJECTED, because the whole value of this Worker is what it does when
 * Steward cannot be reached, and `wrangler dev` cannot exercise that: its
 * local `caches.default` persists to disk across restarts and does not honour
 * max-age, so a stale-copy path tested locally would be testing nothing. A
 * promise about failure behaviour that cannot be tested is not a promise.
 *
 * `export default` below supplies the real ones and is a single line, so
 * nothing meaningful lives outside what the tests can reach.
 */
export interface Deps {
  fetch: typeof fetch;
  cache: Pick<Cache, 'match' | 'put'>;
  /** Cache writes are fire-and-forget in production, awaited in a test. */
  waitUntil: (p: Promise<unknown>) => void;
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      // A plain GET with no custom headers is a "simple request" and never
      // preflights, so this is answered for the day somebody adds a header to
      // the block and cannot work out why it stopped.
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    }

    if (url.pathname === '/health') {
      /*
       * Exists because of one recurring debugging session: "the block shows
       * nothing" almost always means the page is fetching a URL this Worker
       * does not serve. Opening this in a browser answers that in a second,
       * and says whether Steward itself is reachable.
       */
      const upstream = await deps
        .fetch(`${env.STEWARD_ORIGIN}/health`, { method: 'GET' })
        .then((r) => r.status)
        .catch(() => 0);
      return json(
        {
          ok: true,
          worker: 'htx-grants-proxy',
          routes: Object.keys(ROUTES),
          allowedOrigin: env.ALLOWED_ORIGIN,
          stewardOrigin: env.STEWARD_ORIGIN,
          stewardStatus: upstream,
        },
        200,
        { ...cors, 'cache-control': 'no-store' },
      );
    }

    if (!isRoute(url.pathname)) {
      return json({ ok: false, error: 'not_found' }, 404, cors);
    }

    const cached = await deps.cache.match(key('fresh', url.pathname));
    if (cached) {
      const body = await cached.text();
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', ...cors, 'x-cache': 'hit' },
      });
    }

    const ttl = num(env.CACHE_SECONDS, 300);
    const fallbackTtl = num(env.FALLBACK_SECONDS, 86_400);

    let projected: unknown = null;
    try {
      const res = await deps.fetch(`${env.STEWARD_ORIGIN}${ROUTES[url.pathname]}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (res.ok) {
        const payload = (await res.json()) as unknown;
        projected =
          url.pathname === '/grants/cycles'
            ? projectCycles(payload, env.STEWARD_ORIGIN)
            : projectGrants(payload);
      }
    } catch {
      // Falls through to the backup copy below. Deliberately swallowed: there
      // is nobody to report it to on a marketing page, and the distinction
      // that matters to the reader is "stale" versus "cannot say", which the
      // response carries.
      projected = null;
    }

    if (projected !== null) {
      const body = JSON.stringify({ ok: true, ...(projected as object) });
      deps.waitUntil(
        deps.cache.put(
          key('fresh', url.pathname),
          new Response(body, {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': `max-age=${ttl}`,
            },
          }),
        ),
      );
      deps.waitUntil(
        deps.cache.put(
          key('backup', url.pathname),
          new Response(body, {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': `max-age=${fallbackTtl}`,
            },
          }),
        ),
      );
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', ...cors, 'x-cache': 'miss' },
      });
    }

    const backup = await deps.cache.match(key('backup', url.pathname));
    if (backup) {
      return new Response(await backup.text(), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...cors,
          'x-cache': 'stale',
        },
      });
    }

    /*
     * NOT A 200 WITH AN EMPTY LIST, and this is the most important line here.
     *
     * An empty list means "no programs are open", which the block renders as
     * "Nothing is open right now" -- a sentence that would send a nonprofit
     * away when in fact the Foundation simply could not be reached. Those are
     * different facts and the page must be able to tell them apart, so the
     * failure is a status code the block can branch on.
     */
    return json({ ok: false, error: 'upstream_unavailable' }, 503, {
      ...cors,
      'cache-control': 'no-store',
    });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, {
      fetch: (...args) => fetch(...args),
      cache: caches.default,
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
};
