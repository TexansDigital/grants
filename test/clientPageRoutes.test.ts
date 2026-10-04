import { describe, it, expect } from 'vitest';
import { routes } from '../src/index';
// Read as TEXT for the same reason api.ts is in clientServerRoutes.test.ts:
// App.tsx is browser code and this suite runs in workerd. parseRoute is not
// exported either -- what is being checked is the set of pathnames it accepts,
// and that set is visible in the source.
import APP_SOURCE from '../web/src/App.tsx?raw';

/**
 * THE OTHER HALF OF THE CLIENT/SERVER SEAM: PAGE paths, not /api/ paths.
 *
 * Static assets are served by Cloudflare's asset router; everything else
 * reaches the Worker, and `not_found_handling` is deliberately left at "none"
 * so the Worker decides which unmatched paths are app routes. That decision is
 * a hand-maintained list in src/index.ts, and the client router is a separate
 * hand-maintained list in App.tsx. Nothing walked between them.
 *
 * Three real bugs lived in that gap, all shipped:
 *
 *   /reporting, /past-grantees and /cycles/:id/coverage parsed fine in the
 *   client and had no server entry. Every one worked by in-app navigation and
 *   returned a raw JSON NOT_FOUND if the address was typed, bookmarked, or
 *   followed from a link -- including the claim notice that points an admin at
 *   /past-grantees.
 *
 * The failure mode is exactly why a green suite missed it: both lists were
 * individually correct, and the only way to see the fault is to compare them.
 */

/** A segment the client treats as a value rather than a fixed word. */
const PARAM = '\u0000param';

/**
 * Every pathname parseRoute accepts, derived from its own conditions.
 *
 * Each branch is `parts.length === N` plus zero or more `parts[i] === 'word'`,
 * which is enough to reconstruct the path: N segments, the named indices fixed
 * and the rest free. Derived rather than listed by hand, because a hand-copied
 * list is a third place to forget a route.
 */
function clientPagePaths(source: string): string[] {
  const start = source.indexOf('function parseRoute(');
  expect(start, 'parseRoute not found in App.tsx').toBeGreaterThan(-1);
  // The function body ends at the first line that is a lone closing brace.
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end === -1 ? source.length : end);

  const found = new Set<string>();
  // No condition in parseRoute contains parentheses, so the first ')' closes
  // the `if (`. If that ever changes this stops finding branches, which the
  // coverage guard below turns into a failure rather than a silent pass.
  for (const m of body.matchAll(/if \(([^)]*)\)/g)) {
    const cond = m[1]!;
    const len = /parts\.length === (\d+)/.exec(cond);
    if (!len) continue;
    const n = Number(len[1]);
    if (n === 0) {
      found.add('/');
      continue;
    }
    const segs: string[] = Array.from({ length: n }, () => PARAM);
    for (const seg of cond.matchAll(/parts\[(\d+)\] === '([^']+)'/g)) {
      const i = Number(seg[1]);
      if (i < n) segs[i] = seg[2]!;
    }
    found.add(`/${segs.join('/')}`);
  }
  return [...found];
}

/**
 * Would the server serve something for this path?
 *
 * Runtime matching, not list equality: a server PARAMETER segment accepts
 * anything, a server literal must be the same word, and a client value can
 * never land on a server literal.
 */
function served(clientPath: string, routePath: string): boolean {
  const c = clientPath.split('/');
  const r = routePath.split('/');
  if (c.length !== r.length) return false;
  return c.every((seg, i) => {
    const routeSeg = r[i]!;
    if (routeSeg.startsWith(':')) return true;
    if (seg === PARAM) return false;
    return seg === routeSeg;
  });
}

describe('every page path the client router accepts is served by the Worker', () => {
  // Page routes only: GET, and outside the API surface.
  const pageRoutes = [
    ...new Set(routes.filter((r) => r.method === 'GET' && !r.path.startsWith('/api/')).map((r) => r.path)),
  ];
  const parsed = clientPagePaths(APP_SOURCE);

  it('finds the client page paths at all, so a silent zero does not pass', () => {
    expect(parsed.length).toBeGreaterThan(20);
  });

  it('serves each one', () => {
    const orphans = parsed.filter((p) => !pageRoutes.some((d) => served(p, d)));
    expect(
      orphans,
      `client page paths the Worker 404s on:\n  ${orphans.map((p) => p.replaceAll(PARAM, ':x')).join('\n  ')}`,
    ).toEqual([]);
  });

  it('pins the three that were missing', () => {
    // Named so that deleting any of them from the route table fails here by
    // name rather than inside the generated list.
    for (const path of ['/reporting', '/past-grantees']) {
      expect(pageRoutes, `${path} must be served`).toContain(path);
    }
    expect(pageRoutes).toContain('/cycles/:id/coverage');
  });
});
