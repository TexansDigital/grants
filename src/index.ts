/**
 * Steward Worker entry point.
 *
 * Two things live here and nothing else: the request context with the global
 * error boundary, and the router.
 *
 * The staff API is a JSON contract, not a rendering surface. The form
 * definition endpoint returns exactly what the applicant form will later
 * consume, so the Phase 2 public flow reuses this endpoint rather than
 * replacing it -- and the field validation and conditional-visibility rules
 * stay in src/lib, imported by both sides, never reimplemented in a client.
 */

import type { Env, RequestContext, Session } from './types';
import { newRequestId } from './lib/ids';
import { AppError, logError, notFound, toErrorResponse } from './lib/errors';
import { nowIso, formatInZone } from './lib/time';
import { securityHeaders, htmlHeaders } from './lib/httpHeaders';
import { requireStaffSession } from './lib/auth';
import { loadFormDefinition } from './lib/loadForm';

/**
 * Client IP as Cloudflare reports it. X-Forwarded-For is never trusted: a
 * client can set it. CF-Connecting-IP is set by Cloudflare itself.
 */
function clientIp(request: Request): string | null {
  return request.headers.get('CF-Connecting-IP');
}

function buildContext(request: Request): RequestContext {
  const url = new URL(request.url);
  return {
    requestId: newRequestId(),
    // Populated by the route once Access has been verified. It starts null so
    // that a handler which forgets to authenticate has no session to use.
    session: null,
    ip: clientIp(request),
    userAgent: request.headers.get('User-Agent'),
    route: url.pathname,
    method: request.method,
  };
}

function json(body: unknown, ctx: RequestContext, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: securityHeaders(ctx.requestId) });
}

/** Match `/api/forms/:id` and friends without pulling in a router dependency. */
function segments(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

/**
 * The paths the single-page app owns.
 *
 * An explicit list, not a catch-all. A catch-all would answer 200 to every
 * mistyped URL and to every scanner, which makes a genuine 404 impossible to
 * see in the logs and makes the app look like it has pages it does not have.
 */
function isAppRoute(parts: string[]): boolean {
  if (parts.length === 0) return true; // the shell itself
  if (parts.length === 2 && parts[0] === 'forms') return true; // /forms/:id
  return false;
}

/**
 * Serve the app shell.
 *
 * Static files (the hashed JS and CSS) are served by Cloudflare's asset router
 * before this Worker is invoked. This handles the deep links -- /forms/:id --
 * which match no file on disk, by returning index.html so the client router can
 * take over. Headers are re-applied here rather than inherited, so the shell
 * carries the same policy as every API response.
 */
async function serveAppShell(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (!env.ASSETS) throw notFound('page');
  const shell = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), { method: 'GET' }));
  if (!shell.ok) throw notFound('page');
  return new Response(shell.body, { status: 200, headers: htmlHeaders(ctx.requestId) });
}

