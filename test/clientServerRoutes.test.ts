import { describe, it, expect } from 'vitest';
import { routes } from '../src/index';
// Imported as TEXT, not as a module: web/src/api.ts is browser code and this
// test runs in workerd. We are checking the URLs it BUILDS, which are visible
// in the source, so the source is the right thing to read.
import API_SOURCE from '../web/src/api.ts?raw';

/**
 * THE SEAM BETWEEN THE CLIENT'S URLS AND THE SERVER'S ROUTE TABLE.
 *
 * Both sides of this seam have always been individually correct and
 * individually tested. Nothing walked between them, and a real bug lived there
 * for the life of the project:
 *
 *   api.ts built `/api/cycles/${id}/${next}` where next is a STATUS
 *   ('open' | 'closed'), while the routes are VERBS (/open, /close).
 *   'open' matched by coincidence. 'closed' produced a 404, so closing a
 *   cycle -- the only way to take a public application form down -- silently
 *   never worked, and the UI said "That page could not be found."
 *
 * So this does not assert one URL. It extracts every /api/ path the client
 * constructs and requires each to match a declared route, which makes the
 * whole class of drift a build failure rather than something a human finds in
 * a console at deploy time.
 */

/** A path the client builds, with interpolations replaced by a marker. */
const PARAM = '\u0000param';

/**
 * Read a template literal starting at the opening backtick, replacing each
 * `${...}` with one marker.
 *
 * Written as a scanner rather than a regex because interpolations nest, and
 * they nest with backticks inside them: `/api/reports${query ? `?${query}` :
 * ''}` defeats any `[^`]*` pattern, which silently truncates the path and
 * produces a phantom orphan. A test that reports faults it invented is worse
 * than no test, so this counts braces properly.
 *
 * Returns null if the literal does not terminate, so a parse failure is
 * visible rather than becoming a half-read path.
 */
function readTemplate(source: string, open: number): { text: string; end: number } | null {
  let out = '';
  let i = open + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') return { text: out, end: i };
    if (ch === '$' && source[i + 1] === '{') {
      // Skip to the matching brace, counting nested braces and nested
      // template literals along the way.
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const c = source[i]!;
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '`') {
          const nested = readTemplate(source, i);
          if (!nested) return null;
          i = nested.end;
        }
        i++;
      }
      if (depth > 0) return null;
      out += PARAM;
      continue;
    }
    out += ch;
    i++;
  }
  return null;
}

function clientPaths(source: string): string[] {
  const found = new Set<string>();
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '`') continue;
    const lit = readTemplate(source, i);
    if (!lit) continue;
    i = lit.end;
    if (!lit.text.startsWith('/api/')) continue;

    let path = lit.text.split('?')[0]!;
    // An interpolation glued to the end of a segment with no separating slash
    // is a query string or a suffix, never a path segment of its own. Routing
    // matches the pathname, so drop it.
    if (path.endsWith(PARAM) && !path.endsWith(`/${PARAM}`)) {
      path = path.slice(0, -PARAM.length);
    }
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    found.add(path);
  }
  return [...found];
}

/**
 * Does a client path match this route?
 *
 * The rule that catches the cycle bug: a client interpolation may line up with
 * a route PARAMETER, never with a literal segment. Interpolating into a
 * position the server treats as fixed is the mistake, whatever value happens
 * to be substituted at runtime.
 */
function matches(clientPath: string, routePath: string): boolean {
  const c = clientPath.split('/');
  const r = routePath.split('/');
  if (c.length !== r.length) return false;
  return c.every((seg, i) => {
    const routeSeg = r[i]!;
    if (routeSeg.startsWith(':')) return true; // a param accepts anything
    if (seg === PARAM) return false; // interpolating into a fixed segment
    return seg === routeSeg;
  });
}

describe('every URL the client builds exists on the server', () => {
  const declared = [...new Set(routes.map((r) => r.path))];
  const built = clientPaths(API_SOURCE);

  it('finds the client URLs at all, so a silent zero does not pass', () => {
    // If the extraction breaks, every assertion below becomes vacuously true.
    // This is the guard that keeps the suite honest about its own coverage.
    expect(built.length).toBeGreaterThan(30);
  });

  it('matches each one to a declared route', () => {
    const orphans = built.filter((p) => !declared.some((d) => matches(p, d)));
    expect(orphans, `client paths with no server route:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  it('rejects a path that interpolates into a fixed segment', () => {
    // The original bug, pinned as a case so the rule cannot be loosened later
    // without someone noticing what it was there to catch.
    expect(matches(`/api/cycles/${PARAM}/${PARAM}`, '/api/cycles/:id/close')).toBe(false);
    expect(matches(`/api/cycles/${PARAM}/close`, '/api/cycles/:id/close')).toBe(true);
    expect(matches(`/api/cycles/${PARAM}/open`, '/api/cycles/:id/open')).toBe(true);
  });
});
