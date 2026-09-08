/**
 * Steward Worker entry point.
 *
 * Three things live here and nothing else: the request context with the global
 * error boundary, the route TABLE, and the dispatcher that walks it.
 *
 * The staff API is a JSON contract, not a rendering surface. The form
 * definition endpoint returns exactly what the applicant form consumes, so the
 * Phase 2 public flow reuses this endpoint rather than replacing it -- and the
 * field validation and conditional-visibility rules stay in src/lib, imported
 * by both sides, never reimplemented in a client.
 *
 * Handlers are thin on purpose. Anything that writes lives in src/lib/config.ts
 * with its audit row, because a mutation and its audit row must go out in one
 * batch and that is not a routing concern.
 */

import type { Env, RequestContext, Session } from './types';
import { newRequestId } from './lib/ids';
import { AppError, logError, notFound, toErrorResponse, validationFailed } from './lib/errors';
import { nowIso, formatInZone } from './lib/time';
import { securityHeaders, htmlHeaders } from './lib/httpHeaders';
import { requireStaffSession } from './lib/auth';
import { loadFormDefinition } from './lib/loadForm';
import {
  getApplicationDetailForStaff,
  listApplicationsForReviewer,
  listApplicationsForStaff,
  organizationHistoryForStaff,
} from './lib/scope';
import { searchApplications } from './lib/search';
import {
  ADMIN_ONLY,
  STAFF_READ,
  authorizeRoute,
  methodNotAllowed,
  resolve,
  type Route,
  type RouteContext,
} from './lib/router';
import {
  createCycle,
  createProgram,
  createStage,
  deleteProgram,
  readJsonBody,
  setCycleStatus,
  updateCycle,
  updateProgram,
} from './lib/config';

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
    // Populated by the dispatcher once Access has been verified. It starts null
    // so a handler reached without authentication has no session to use.
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

/**
 * Serve the app shell.
 *
 * Static files (the hashed JS and CSS) are served by Cloudflare's asset router
 * before this Worker is invoked. This handles the deep links, which match no
 * file on disk, by returning index.html so the client router can take over.
 * Headers are re-applied here rather than inherited, so the shell carries the
 * same policy as every API response.
 *
 * Both spellings are tried. The asset router canonicalises /index.html to / with
 * a 307 for ordinary browser requests; it does not do that through the binding
 * today, but a change there would silently break every deep link while the root
 * still worked -- the kind of breakage nobody notices until an applicant follows
 * a link from an email.
 */
async function serveAppShell({ request, env, ctx }: RouteContext): Promise<Response> {
  if (!env.ASSETS) throw notFound('page');
  for (const path of ['/index.html', '/']) {
    const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: 'GET' }));
    if (res.ok) {
      return new Response(res.body, { status: 200, headers: htmlHeaders(ctx.requestId) });
    }
  }
  throw notFound('page');
}

// ---------------------------------------------------------------------------
// The route table
//
// `roles` is required on every entry. A route that forgets it is a compile
// error rather than a route that quietly admits everyone.
// ---------------------------------------------------------------------------