async function route(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  const parts = segments(url.pathname);
  const method = request.method;

  // ---- public -------------------------------------------------------------
  if (parts.length === 1 && parts[0] === 'health' && method === 'GET') {
    // Touches D1 on purpose: a health check that does not exercise its
    // dependencies stays green while every real request fails.
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    const healthy = row?.ok === 1;
    return json(
      { status: healthy ? 'ok' : 'degraded', environment: env.ENVIRONMENT, time: nowIso() },
      ctx,
      healthy ? 200 : 503,
    );
  }

  if (parts[0] !== 'api') {
    if (method === 'GET' && isAppRoute(parts)) return await serveAppShell(request, env, ctx);
    throw notFound('page');
  }

  // ---- everything below requires a verified Access session ----------------
  const session: Session = await requireStaffSession(request, env, ctx);
  ctx.session = session;

  // GET /api/session -- who the caller is. The UI uses this to decide what to
  // render, but it is a convenience: every endpoint checks for itself.
  if (parts.length === 2 && parts[1] === 'session' && method === 'GET') {
    return json({ user: { email: session.email, role: session.role } }, ctx);
  }

  // GET /api/programs
  if (parts.length === 2 && parts[1] === 'programs' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, name, slug, status, fiscal_year, compliance_policy
         FROM programs WHERE deleted_at IS NULL ORDER BY name`,
    ).all<Record<string, unknown>>();
    return json({ programs: results ?? [] }, ctx);
  }

  // GET /api/cycles?program_id=...
  if (parts.length === 2 && parts[1] === 'cycles' && method === 'GET') {
    const programId = url.searchParams.get('program_id');
    const stmt = programId
      ? env.DB.prepare(
          `SELECT id, program_id, name, opens_at, closes_at, status, draft_grace_hours
             FROM cycles WHERE program_id = ? AND deleted_at IS NULL ORDER BY opens_at DESC`,
        ).bind(programId)
      : env.DB.prepare(
          `SELECT id, program_id, name, opens_at, closes_at, status, draft_grace_hours
             FROM cycles WHERE deleted_at IS NULL ORDER BY opens_at DESC`,
        );
    const { results } = await stmt.all<Record<string, unknown>>();
    return json(
      {
        cycles: (results ?? []).map((c) => ({
          ...c,
          // Deadlines are announced in Central time. Storage stays UTC; the
          // display string is computed once, here, so every surface agrees.
          closes_at_display: formatInZone(String(c.closes_at), env.DISPLAY_TIMEZONE),
          opens_at_display: formatInZone(String(c.opens_at), env.DISPLAY_TIMEZONE),
        })),
      },
      ctx,
    );
  }

  // GET /api/forms?program_id=... -- the definitions this deployment has.
  //
  // Metadata only: what forms exist, which program and stage they belong to,
  // and their version and publication state. No sections, no fields, and
  // nothing an applicant ever entered.
  if (parts.length === 2 && parts[1] === 'forms' && method === 'GET') {
    const programId = url.searchParams.get('program_id');
    const sql = `SELECT f.id, f.program_id, f.form_key, f.stage_id, f.kind, f.name,
                        f.version, f.status, f.published_at,
                        p.name AS program_name, s.name AS stage_name
                   FROM form_definitions f
                   JOIN programs p ON p.id = f.program_id
              LEFT JOIN program_stages s ON s.id = f.stage_id
                  WHERE f.deleted_at IS NULL AND p.deleted_at IS NULL
                    ${programId ? 'AND f.program_id = ?' : ''}
                  ORDER BY p.name, s.sort_order, f.form_key, f.version DESC`;
    const stmt = programId ? env.DB.prepare(sql).bind(programId) : env.DB.prepare(sql);
    const { results } = await stmt.all<Record<string, unknown>>();
    return json({ forms: results ?? [] }, ctx);
  }

  // GET /api/forms/:id -- THE CONTRACT.
  //
  // This is what the Phase 2 applicant form consumes. It returns the definition
  // exactly as loadFormDefinition assembles it: sections and fields in order,
  // with parsed options, validation rules, conditional wiring and promotion
  // targets. No answers, no applicant data, no internal notes.
  if (parts.length === 3 && parts[1] === 'forms' && method === 'GET') {
    const definition = await loadFormDefinition(env.DB, parts[2]!);
    return json({ form: definition }, ctx);
  }

  throw notFound('endpoint');
}

export default {
  async fetch(request: Request, env: Env, _executionCtx: ExecutionContext): Promise<Response> {
    const ctx = buildContext(request);
    try {
      return await route(request, env, ctx);
    } catch (err) {
      return await toErrorResponse(err, env, ctx);
    }
  },

  /**
   * Scheduled work.
   *
   * Phase 7 hangs the D1-to-R2 export here. Standing recommendation: that
   * export must exist BEFORE the public form goes live, because that is the
   * first moment this system holds real third-party audited financial
   * statements, and D1 Time Travel is disaster recovery, not backup.
   */
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const ctx: RequestContext = {
      requestId: newRequestId(),
      session: null,
      ip: null,
      userAgent: null,
      route: `cron:${event.cron}`,
      method: 'SCHEDULED',
    };
    try {
      return;
    } catch (err) {
      await logError(env, ctx, {
        severity: 'error',
        code: 'CRON_FAILED',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? (err.stack ?? null) : null,
        context: { cron: event.cron },
      });
      throw err;
    }
  },
};

// Re-exported so tests can assert the exact error shape the boundary produces.
export { AppError };
