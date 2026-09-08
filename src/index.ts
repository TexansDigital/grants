/**
 * Steward Worker entry point.
 *
 * Phase 0 deliberately exposes almost no surface. What lives here is the thing
 * every later phase depends on: a request context and a global error boundary
 * that logs EVERY failure to error_log and returns a safe body to the client.
 *
 * Routes arrive in Phase 1 (internal shell) and Phase 2 (public application
 * flow). Adding one must not require touching the boundary.
 */

import type { Env, RequestContext } from './types';
import { newRequestId } from './lib/ids';
import { AppError, logError, toErrorResponse } from './lib/errors';
import { nowIso } from './lib/time';

/**
 * Client IP as Cloudflare reports it. Never trust X-Forwarded-For from the
 * edge: a client can set it. CF-Connecting-IP is set by Cloudflare itself.
 */
function clientIp(request: Request): string | null {
  return request.headers.get('CF-Connecting-IP');
}

function buildContext(request: Request): RequestContext {
  const url = new URL(request.url);
  return {
    requestId: newRequestId(),
    // Authentication lands in Phase 1 (Cloudflare Access for staff) and Phase 2
    // (magic link for applicants and grantees). Until then there is no session,
    // and every scoped helper fails closed rather than defaulting to a role.
    session: null,
    ip: clientIp(request),
    userAgent: request.headers.get('User-Agent'),
    route: url.pathname,
    method: request.method,
  };
}

function json(body: unknown, ctx: RequestContext, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': ctx.requestId,
      'cache-control': 'no-store',
      // These matter on a public form that accepts financial documents.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
    },
  });
}

async function route(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/health' && request.method === 'GET') {
    // Confirms the Worker is up AND that the D1 binding actually resolves.
    // A health check that does not touch the database is a health check that
    // stays green while every request fails.
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return json(
      {
        status: row?.ok === 1 ? 'ok' : 'degraded',
        environment: env.ENVIRONMENT,
        time: nowIso(),
      },
      ctx,
      row?.ok === 1 ? 200 : 503,
    );
  }

  throw new AppError('NOT_FOUND', 'That page could not be found.', {
    internalMessage: `no route for ${request.method} ${url.pathname}`,
    severity: 'warn',
  });
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
   * Phase 7 hangs the D1-to-R2 export here. Recommendation on record: that
   * export must exist BEFORE the public form goes live in Phase 2, because
   * Phase 2 is the first moment this system holds real third-party audited
   * financial statements, and D1 Time Travel is disaster recovery, not backup.
   *
   * The boundary is here now so a cron failure is never silent.
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
      // No scheduled jobs registered yet.
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