const routes: readonly Route[] = [
  // ---- public --------------------------------------------------------------
  {
    method: 'GET',
    path: '/health',
    roles: [],
    public: true,
    handler: async ({ env, ctx }) => {
      // Touches D1 on purpose: a health check that does not exercise its
      // dependencies stays green while every real request fails.
      const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
      const healthy = row?.ok === 1;
      return json(
        { status: healthy ? 'ok' : 'degraded', environment: env.ENVIRONMENT, time: nowIso() },
        ctx,
        healthy ? 200 : 503,
      );
    },
  },
  // The single-page app's own paths. Listed explicitly rather than matched by a
  // catch-all, so a mistyped URL still 404s and a real 404 stays visible in the
  // logs.
  { method: 'GET', path: '/', roles: [], public: true, handler: serveAppShell },
  { method: 'GET', path: '/forms/:id', roles: [], public: true, handler: serveAppShell },

  // ---- session -------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/session',
    roles: STAFF_READ,
    handler: async ({ ctx, session }) =>
      json({ user: { email: session.email, role: session.role } }, ctx),
  },

  // ---- programs ------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/programs',
    roles: STAFF_READ,
    handler: async ({ env, ctx }) => {
      const { results } = await env.DB.prepare(
        `SELECT id, name, slug, status, fiscal_year, compliance_policy,
                total_budget_cents, max_applications_per_cycle
           FROM programs WHERE deleted_at IS NULL ORDER BY name`,
      ).all<Record<string, unknown>>();
      return json({ programs: results ?? [] }, ctx);
    },
  },
  {
    method: 'POST',
    path: '/api/programs',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx }) =>
      json({ program: await createProgram({ db: env.DB, ctx }, await readJsonBody(request)) }, ctx, 201),
  },
  {
    method: 'PATCH',
    path: '/api/programs/:id',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params }) =>
      json(
        { program: await updateProgram({ db: env.DB, ctx }, params.id!, await readJsonBody(request)) },
        ctx,
      ),
  },
  {
    method: 'DELETE',
    path: '/api/programs/:id',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params }) => {
      await deleteProgram({ db: env.DB, ctx }, params.id!);
      return json({ archived: true }, ctx);
    },
  },

  // ---- stages --------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/programs/:id/stages',
    roles: STAFF_READ,
    handler: async ({ env, ctx, params }) => {
      const { results } = await env.DB.prepare(
        `SELECT id, program_id, stage_key, name, sort_order, gate_on_prior_decision
           FROM program_stages
          WHERE program_id = ? AND deleted_at IS NULL
          ORDER BY sort_order, name`,
      )
        .bind(params.id!)
        .all<Record<string, unknown>>();
      return json({ stages: results ?? [] }, ctx);
    },
  },
  {
    method: 'POST',
    path: '/api/programs/:id/stages',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params }) =>
      json(
        { stage: await createStage({ db: env.DB, ctx }, params.id!, await readJsonBody(request)) },
        ctx,
        201,
      ),
  },

  // ---- cycles --------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/cycles',
    roles: STAFF_READ,
    handler: async ({ env, ctx, url }) => {
      const programId = url.searchParams.get('program_id');
      const sql = `SELECT id, program_id, name, opens_at, closes_at, decision_due_at,
                          announcement_date, status, rubric_id, draft_grace_hours
                     FROM cycles
                    WHERE deleted_at IS NULL ${programId ? 'AND program_id = ?' : ''}
                    ORDER BY opens_at DESC`;
      const stmt = programId ? env.DB.prepare(sql).bind(programId) : env.DB.prepare(sql);
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
    },
  },
  {
    method: 'POST',
    path: '/api/programs/:id/cycles',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params }) =>
      json(
        { cycle: await createCycle({ db: env.DB, ctx }, params.id!, await readJsonBody(request)) },
        ctx,
        201,
      ),
  },
  {
    method: 'PATCH',
    path: '/api/cycles/:id',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params }) =>
      json({ cycle: await updateCycle({ db: env.DB, ctx }, params.id!, await readJsonBody(request)) }, ctx),
  },
  {
    // Opening a cycle is its own verb with its own audit action, because this is
    // the write that decides whether the public form accepts submissions.
    method: 'POST',
    path: '/api/cycles/:id/open',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params }) =>
      json({ cycle: await setCycleStatus({ db: env.DB, ctx }, params.id!, 'open') }, ctx),
  },
  {
    method: 'POST',
    path: '/api/cycles/:id/close',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params }) =>
      json({ cycle: await setCycleStatus({ db: env.DB, ctx }, params.id!, 'closed') }, ctx),
  },

  // ---- forms ---------------------------------------------------------------
  {
    // Metadata only: what forms exist, which program and stage they belong to,
    // and their version and publication state. No sections, no fields.
    method: 'GET',
    path: '/api/forms',
    roles: STAFF_READ,
    handler: async ({ env, ctx, url }) => {
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
    },
  },
  {
    // THE CONTRACT. What the applicant form consumes: sections and fields in
    // order, with parsed options, validation rules, conditional wiring and
    // promotion targets. No answers, no applicant data, no internal notes.
    method: 'GET',
    path: '/api/forms/:id',
    roles: STAFF_READ,
    handler: async ({ env, ctx, params }) =>
      json({ form: await loadFormDefinition(env.DB, params.id!) }, ctx),
  },

  // ---- applications (the pipeline) -----------------------------------------
  {
    method: 'GET',
    path: '/api/applications',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, url, session }) => {
      const q = url.searchParams;

      // Money arrives as a string on a query string. It is parsed as INTEGER
      // CENTS and rejected if it is anything else, rather than coerced -- a
      // filter that silently reads "50000" as fifty thousand dollars when the
      // column holds cents returns a confidently wrong page of results.
      const cents = (key: string): number | null => {
        const raw = q.get(key);
        if (raw === null || raw.trim() === '') return null;
        if (!/^\d+$/.test(raw.trim())) {
          throw validationFailed([
            { field: key, message: `${key} must be a whole number of cents.` },
          ]);
        }
        const n = Number(raw.trim());
        if (!Number.isSafeInteger(n)) {
          throw validationFailed([{ field: key, message: `${key} is too large.` }]);
        }
        return n;
      };

      const page = Number(q.get('limit') ?? '50');
      const from = Number(q.get('offset') ?? '0');

      const result = await listApplicationsForStaff(env.DB, session, {
        programId: q.get('program_id'),
        cycleId: q.get('cycle_id'),
        stageId: q.get('stage_id'),
        status: q.get('status'),
        organizationId: q.get('organization_id'),
        minAmountCents: cents('min_amount_cents'),
        maxAmountCents: cents('max_amount_cents'),
        limit: Number.isSafeInteger(page) ? page : 50,
        offset: Number.isSafeInteger(from) ? from : 0,
      });
      return json(result, ctx);
    },
  },
  {
    method: 'GET',
    path: '/api/applications/:id',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, params, session }) =>
      json(await getApplicationDetailForStaff(env.DB, session, params.id!), ctx),
  },

  // ---- search --------------------------------------------------------------
  {
    // "Have we ever funded youth mental health in Fort Bend County" as a query
    // rather than an afternoon. Scoped by assignment, not merely by staff role.
    method: 'GET',
    path: '/api/search',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, url, session }) => {
      const q = url.searchParams.get('q') ?? '';
      const hits = await searchApplications(env.DB, session, q, 50);
      return json({ query: q, hits }, ctx);
    },
  },

  // ---- organizations -------------------------------------------------------
  {
    // The applicant-history panel. Institutional memory that currently lives in
    // one person's head.
    method: 'GET',
    path: '/api/organizations/:id/history',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, params, session }) =>
      json(await organizationHistoryForStaff(env.DB, session, params.id!), ctx),
  },

  // ---- review --------------------------------------------------------------
  {
    // A reviewer's own queue. Scoped in scope.ts beside the detail view, so the
    // two cannot disagree about what this reviewer may see.
    method: 'GET',
    path: '/api/review/queue',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, session }) =>
      json({ assignments: await listApplicationsForReviewer(env.DB, session) }, ctx),
  },
];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** A placeholder session for public routes, which never read it. */
const NO_SESSION: Session = {
  userId: '',
  email: '',
  role: 'executive',
  organizationId: null,
};

