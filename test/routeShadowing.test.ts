import { describe, it, expect } from 'vitest';
import { routes } from '../src/index';
import { resolve } from '../src/lib/router';

/**
 * A ROUTE THAT CAN NEVER BE REACHED.
 *
 * `resolve` walks the table in declaration order and takes the first path that
 * matches, with no preference for a literal segment over a parameter. So
 * declaring `GET /api/awards/:id` ABOVE `GET /api/awards/search` does not
 * produce an error, a warning, or a failing unit test. It produces an award
 * page handler that receives the literal string "search" as an award id,
 * answers 404, and quietly breaks the one screen that calls it -- in that
 * case the award picker an admin uses to connect a past grantee to their
 * grant, which is the only path by which any of the thirteen 2025 grantees
 * reaches their report.
 *
 * This was written because exactly that was about to ship. The route was
 * added near the top of the table, where the surrounding routes were, and
 * `/api/awards/search` sat six hundred lines below it.
 *
 * Every endpoint's own tests still pass under this fault, because they call
 * the handler or they fetch a path that happens to be declared first. Only
 * something that walks the table as a whole can see it, so that is what this
 * does: for every route, ask the router for the most specific path that route
 * accepts, and require the answer to be that route.
 */

/** A concrete path for a route pattern, with a plausible value per parameter. */
function concretePath(pattern: string): string {
  return pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '01931f7a-0000-7000-8000-000000000001' : seg))
    .join('/');
}

describe('the route table', () => {
  it('declares no route that another route shadows', () => {
    const shadowed: string[] = [];

    for (const route of routes) {
      /*
       * A route with a parameter cannot be shadowed by its own literal
       * siblings -- a uuid is not the word "search" -- so the question is only
       * ever asked of the fully-literal path each route accepts. For a
       * parameterised route that path contains a uuid, which no literal route
       * matches, and the check is trivially satisfied. For a literal route it
       * is the route's own path, and that is the case that bites.
       */
      const path = concretePath(route.path);
      const r = resolve(routes, route.method, path);
      if (r.kind !== 'matched') {
        // A route whose own path does not resolve at its own method is a
        // worse fault than shadowing, and belongs in the same list.
        shadowed.push(`${route.method} ${route.path} -> ${r.kind}`);
        continue;
      }
      if (r.match!.route !== route) {
        shadowed.push(
          `${route.method} ${route.path} is unreachable: ` +
            `${path} is taken by ${r.match!.route.method} ${r.match!.route.path}, declared earlier`,
        );
      }
    }

    expect(shadowed).toEqual([]);
  });

  it('routes /api/awards/search to the award picker, not to the award page', () => {
    /*
     * Named explicitly as well as covered by the sweep above, because this is
     * the pair that nearly shipped and because the failure is silent: the
     * picker returns an empty list, the Connect button stays greyed out, and
     * the screen gives no reason.
     */
    const r = resolve(routes, 'GET', '/api/awards/search');
    expect(r.kind).toBe('matched');
    expect(r.match!.route.path).toBe('/api/awards/search');
  });
});
