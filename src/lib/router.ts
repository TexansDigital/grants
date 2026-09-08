/**
 * The route table.
 *
 * Replaces a chain of `if (parts.length === 2 && parts[1] === 'x' && method === 'GET')`.
 * That shape was fine for six read-only routes and stops being fine the moment
 * writes exist, for one reason that matters more than tidiness: an `if` chain
 * has no way to tell the difference between "no such path" and "that path, but
 * not that method". Both fall through to the same 404, so a POST to a GET-only
 * route reads to the caller as though the endpoint does not exist — and the
 * next person debugging it goes looking for a routing bug that is not there.
 *
 * A table knows the path matched and the method did not, so it can answer 405
 * with an Allow header, which is both correct and a much better error.
 *
 * Deliberately not a dependency. The matcher is thirty lines, the routes are
 * static, and a router package would be more code than this file.
 */

import type { Env, RequestContext, Role, Session } from '../types';
import { AppError, notFound } from './errors';

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: RequestContext;
  url: URL;
  /** Path parameters, e.g. `:id` in `/api/programs/:id`. */
  params: Readonly<Record<string, string>>;
  /**
   * The verified session.
   *
   * Non-null for every route except those marked `public`. Routes do not check
   * for null; the dispatcher guarantees it, and a route that could be reached
   * without one is a routing bug, not a handler bug.
   */
  session: Session;
}

export type RouteHandler = (rc: RouteContext) => Promise<Response>;

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Pattern segments; `:name` captures. */
  path: string;
  /**
   * Roles permitted to reach the handler.
   *
   * Required, with no default. A route that forgets to declare this is a
   * compile error rather than a route that quietly admits everyone — the
   * failure mode of a permissive default is not one this system can afford.
   */
  roles: readonly Role[];
  handler: RouteHandler;
  /** Public routes run with no session and no Access check. */
  public?: true;
}

/** Every staff role that may change configuration. Admin only, deliberately. */
export const ADMIN_ONLY: readonly Role[] = ['admin'];
/**
 * Staff who work inside the application.
 *
 * Executives are deliberately NOT here. CLAUDE.md's access table says
 * "Executive | Nothing in the app | Nothing. Receives PDF and CSV exports",
 * and the surrounding text is blunter still: "Executives never log in, so the
 * export is the product for them and must stand alone."
 *
 * The constant was called ANY_STAFF and included them, which let an executive
 * read every program, cycle and form definition including total budgets. No
 * applicant data leaked -- staffApplicationScope returns `1 = 0` for the role --
 * so this was the code and the constitution disagreeing rather than a breach.
 * The constitution wins. Renamed so the name stops inviting the mistake.
 */
export const STAFF_READ: readonly Role[] = ['admin', 'reviewer'];

interface Match {
  route: Route;
  params: Record<string, string>;
}

function segments(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

/**
 * Match one route pattern against one path.
 *
 * Returns null on a length or literal mismatch. A `:name` segment captures any
 * single non-empty segment — captures never span a `/`, so `/forms/a/b` does
 * not match `/forms/:id` and gets an honest 404.
 */
function matchPath(pattern: string[], path: string[]): Record<string, string> | null {
  if (pattern.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const actual = path[i]!;
    if (p.startsWith(':')) {
      params[p.slice(1)] = actual;
      continue;
    }
    if (p !== actual) return null;
  }
  return params;
}

export interface Resolution {
  kind: 'matched' | 'method_not_allowed' | 'not_found';
  match?: Match;
  /** For 405: the methods this path DOES accept. */
  allow?: string[];
}

/**
 * Resolve a request against the table.
 *
 * Path first, then method — that ordering is what makes a real 405 possible.
 */
export function resolve(routes: readonly Route[], method: string, pathname: string): Resolution {
  const path = segments(pathname);
  const pathMatches: Route[] = [];

  for (const route of routes) {
    const params = matchPath(segments(route.path), path);
    if (!params) continue;
    pathMatches.push(route);
    if (route.method === method) return { kind: 'matched', match: { route, params } };
  }

  if (pathMatches.length > 0) {
    const allow: string[] = [...new Set(pathMatches.map((r) => r.method as string))].sort();
    // HEAD is served by GET. Callers that probe with HEAD should be told so.
    if (allow.includes('GET')) allow.push('HEAD');
    return { kind: 'method_not_allowed', allow };
  }
  return { kind: 'not_found' };
}

/**
 * Authorize a session against a route.
 *
 * 403, not 404. The 404-as-not-an-oracle rule exists for EXTERNAL data, where
 * confirming a record exists tells an attacker something about another
 * organization. It does not apply here: everyone reaching this point has
 * already been authenticated by Cloudflare Access and exists in the users
 * table, and the routes themselves are not secret. Telling a reviewer plainly
 * that a route is admin-only is more useful than a 404 that sends them looking
 * for a bug.
 */
export function authorizeRoute(route: Route, session: Session): void {
  if (route.roles.includes(session.role)) return;
  throw new AppError('FORBIDDEN', 'You do not have access to this.', {
    internalMessage: `role ${session.role} is not permitted on ${route.method} ${route.path}`,
    severity: 'warn',
    context: { route: route.path, method: route.method, role: session.role },
  });
}

/** Thrown by the dispatcher for a path that exists at another method. */
export function methodNotAllowed(allow: string[]): AppError {
  return new AppError('METHOD_NOT_ALLOWED', 'That address does not accept this kind of request.', {
    internalMessage: `method not allowed; accepts ${allow.join(', ')}`,
    severity: 'warn',
    context: { allow },
  });
}

export { notFound };