async function dispatch(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  // HEAD is answered by the GET handler; the runtime drops the body.
  const method = request.method === 'HEAD' ? 'GET' : request.method;

  const resolution = resolve(routes, method, url.pathname);
  if (resolution.kind === 'not_found') throw notFound('page');
  if (resolution.kind === 'method_not_allowed') throw methodNotAllowed(resolution.allow ?? []);

  const { route, params } = resolution.match!;

  if (route.public) {
    return route.handler({ request, env, ctx, url, params, session: NO_SESSION });
  }

  // Authenticate BEFORE authorizing: a caller with no valid Access assertion
  // gets 401, never a 403 that would confirm the route exists to someone who
  // has not signed in.
  const session: Session = await requireStaffSession(request, env, ctx);
  ctx.session = session;
  authorizeRoute(route, session);

  return route.handler({ request, env, ctx, url, params, session });
}

export default {
  async fetch(request: Request, env: Env, _executionCtx: ExecutionContext): Promise<Response> {
    const ctx = buildContext(request);
    try {
      return await dispatch(request, env, ctx);
    } catch (err) {
      return await toErrorResponse(err, env, ctx);
    }
  },

  /**
   * Scheduled work.
   *
   * The D1-to-R2 export hangs here. Standing recommendation: that export must
   * exist BEFORE the public form goes live, because that is the first moment
   * this system holds real third-party audited financial statements, and D1
   * Time Travel is disaster recovery, not backup.
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
// Exported for a test that asserts every route declares its roles.
export { routes };
