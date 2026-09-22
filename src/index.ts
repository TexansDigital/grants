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
import { scheduledBackup } from './lib/backup';
import { runReportReminders } from './lib/reportReminders';
import { securityHeaders, htmlHeaders } from './lib/httpHeaders';
import { readSessionCookie, resolveSession } from './lib/sessions';
import {
  requestSignInLink, renderVerifyInterstitial, completeSignIn, signOutRoute,
} from './lib/authRoutes';
import { submitEligibility } from './lib/eligibility';
import { listOpenCycles, readPublicForm } from './lib/publicRoutes';
import { createApplication, readDraft, autosaveDraft, submitDraft } from './lib/applicantRoutes';
import { presignUpload, presignReportUpload, r2UploadOrigin } from './lib/uploads';
import { presignDownloadForStaff, presignDownloadForExternal } from './lib/downloads';
import { runRetention, holdAttachment, purgeAttachmentNow, retentionScreen } from './lib/retention';
import {
  listRubrics, getRubric, createRubric, replaceCriteria, publishRubric,
  newDraftFrom, attachRubricToCycle,
} from './lib/rubrics';
import {
  loadScoringSheet, saveScores, completeReview, reopenReview, scoreSummary,
} from './lib/scoring';
import { decideApplication, type DecisionStatus } from './lib/decisions';
import {
  communicationQueue, sendAwardNotification, sendDeclineNotification,
  recordManualCommunication, sendDeclineBatch,
} from './lib/decisionComms';
import {
  exportScorecard, planScorecardImport, applyScorecardImport, reviewersInCycle,
} from './lib/scorecards';
import {
  createAwardFromDecision, budgetByProgram, amendAward, amendmentHistory,
  type AmendmentInput,
} from './lib/awards';
import { publicGrants, publishableAwards, setAwardPublic } from './lib/publicGrants';
import {
  awardsAwaitingResponse, acceptAward, declineAward, recordAwardDocument, awardPaperwork,
  type AwardDocument,
} from './lib/acceptance';
import { buildDashboard, dashboardCsv } from './lib/dashboard';
import {
  awardLedger, schedulePayment, recordPayment, cancelPayment,
} from './lib/payments';
import {
  granteeHome, granteeMe, readReport, autosaveReport, fileReport,
} from './lib/granteeRoutes';
import { requireStaffSession } from './lib/auth';
import { loadFormDefinition } from './lib/loadForm';
import {
  assertNoInternalFields,
  getApplicationDetailForStaff,
  listApplicationsForReviewer,
  listApplicationsForStaff,
  organizationHistoryForStaff,
} from './lib/scope';
import { searchApplications } from './lib/search';
import { reindexAllApplications } from './lib/reindex';
import {
  reportPortfolio, readReportForStaff, acceptReport, requestReportRevisions, waiveReport,
} from './lib/reportAdmin';
import { buildReportForm, publishReportForm } from './lib/reportForm';
import { findDuplicateCandidates, planMerge, applyMerge } from './lib/merge';
import {
  junkOrganization, restoreOrganization, junkApplication, listRemovedOrganizations,
} from './lib/junk';
import {
  assignReviewer, unassignReviewer, declareConflict, clearConflict, recuse,
  outstandingConflicts,
  reviewCoverage, distributeReviewers, DEFAULT_REVIEWERS_PER_APPLICATION,
} from './lib/reviewAssign';
import { dataHealth } from './lib/dataHealth';
import { generateReportPeriods, generateMissingReportPeriods } from './lib/reportPeriods';
import { previewAwardImport, runAwardImport } from './lib/awardsImportRoutes';
import {
  ADMIN_ONLY,
  STAFF_READ,
  EXTERNAL_USER,
  authorizeRoute,
  methodNotAllowed,
  resolve,
  surfaceOf,
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
/**
 * Is this request arriving on the APPLICANT hostname?
 *
 * Derived from APPLICANT_BASE_URL, which is already the configured, non-
 * inferred answer to "where do applicants live" -- the same value magic links
 * are built from, and deliberately not taken from the request's Host header,
 * which an attacker controls.
 *
 * FALSE when APPLICANT_BASE_URL is empty, which is the case for local dev and
 * for staging. Those run one surface on one hostname, and splitting them there
 * would mean `wrangler dev` could not reach the staff app at all. The split
 * exists because production has two hostnames; where it has one, there is
 * nothing to separate.
 */
function isApplicantHost(request: Request, env: Env): boolean {
  const base = (env.APPLICANT_BASE_URL ?? '').trim();
  if (!base) return false;
  try {
    return new URL(request.url).host === new URL(base).host;
  } catch {
    return false;
  }
}

/**
 * The root path, which means something different on each hostname.
 *
 * On `grants.` it is the staff app. On `apply.` it was ALSO the staff app,
 * because the client router maps '/' to the pipeline and had no idea which
 * host served it -- so a nonprofit typing the address got the staff shell,
 * which called /api/session, correctly got 401, and offered a "reload and
 * sign in" button that returned them to the staff shell. An infinite loop
 * with no way out, reached by typing the address we were about to print on a
 * grant application.
 *
 * A redirect rather than serving the sign-in shell directly, so the address
 * bar says what page this is and a reload cannot land back here.
 */
async function serveRoot(rc: RouteContext): Promise<Response> {
  if (isApplicantHost(rc.request, rc.env)) {
    return new Response(null, {
      status: 302,
      headers: { location: '/sign-in', 'cache-control': 'no-store' },
    });
  }
  return serveAppShell(rc);
}

async function serveAppShell({ request, env, ctx }: RouteContext): Promise<Response> {
  if (!env.ASSETS) throw notFound('page');
  for (const path of ['/index.html', '/']) {
    const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: 'GET' }));
    if (res.ok) {
      // The upload origin goes in THIS response's policy, not the API's: a
      // CSP governs only the document it arrives with, and the shell is the
      // document that has to reach R2. The same is true of Turnstile: the
      // widget is loaded by this document, so this is the only policy that
      // decides whether it may load at all.
      return new Response(res.body, {
        status: 200,
        headers: htmlHeaders(
          ctx.requestId,
          r2UploadOrigin(env),
          (env.TURNSTILE_SITE_KEY ?? '').trim() !== '',
        ),
      });
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
  { method: 'GET', path: '/', roles: [], public: true, handler: serveRoot },
  // The external front door. Reachable on BOTH hostnames on purpose: the
  // sign-in email links here, and a grantee who follows that link from a
  // phone should not be punished for which address they arrive at.
  { method: 'GET', path: '/sign-in', roles: [], public: true, handler: serveAppShell },

  // --- The public front door -------------------------------------------------
  //
  // Reads only, and narrow: open cycles, and the eligibility form of an open
  // cycle. `cycles.status = 'open'` is the gate, and the only one -- an admin
  // opening a cycle is the deliberate act that publishes it to the world.
  {
    method: 'GET',
    path: '/api/public/cycles',
    roles: [],
    public: true,
    handler: ({ env }) => listOpenCycles(env, nowIso()),
  },
  {
    method: 'GET',
    path: '/api/public/forms/:id',
    roles: [],
    public: true,
    handler: ({ env, params }) => readPublicForm(env, params.id!, nowIso()),
  },
  {
    /*
     * Who the Foundation has funded. PUBLIC, and read-only.
     *
     * The dangerous part of this endpoint is not what it shows -- who, for
     * what, how much is what every funder publishes -- it is WHEN. Three
     * conditions gate every row and all three are in SQL: an admin opted the
     * award in, the grantee has been told, and the embargo has passed. A web
     * page is public to everyone at once, so publishing early is worse here
     * than anywhere else in the system.
     *
     * No Turnstile: it is a read of data the Foundation has chosen to publish,
     * and a challenge in front of a public grant list would be theatre.
     */
    method: 'GET',
    path: '/api/public/grants',
    roles: [],
    public: true,
    handler: async ({ env, ctx }) =>
      json({ grants: await publicGrants(env.DB, nowIso()) }, ctx),
  },
  { method: 'GET', path: '/grants', roles: [], public: true, handler: serveAppShell },

  // The public pages themselves. Listed explicitly, as every other SPA path
  // is, so a mistyped URL still 404s.
  { method: 'GET', path: '/apply', roles: [], public: true, handler: serveAppShell },
  { method: 'GET', path: '/apply/start/:id', roles: [], public: true, handler: serveAppShell },

  // --- Applicant sign-in -----------------------------------------------------
  {
    // The only route that creates an applicant.
    method: 'POST',
    path: '/api/public/eligibility',
    roles: [],
    public: true,
    handler: ({ request, env, ctx }) => submitEligibility(request, env, ctx),
  },
  {
    method: 'POST',
    path: '/api/auth/request-link',
    roles: [],
    public: true,
    handler: ({ request, env, ctx }) => requestSignInLink(request, env, ctx),
  },
  {
    // Consumes NOTHING. A mail scanner's GET must not spend the link; only
    // the POST from the button on this page redeems it.
    method: 'GET',
    path: '/auth/verify',
    roles: [],
    public: true,
    handler: async ({ url }) => renderVerifyInterstitial(url),
  },
  {
    method: 'POST',
    path: '/api/auth/verify',
    roles: [],
    public: true,
    handler: ({ request, env, ctx }) => completeSignIn(request, env, ctx),
  },
  {
    method: 'POST',
    path: '/api/auth/sign-out',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ request, env, ctx, session }) => signOutRoute(request, env, ctx, session),
  },
  // --- The applicant's own application ---------------------------------------
  {
    method: 'POST',
    path: '/api/applications',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ request, env, ctx, session }) => createApplication(request, env, ctx, session),
  },
  {
    method: 'POST',
    path: '/api/applications/:id/uploads',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await presignUpload(env, ctx, session, params.id!, {
        fieldKey: String(body.fieldKey ?? ''),
        filename: String(body.filename ?? ''),
        mimeType: String(body.mimeType ?? ''),
        sizeBytes: Number(body.sizeBytes ?? 0),
      });
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    },
  },
  {
    method: 'GET',
    path: '/api/applications/:id/draft',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ env, session, params }) => readDraft(env, session, params.id!),
  },
  {
    method: 'PATCH',
    path: '/api/applications/:id/draft',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ request, env, ctx, session, params }) =>
      autosaveDraft(request, env, ctx, session, params.id!),
  },
  {
    method: 'POST',
    path: '/api/applications/:id/submit',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ request, env, ctx, session, params }) =>
      submitDraft(request, env, ctx, session, params.id!),
  },
  {
    method: 'GET',
    path: '/api/me',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: async ({ session }) =>
      new Response(
        JSON.stringify({
          // Deliberately minimal. An applicant endpoint returns the applicant's
          // own identity and nothing about the organization's applications --
          // those have their own scoped routes.
          user: { email: session.email, role: session.role },
        }),
        { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
      ),
  },
  // --- The grantee portal ----------------------------------------------------
  //
  // Same front door as the applicant: one magic link, one external session.
  // A grantee IS an applicant who has been funded, and making them hold two
  // accounts to tell us how it went would be a choice nobody asked for.
  {
    method: 'GET',
    path: '/api/grantee/home',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ env, session }) => granteeHome(env, session),
  },
  {
    method: 'GET',
    path: '/api/grantee/me',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ env, session }) => granteeMe(env, session),
  },
  {
    method: 'GET',
    path: '/api/grantee/reports/:id',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ env, session, params }) => readReport(env, session, params.id!),
  },
  {
    method: 'PATCH',
    path: '/api/grantee/reports/:id/draft',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ request, env, ctx, session, params }) =>
      autosaveReport(request, env, ctx, session, params.id!),
  },
  {
    method: 'POST',
    path: '/api/grantee/reports/:id/submit',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: ({ request, env, ctx, session, params }) =>
      fileReport(request, env, ctx, session, params.id!),
  },
  {
    method: 'POST',
    path: '/api/grantee/reports/:id/uploads',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await presignReportUpload(env, ctx, session, params.id!, {
        fieldKey: String(body.fieldKey ?? ''),
        filename: String(body.filename ?? ''),
        mimeType: String(body.mimeType ?? ''),
        sizeBytes: Number(body.sizeBytes ?? 0),
      });
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    },
  },
  {
    /*
     * An applicant or grantee reading back one of their own uploads.
     *
     * A SEPARATE PATH FROM THE STAFF ONE, not the same route with a wider role
     * list. The two differ in what they may reach (this one is scoped by the
     * session's organization, in the attachment row AND in its parent) and in
     * what they record (this one leaves the retention counters alone, because
     * an applicant fetching their own document says nothing about whether the
     * Foundation holds a copy). Sharing a route would mean one handler whose
     * behaviour forks on role, which is how the wrong branch eventually runs.
     *
     * POST for the same reason the staff route is POST: it writes an audit row
     * and hands back a live credential, and a GET is something a prefetcher
     * fires without anybody clicking.
     */
    method: 'POST',
    path: '/api/portal/attachments/:id/download-url',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: async ({ env, ctx, params, session }) =>
      json(await presignDownloadForExternal(env, ctx, session, params.id!), ctx),
  },

  // The portal's own paths. The shell is public; every call it makes is
  // scoped by the session behind it, so a signed-out grantee gets a 401 from
  // the data endpoint rather than a blank page.
  { method: 'GET', path: '/reports', roles: [], public: true, handler: serveAppShell },
  { method: 'GET', path: '/reports/:id', roles: [], public: true, handler: serveAppShell },

  // The staff form PREVIEW. The shell is public but every call it makes is
  // staff-only, so on the applicant hostname it would render a staff-looking
  // page that then failed. Marked explicitly because derivation cannot tell a
  // public staff shell from a public applicant one.
  {
    method: 'GET',
    path: '/forms/:id',
    roles: [],
    public: true,
    surface: 'staff',
    handler: serveAppShell,
  },
  /*
   * The staff app's own deep links.
   *
   * WHY THESE WERE MISSING AND WHY IT MATTERED. Only the public shells were
   * listed, so every staff screen worked by in-app navigation and 404'd if the
   * address was typed, bookmarked, or followed from an email. The retention
   * notice links to /retention -- an email that lands on a 404 on the night it
   * says to act is worse than no email.
   *
   * `surface: 'staff'` on every one: on apply.<domain> these must 404 rather
   * than render a staff-looking page that then fails, and derivation cannot
   * tell a public staff shell from a public applicant one.
   *
   * The SHELL is public; nothing in it is. Each screen's first act is a call
   * to an API route behind Cloudflare Access, and a stranger who reaches one
   * of these addresses gets an empty frame and a 401, not data.
   */
  ...(
    [
      '/pipeline',
      '/configuration',
      '/data-health',
      '/retention',
      '/applications/:id',
      '/programs/:id/rubrics',
      // A reviewer's own queue and one scoring sheet. Separate from /pipeline
      // on purpose: "everything" and "mine" are different questions and must
      // not share a path.
      '/my-reviews',
      '/my-reviews/:id/score',
      '/cycles/:id/letters',
      '/cycles/:id/scorecards',
      '/dashboard',
    ] as const
  ).map(
    (path) =>
      ({
        method: 'GET',
        path,
        roles: [],
        public: true,
        surface: 'staff',
        handler: serveAppShell,
      }) satisfies Route,
  ),

  // The applicant's own application. The shell is public; every API call it
  // makes is scoped by the session behind it, and a signed-out applicant gets
  // a 401 from the draft endpoint rather than a blank page.
  { method: 'GET', path: '/apply/:id', roles: [], public: true, handler: serveAppShell },

  // ---- session -------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/session',
    roles: STAFF_READ,
    handler: async ({ ctx, session }) =>
      json({ user: { email: session.email, role: session.role } }, ctx),
  },

  // ---- grantee reporting, from the staff side -------------------------------
  {
    method: 'GET',
    path: '/api/reports',
    roles: STAFF_READ,
    handler: async ({ env, ctx, url, session }) => {
      const q = url.searchParams;
      const out = await reportPortfolio(env.DB, session, {
        programId: q.get('program_id'),
        organizationId: q.get('organization_id'),
        status: q.get('status'),
        overdueOnly: q.get('overdue') === 'true',
        limit: Number(q.get('limit') ?? '100'),
        offset: Number(q.get('offset') ?? '0'),
      });
      return json(out, ctx);
    },
  },
  {
    method: 'GET',
    path: '/api/reports/:id',
    roles: STAFF_READ,
    handler: async ({ env, ctx, params, session }) =>
      json(await readReportForStaff(env.DB, session, params.id!), ctx),
  },
  {
    method: 'POST',
    path: '/api/reports/:id/accept',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(await acceptReport(env.DB, ctx, session, params.id!), ctx),
  },
  {
    method: 'POST',
    path: '/api/reports/:id/revisions',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = await readJsonBody(request);
      return json(
        await requestReportRevisions(
          env.DB, ctx, session, params.id!, String(body.feedback ?? ''),
        ),
        ctx,
      );
    },
  },
  {
    method: 'POST',
    path: '/api/reports/:id/waive',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = await readJsonBody(request);
      await waiveReport(env.DB, ctx, session, params.id!, String(body.reason ?? ''));
      return json({ waived: true }, ctx);
    },
  },

  // ---- importing awards -----------------------------------------------------
  //
  // Two steps, deliberately. The preview writes nothing and is what an admin
  // reads; the apply RE-PARSES AND RE-PLANS FROM THE FILE rather than trusting
  // the plan it just returned. A plan is a set of decisions about which
  // organizations exist and which rows create users -- accepting one over HTTP
  // would let a caller hand back a plan naming any organization it liked.
  {
    method: 'POST',
    path: '/api/awards/import/preview',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, session }) =>
      json(await previewAwardImport(env.DB, session, await readJsonBody(request)), ctx),
  },
  {
    method: 'POST',
    path: '/api/awards/import',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, session }) =>
      json(await runAwardImport(env.DB, ctx, session, await readJsonBody(request)), ctx),
  },

  // ---- report periods -------------------------------------------------------
  //
  // Until these exist, an award is a grant nobody will ever be asked to report
  // on: the grantee portal lists periods, the compliance desk lists periods,
  // and an award with none appears in neither. The generator was written and
  // tested in Phase 5 and had no way in at all, which is why the data health
  // check that counts them was the only thing in the system that knew.
  //
  // ADMIN_ONLY: this creates obligations against somebody else's grant, with a
  // date they will be held to.
  {
    method: 'POST',
    path: '/api/awards/:id/report-periods',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params }) =>
      json(await generateReportPeriods(env.DB, ctx, params.id!), ctx),
  },
  {
    method: 'POST',
    path: '/api/report-periods/generate',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, session }) =>
      json(await generateMissingReportPeriods(env.DB, ctx, session), ctx),
  },

  // ---- data health ----------------------------------------------------------
  //
  // ADMIN_ONLY, and the reason is the aggregate rather than any single row: a
  // reviewer is scoped to the applications assigned to them, and this is every
  // organization's award compliance and EIN state across every program.
  {
    /*
     * Rebuild the full-text index.
     *
     * ADMIN ONLY, and a POST because it writes. It exists for one situation:
     * after a restore. The nightly export skips virtual tables, so a restored
     * database has an empty application_fts and a fully populated
     * application_search_state -- an index that reports itself current and
     * finds nothing. Nothing else in this system could rebuild it.
     *
     * Not on a schedule. A rebuild is cheap here but it is not free, and a
     * nightly one would mask exactly the kind of indexing bug it exists to
     * recover from.
     */
    method: 'POST',
    path: '/api/search/reindex',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx }) => json(await reindexAllApplications(env.DB, ctx), ctx),
  },
  {
    method: 'GET',
    path: '/api/data-health',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, session }) => json(await dataHealth(env.DB, session), ctx),
  },

  // ---- duplicate organizations ----------------------------------------------
  //
  // `organizations` deliberately has no unique index on EIN, because duplicates
  // are an expected state -- two contacts from one nonprofit, an EIN typed with
  // a dash one year and without it the next. These are what puts them back
  // together. Looking is staff; merging is admin, because it is not reversible.
  {
    method: 'GET',
    path: '/api/organizations/duplicates',
    roles: STAFF_READ,
    handler: async ({ env, ctx, url, session }) =>
      json(
        {
          groups: await findDuplicateCandidates(env.DB, session, {
            limit: Number(url.searchParams.get('limit') ?? '50'),
          }),
        },
        ctx,
      ),
  },
  {
    method: 'GET',
    path: '/api/organizations/:id/merge-preview',
    roles: STAFF_READ,
    handler: async ({ env, ctx, url, params, session }) => {
      const into = url.searchParams.get('into');
      if (!into) throw validationFailed([{ field: 'into', message: 'Name the surviving record.' }]);
      // :id is the DUPLICATE, `into` is the survivor -- the same order the
      // merge route uses, so a preview and the act it previews cannot be
      // transposed by a caller reading one and calling the other.
      return json(await planMerge(env.DB, session, into, params.id!), ctx);
    },
  },
  {
    method: 'POST',
    path: '/api/organizations/:id/merge',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = await readJsonBody(request);
      const into = typeof body.into === 'string' ? body.into : '';
      if (!into) throw validationFailed([{ field: 'into', message: 'Name the surviving record.' }]);
      return json(await applyMerge(env.DB, ctx, session, into, params.id!), ctx);
    },
  },

  // ---- report forms, built from a program's metrics -------------------------
  {
    method: 'POST',
    path: '/api/programs/:id/report-form',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params }) => {
      const body = await readJsonBody(request).catch(() => ({}) as Record<string, unknown>);
      const out = await buildReportForm(env.DB, ctx, {
        programId: params.id!,
        ...(typeof body.formKey === 'string' ? { formKey: body.formKey } : {}),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      });
      return json(out, ctx, 201);
    },
  },
  {
    method: 'POST',
    path: '/api/forms/:id/publish',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params }) =>
      json(await publishReportForm(env.DB, ctx, params.id!), ctx),
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

  // ---- scoring -------------------------------------------------------------
  //
  // Reviewers reach all of these, and are scoped in SQL to their OWN
  // assignment. An assignment belonging to anybody else is a 404 -- not a 403,
  // which would confirm it exists.
  //
  // Admins reach them too, because recording a scorecard a consultant phoned
  // in is ordinary work. The audit row names the person who typed it
  // separately from the reviewer it belongs to.
  {
    method: 'GET',
    path: '/api/review/assignments/:id/sheet',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, params, session }) =>
      json(await loadScoringSheet(env.DB, session, params.id!), ctx),
  },
  {
    /*
     * PARTIAL SAVES ARE THE NORMAL CASE, which is why this is a PATCH taking
     * whichever criteria changed rather than the whole sheet. A reviewer reads
     * a forty-field application over an hour; requiring the full set would
     * mean losing that hour to a closed laptop.
     */
    method: 'PATCH',
    path: '/api/review/assignments/:id/scores',
    roles: ['admin', 'reviewer'],
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as { scores?: unknown };
      const raw = Array.isArray(body.scores) ? body.scores : [];
      return json(
        await saveScores(
          env.DB, ctx, session, params.id!,
          raw.map((item) => {
            const s = (item ?? {}) as Record<string, unknown>;
            return {
              criterionId: String(s.criterionId ?? ''),
              // null CLEARS a score and is not zero. Coercing a missing value
              // to 0 would turn "not yet scored" into a judgement.
              score: s.score === null || s.score === undefined ? null : Number(s.score),
              comment: s.comment == null ? null : String(s.comment),
            };
          }),
        ),
        ctx,
      );
    },
  },
  {
    method: 'POST',
    path: '/api/review/assignments/:id/complete',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, params, session }) =>
      json(await completeReview(env.DB, ctx, session, params.id!), ctx),
  },
  {
    // A reviewer taking their own submitted review back, while the application
    // is still undecided. The alternative is a review nobody can correct.
    method: 'POST',
    path: '/api/review/assignments/:id/reopen',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, params, session }) =>
      json(await reopenReview(env.DB, ctx, session, params.id!), ctx),
  },
  {
    /*
     * Every reviewer's scores side by side. ADMIN ONLY.
     *
     * CLAUDE.md's access table: a reviewer may never see another reviewer's
     * scores. The enforcement is that no reviewer-reachable query selects
     * another assignment's rows at all -- this endpoint is the only one that
     * does, and it refuses a non-admin in scoring.ts as well as here.
     */
    method: 'GET',
    path: '/api/applications/:id/scores',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(await scoreSummary(env.DB, session, params.id!), ctx),
  },
  {
    /*
     * Recording the outcome.
     *
     * RECORDS ONLY. No award is created, no payment scheduled, and nothing is
     * emailed -- CLAUDE.md requires that a decline is never sent
     * automatically, and the cheapest way to keep that true is for this path
     * to have no way to send anything at all.
     */
    method: 'POST',
    path: '/api/applications/:id/decision',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await decideApplication(env.DB, ctx, session, params.id!, {
          status: String(body.status ?? '') as DecisionStatus,
          notes: body.notes == null ? null : String(body.notes),
        }),
        ctx,
      );
    },
  },

  // ---- award acceptance ----------------------------------------------------
  //
  // THE GRANTEE'S OWN ACT. CLAUDE.md puts the W-9 and the media release at
  // acceptance rather than application, which only means anything if
  // acceptance is a moment the grantee causes. All three routes are scoped by
  // the magic-link session's organization; another organization's award is a
  // 404, not a 403.
  {
    method: 'GET',
    path: '/api/my/awards',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: async ({ env, ctx, session }) =>
      json({ awards: await awardsAwaitingResponse(env.DB, session) }, ctx),
  },
  {
    method: 'POST',
    path: '/api/my/awards/:id/accept',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await acceptAward(env.DB, ctx, session, params.id!, {
          // The exact words the grantee saw, sent back and recorded on the
          // audit row -- so "what did they agree to" survives a later change
          // to the wording.
          attestationText: String(body.attestationText ?? ''),
          note: body.note == null ? null : String(body.note),
        }),
        ctx,
      );
    },
  },
  {
    // Not every award survives acceptance. Without this the award sits
    // `pending` forever and the committed total stays wrong.
    method: 'POST',
    path: '/api/my/awards/:id/decline',
    roles: EXTERNAL_USER,
    auth: 'applicant',
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await declineAward(env.DB, ctx, session, params.id!, String(body.reason ?? '')),
        ctx,
      );
    },
  },
  {
    /*
     * Changing an award, with a record of the change.
     *
     * 0012 has refused to let an awarded amount be updated since Phase 0,
     * pointing at an amendments table Phase 4 never built -- so an award
     * recorded at the wrong amount could not be corrected through this system
     * at all, and the documented remedy amounted to editing the production
     * database by hand.
     *
     * PATCH, not POST: this changes an existing thing rather than creating
     * one, and the body is a partial.
     */
    method: 'PATCH',
    path: '/api/awards/:id',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const input: AmendmentInput = { reason: String(body.reason ?? '') };
      // Present-or-absent matters here: an omitted field is "leave it alone"
      // and an explicit null is "clear it". Copying the whole body would turn
      // every absent field into an attempted change to undefined.
      if (body.awardedAmountCents !== undefined) {
        input.awardedAmountCents = Number(body.awardedAmountCents);
      }
      for (const key of ['termStart', 'termEnd', 'announcementDate'] as const) {
        if (key in body) {
          input[key] = body[key] == null ? null : String(body[key]);
        }
      }
      if (typeof body.expectedUpdatedAt === 'string') {
        input.expectedUpdatedAt = body.expectedUpdatedAt;
      }
      return json(await amendAward(env.DB, ctx, session, params.id!, input), ctx);
    },
  },
  {
    /** Every change ever made to one award. Admin-only, like the award. */
    method: 'GET',
    path: '/api/awards/:id/amendments',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json({ amendments: await amendmentHistory(env.DB, session, params.id!) }, ctx),
  },
  {
    /*
     * What is outstanding on one award, and what the grantee said.
     *
     * ADMIN_ONLY. Receipt of a grantee's W-9 is the Foundation's own record,
     * and a reviewer has no business with an award's paperwork at all.
     */
    method: 'GET',
    path: '/api/awards/:id/paperwork',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(await awardPaperwork(env.DB, session, params.id!), ctx),
  },
  {
    /*
     * Receipt of a W-9, a signed agreement or a media release.
     *
     * STAFF, NOT THE GRANTEE: what is recorded is "we have it", and only the
     * Foundation knows that. A grantee marking their own W-9 received would
     * make the data health check that reads these columns meaningless.
     */
    method: 'POST',
    path: '/api/awards/:id/document',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await recordAwardDocument(
          env.DB, ctx, session, params.id!,
          String(body.document ?? '') as AwardDocument,
          body.receivedAt == null ? null : String(body.receivedAt),
        ),
        ctx,
      );
    },
  },

  // ---- awards from decisions -----------------------------------------------
  {
    /*
     * A DECISION IS NOT AN AWARD, which is why this is a separate act rather
     * than a side effect of recording the decision. The board approves "up to
     * $50,000" and finance settles the number later; a grantee declines; the
     * terms are renegotiated. And CLAUDE.md puts W-9s at acceptance, which
     * cannot be true if every awarded application is already a live award.
     */
    method: 'POST',
    path: '/api/applications/:id/award',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await createAwardFromDecision(env.DB, ctx, session, params.id!, {
        // CENTS on the wire. The browser parses dollars at the edge, the same
        // rule every other money path in this system follows.
        awardedAmountCents: Number(body.awardedAmountCents),
        announcementDate: body.announcementDate == null ? null : String(body.announcementDate),
        termStart: body.termStart == null ? null : String(body.termStart),
        termEnd: body.termEnd == null ? null : String(body.termEnd),
        isMultiYear: body.isMultiYear === true,
        parentAwardId: body.parentAwardId == null ? null : String(body.parentAwardId),
        notes: body.notes == null ? null : String(body.notes),
      });
      return json(result, ctx, 201);
    },
  },

  // ---- publishing an award -------------------------------------------------
  {
    method: 'GET',
    path: '/api/cycles/:id/publishable',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(
        { awards: await publishableAwards(env.DB, session, params.id!, nowIso()) },
        ctx,
      ),
  },
  {
    /*
     * The opt-in. Default is private -- publishing another organization's
     * grant is a decision about them -- and taking one back down is usually a
     * decision about a mistake. Both are audited.
     */
    method: 'POST',
    path: '/api/awards/:id/public',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await setAwardPublic(env.DB, ctx, session, params.id!, body.isPublic === true),
        ctx,
      );
    },
  },

  // ---- payments ------------------------------------------------------------
  //
  // CLAUDE.md: "The system does not disburse money. It records schedules and
  // status. Disbursement stays with finance." Nothing here moves a cent. A
  // payment is `scheduled` when the Foundation has agreed it and `paid` when
  // FINANCE SAYS SO, which is why the reference number is required -- it is
  // what makes somebody else's fact checkable.
  //
  // ADMIN ONLY, including the read. When a cheque was cut and under what
  // reference is internal bookkeeping, and a grantee reading a "paid" date the
  // bank has not honoured yet would chase it.
  {
    method: 'GET',
    path: '/api/awards/:id/payments',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(await awardLedger(env.DB, session, params.id!), ctx),
  },
  {
    method: 'POST',
    path: '/api/awards/:id/payments',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const created = await schedulePayment(env.DB, ctx, session, params.id!, {
        // CENTS on the wire; the browser parses dollars at the edge, like
        // every other money path in this system.
        amountCents: Number(body.amountCents),
        scheduledDate: String(body.scheduledDate ?? ''),
        method: body.method == null ? null : String(body.method),
        note: body.note == null ? null : String(body.note),
      });
      return json(created, ctx, 201);
    },
  },
  {
    method: 'POST',
    path: '/api/payments/:id/record',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await recordPayment(env.DB, ctx, session, params.id!, {
          paidDate: String(body.paidDate ?? ''),
          referenceNumber: String(body.referenceNumber ?? ''),
          method: body.method == null ? null : String(body.method),
        }),
        ctx,
      );
    },
  },
  {
    // NOT a delete. "We promised this and then did not" is a question an
    // auditor asks, and a deleted row cannot answer it.
    method: 'POST',
    path: '/api/payments/:id/cancel',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await cancelPayment(env.DB, ctx, session, params.id!, String(body.reason ?? '')),
        ctx,
      );
    },
  },

  // ---- dashboard and exports -----------------------------------------------
  //
  // ADMIN ONLY. Executives never log in -- CLAUDE.md is explicit -- so the
  // EXPORT is the product for them, and it has to stand alone without anybody
  // from this project in the room to explain a figure.
  {
    method: 'GET',
    path: '/api/dashboard',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, session }) =>
      json(
        {
          ...(await buildDashboard(env.DB, session, nowIso())),
          budget: await budgetByProgram(env.DB, session),
        },
        ctx,
      ),
  },
  {
    // One sectioned file rather than four downloads: four files in a Downloads
    // folder is four chances to send a board the wrong one.
    method: 'GET',
    path: '/api/dashboard.csv',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, session }) => {
      const data = await buildDashboard(env.DB, session, nowIso());
      return new Response(dashboardCsv(data), {
        status: 200,
        headers: {
          ...securityHeaders(ctx.requestId),
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="grants-summary-${nowIso().slice(0, 10)}.csv"`,
        },
      });
    },
  },

  // ---- offline scorecards --------------------------------------------------
  //
  // THE FALLBACK, NOT THE PATH. CLAUDE.md: this exists so a consultant does not
  // block a decision. Uploaded scorecards carry no conflict declaration and no
  // evidence that the person who filled one in is the person it was sent to.
  // The import fixes what can be fixed -- it writes the same audit rows as
  // in-app scoring and refuses a file made for a different rubric version --
  // and the rest is why this stays the exception.
  {
    /*
     * A reviewer may export their OWN; an admin may export anyone's, because
     * sending a consultant their scorecard is the whole point. Anyone else's
     * is a 404 in the library, so the id in the URL cannot confirm that a
     * reviewer exists.
     */
    method: 'GET',
    path: '/api/cycles/:id/scorecard/:reviewerId',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, params, session }) => {
      const out = await exportScorecard(env.DB, session, params.id!, params.reviewerId!);
      return new Response(out.csv, {
        status: 200,
        headers: {
          ...securityHeaders(ctx.requestId),
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${out.filename}"`,
        },
      });
    },
  },
  {
    // Who to send one to. Not reviewCoverage, which answers the other
    // question: how many reviewers each APPLICATION has.
    method: 'GET',
    path: '/api/cycles/:id/reviewers',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(await reviewersInCycle(env.DB, session, params.id!), ctx),
  },
  {
    // Writes nothing. A file somebody edited in Excel over a weekend is not a
    // thing to apply unseen.
    method: 'POST',
    path: '/api/cycles/:id/scorecard/preview',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await planScorecardImport(env.DB, session, params.id!, String(body.csv ?? '')),
        ctx,
      );
    },
  },
  {
    method: 'POST',
    path: '/api/cycles/:id/scorecard/import',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await applyScorecardImport(env.DB, ctx, session, params.id!, String(body.csv ?? '')),
        ctx,
      );
    },
  },

  // ---- decision communication ----------------------------------------------
  //
  // ADMIN ONLY, every one. This is the highest-reputation-risk output in the
  // system: fifty acceptances and 250 declines in the same week, and the
  // decline is the one that gets screenshotted.
  {
    method: 'GET',
    path: '/api/cycles/:id/communications',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params }) =>
      json(await communicationQueue(env.DB, params.id!), ctx),
  },
  {
    method: 'POST',
    path: '/api/applications/:id/notify-award',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(await sendAwardNotification(env, ctx, session, params.id!), ctx),
  },
  {
    /*
     * The decline letter, in words a person wrote.
     *
     * The body is REQUIRED and comes from the request. This system has no
     * standard decline wording and will not invent any: 250 of these go out in
     * a week and one gets forwarded, and the Foundation has not settled what
     * they should say. The template is a shell; the words are the sender's.
     */
    method: 'POST',
    path: '/api/applications/:id/notify-decline',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as { body?: unknown };
      const paragraphs = Array.isArray(body.body)
        ? body.body.map((p) => String(p ?? ''))
        : String(body.body ?? '').split(/\n\s*\n/);
      return json(
        await sendDeclineNotification(env, ctx, session, params.id!, paragraphs),
        ctx,
      );
    },
  },
  {
    /*
     * One letter, many recipients, sent a round at a time.
     *
     * A ROUND, NOT THE LOT. A cycle produces around 250 declines and each is
     * an HTTPS call to a mail provider; one request attempting all of them is
     * betting the batch on the subrequest limit and the CPU budget, and the
     * failure mode is a request that dies at letter 180 with nobody able to
     * say which 180. The client loops while `remaining` is above zero, and
     * every letter is keyed on its own application so a repeated round sends
     * nothing twice.
     */
    method: 'POST',
    path: '/api/cycles/:id/notify-declines',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as { body?: unknown };
      const paragraphs = Array.isArray(body.body)
        ? body.body.map((p) => String(p ?? ''))
        : String(body.body ?? '').split(/\n\s*\n/);
      return json(await sendDeclineBatch(env, ctx, session, params.id!, paragraphs), ctx);
    },
  },
  {
    // The largest awards are phoned. Without this the portal would keep saying
    // "under review" to an organization that has already been told, and the
    // only fix would be a duplicate email sent to make the system behave.
    method: 'POST',
    path: '/api/applications/:id/communicated',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await recordManualCommunication(env.DB, ctx, session, params.id!, String(body.note ?? '')),
        ctx,
      );
    },
  },

  // ---- rubrics -------------------------------------------------------------
  //
  // ADMIN-ONLY, all of them, including the reads. A rubric is the instrument a
  // funding decision is made with; a reviewer sees it through the scoring
  // screen, against the one application in front of them, rather than as a
  // document they can study and optimise against.
  {
    method: 'GET',
    path: '/api/programs/:id/rubrics',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params }) =>
      json({ rubrics: await listRubrics(env.DB, params.id!) }, ctx),
  },
  {
    method: 'POST',
    path: '/api/programs/:id/rubrics',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const created = await createRubric(env.DB, ctx, session, {
        programId: params.id!,
        name: String(body.name ?? ''),
        rubricKey: String(body.rubricKey ?? ''),
      });
      return json(created, ctx, 201);
    },
  },
  {
    method: 'GET',
    path: '/api/rubrics/:id',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params }) => json(await getRubric(env.DB, params.id!), ctx),
  },
  {
    /*
     * The whole criterion list in one request.
     *
     * PUT semantics under PATCH, because the builder holds the rubric as one
     * object and the person edits it as one: reorder two rows, retitle a
     * third, change a weight, then save. Six independent requests can land
     * half-applied, and a half-applied rubric is one whose weights no longer
     * mean what the screen showed.
     */
    method: 'PATCH',
    path: '/api/rubrics/:id/criteria',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as { criteria?: unknown };
      const criteria = Array.isArray(body.criteria) ? body.criteria : [];
      return json(
        await replaceCriteria(
          env.DB, ctx, session, params.id!,
          criteria.map((raw) => {
            const c = (raw ?? {}) as Record<string, unknown>;
            return {
              criterionKey: String(c.criterionKey ?? ''),
              label: String(c.label ?? ''),
              description: c.description == null ? null : String(c.description),
              // Number(), not parseInt(): parseInt('25.5') is 25, which would
              // accept a float by silently truncating it. validateCriteria
              // refuses a non-integer, and it can only do that if it sees one.
              weightBp: Number(c.weightBp),
              maxScore: Number(c.maxScore),
            };
          }),
        ),
        ctx,
      );
    },
  },
  {
    method: 'POST',
    path: '/api/rubrics/:id/publish',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(await publishRubric(env.DB, ctx, session, params.id!), ctx),
  },
  {
    // The only way to change a published rubric: copy it forward. Editing one
    // in place would rewrite what a closed cycle was scored against.
    method: 'POST',
    path: '/api/rubrics/:id/new-version',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json(await newDraftFrom(env.DB, ctx, session, params.id!), ctx, 201),
  },
  {
    method: 'POST',
    path: '/api/cycles/:id/rubric',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await attachRubricToCycle(env.DB, ctx, session, params.id!, String(body.rubricId ?? '')),
        ctx,
      );
    },
  },

  // ---- files ---------------------------------------------------------------
  {
    /*
     * A credential to read one uploaded file.
     *
     * POST, NOT GET, although it reads. Two reasons, and the second is the one
     * that decided it. It MUTATES: a download grant bumps the counters on the
     * attachment and writes an audit row, and a GET that changes state is a GET
     * a browser, a link prefetcher, or a crawler behind Access may fire without
     * anyone clicking. That would issue live credentials for every financial
     * statement on a page merely because somebody hovered the list, and would
     * fill the audit log with reads that never happened.
     *
     * Reviewers are admitted, and are then scoped in SQL to the applications
     * assigned to them. An id belonging to anyone else's application is a 404.
     */
    method: 'POST',
    path: '/api/attachments/:id/download-url',
    roles: ['admin', 'reviewer'],
    handler: async ({ env, ctx, params, session }) =>
      json(await presignDownloadForStaff(env, ctx, session, params.id!), ctx),
  },

  {
    /*
     * What is about to be destroyed, and what already was.
     *
     * Admin-only, and not because the data is sensitive -- the filenames are
     * the least of it -- but because the two actions on this screen, holding a
     * file longer and deleting one early, are admin actions. A reviewer given
     * the list could only watch.
     */
    method: 'GET',
    path: '/api/retention',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx }) => json(await retentionScreen(env.DB, nowIso()), ctx),
  },
  {
    method: 'POST',
    path: '/api/attachments/:id/retention-hold',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await holdAttachment(
          env.DB, ctx, session, params.id!,
          String(body.until ?? ''), String(body.reason ?? ''),
        ),
        ctx,
      );
    },
  },
  {
    /*
     * Destroy one file now, ahead of its date.
     *
     * Not a DELETE, because nothing is deleted: the attachment row survives
     * with a purged_at stamp and the audit trail is unbroken. What this
     * destroys is the object in R2. Naming the method after the record would
     * describe the wrong thing.
     */
    method: 'POST',
    path: '/api/attachments/:id/purge',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, params, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return json(
        await purgeAttachmentNow(env, ctx, session, params.id!, String(body.reason ?? '')),
        ctx,
      );
    },
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
  // ---- removing what should not be there ------------------------------------
  //
  // Registration is open, so junk arrives. Soft, always, with a reason and an
  // audit row -- and refused outright for anything holding an award or a
  // submitted application, which is not junk by definition.
  {
    method: 'POST',
    path: '/api/organizations/:id/remove',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
      return json(
        await junkOrganization(
          env.DB, ctx, session, params.id!,
          typeof body.reason === 'string' ? body.reason : '',
        ),
        ctx,
      );
    },
  },
  {
    method: 'POST',
    path: '/api/organizations/:id/restore',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, session, params }) => {
      await restoreOrganization(env.DB, ctx, session, params.id!);
      return json({ ok: true }, ctx);
    },
  },
  {
    method: 'POST',
    path: '/api/applications/:id/remove',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
      await junkApplication(
        env.DB, ctx, session, params.id!,
        typeof body.reason === 'string' ? body.reason : '',
      );
      return json({ ok: true }, ctx);
    },
  },
  {
    // So a mistake is findable. A soft delete nobody can see is a hard delete
    // with extra steps.
    method: 'GET',
    path: '/api/organizations/removed',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx }) =>
      json({ organizations: await listRemovedOrganizations(env.DB) }, ctx),
  },
  // ---- review assignment ----------------------------------------------------
  //
  // Everything that can exist before a rubric does: who reviews what, who
  // declared a conflict, who stepped away, and whether every application has
  // enough eyes on it. Scoring waits for the Foundation's criteria.
  {
    method: 'POST',
    path: '/api/applications/:id/reviewers',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as { reviewerUserId?: unknown };
      const reviewerUserId = typeof body.reviewerUserId === 'string' ? body.reviewerUserId : '';
      if (!reviewerUserId) {
        throw validationFailed([{ field: 'reviewerUserId', message: 'Choose a reviewer.' }]);
      }
      return json(
        { assignment: await assignReviewer(env.DB, ctx, session, params.id!, reviewerUserId) },
        ctx,
        201,
      );
    },
  },
  {
    method: 'DELETE',
    path: '/api/review/assignments/:id',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, session, params }) => {
      await unassignReviewer(env.DB, ctx, session, params.id!);
      return json({ ok: true }, ctx);
    },
  },
  {
    // A reviewer declares their OWN conflict; an admin may record one they were
    // told about. Both go through this route, and the library decides which.
    method: 'POST',
    path: '/api/review/assignments/:id/conflict',
    roles: ['admin', 'reviewer'],
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as { note?: unknown };
      await declareConflict(
        env.DB, ctx, session, params.id!,
        typeof body.note === 'string' ? body.note : '',
      );
      return json({ ok: true }, ctx);
    },
  },
  {
    /*
     * An admin records that a declared conflict is not one.
     *
     * ADMIN_ONLY, not ['admin','reviewer'] like the two routes either side of
     * it. A reviewer declaring their own conflict and a reviewer stepping away
     * from one are both acts against their own interest; a reviewer clearing
     * their own declaration is the one act a conflict policy exists to
     * prevent. The library refuses it too -- this list is not the only guard
     * -- but a role list that reads 'reviewer' here would be read by the next
     * person as permission.
     */
    method: 'POST',
    path: '/api/review/assignments/:id/conflict/clear',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as { resolution?: unknown };
      await clearConflict(
        env.DB, ctx, session, params.id!,
        typeof body.resolution === 'string' ? body.resolution : '',
      );
      return json({ ok: true }, ctx);
    },
  },
  {
    method: 'POST',
    path: '/api/review/assignments/:id/recuse',
    roles: ['admin', 'reviewer'],
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
      await recuse(
        env.DB, ctx, session, params.id!,
        typeof body.reason === 'string' ? body.reason : '',
      );
      return json({ ok: true }, ctx);
    },
  },
  {
    // The admin's coverage grid. A separate view rather than a filter on the
    // reviewer's own list, because the question it answers -- which
    // applications are short of reviewers -- is invisible from any one
    // reviewer's worklist, and finding out at the deadline is too late.
    /*
     * ADMIN ONLY, and it was STAFF_READ.
     *
     * reviewCoverage takes no Session and applies no scoping -- it lists every
     * submitted application in the cycle with its organization's legal name
     * and project title. Under STAFF_READ an outside consultant assigned three
     * applications could read the whole roster, which is exactly the rule
     * CLAUDE.md states: a reviewer sees "only applications assigned to them".
     *
     * No scores leaked, so this was a roster leak rather than a score leak --
     * and it is still the thing that must not happen. Admin-only is the
     * correct fix rather than adding scoping, because a reviewer-scoped
     * coverage grid answers nothing: the question is which applications are
     * SHORT of reviewers, which is invisible from inside one worklist.
     */
    method: 'GET',
    path: '/api/cycles/:id/review-coverage',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, url }) => {
      const asked = Number(url.searchParams.get('target') ?? DEFAULT_REVIEWERS_PER_APPLICATION);
      const target =
        Number.isFinite(asked) && asked > 0
          ? Math.floor(asked)
          : DEFAULT_REVIEWERS_PER_APPLICATION;
      return json(await reviewCoverage(env.DB, params.id!, target), ctx);
    },
  },
  {
    /*
     * The disclosures somebody has to act on.
     *
     * ADMIN_ONLY for the same reason the coverage grid is, and for one more:
     * the payload carries a reviewer's own words about a third party -- "my
     * spouse works there" -- alongside the organization it is about.
     */
    method: 'GET',
    path: '/api/cycles/:id/conflicts',
    roles: ADMIN_ONLY,
    handler: async ({ env, ctx, params, session }) =>
      json({ conflicts: await outstandingConflicts(env.DB, session, params.id!) }, ctx),
  },
  {
    method: 'POST',
    path: '/api/cycles/:id/distribute-reviewers',
    roles: ADMIN_ONLY,
    handler: async ({ request, env, ctx, session, params }) => {
      const body = (await request.json().catch(() => ({}))) as {
        reviewerUserIds?: unknown;
        target?: unknown;
      };
      const pool = Array.isArray(body.reviewerUserIds)
        ? body.reviewerUserIds.filter((v): v is string => typeof v === 'string')
        : [];
      const target =
        typeof body.target === 'number' ? body.target : DEFAULT_REVIEWERS_PER_APPLICATION;
      return json(await distributeReviewers(env.DB, ctx, session, params.id!, pool, target), ctx);
    },
  },
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

  /*
   * THE HOSTNAME SPLIT, enforced here rather than in a dashboard.
   *
   * 404 and not 403: a staff route should not exist as far as the applicant
   * hostname is concerned, and a 403 would confirm to anyone poking at
   * apply.<domain>/api/applications that such a route exists elsewhere.
   *
   * Checked BEFORE the public branch and before authentication, so it applies
   * to app shells as well as APIs and so the answer never depends on who is
   * asking. One direction only -- the applicant surface stays reachable on the
   * staff hostname, which costs nothing and keeps `wrangler dev` usable.
   */
  if (isApplicantHost(request, env) && surfaceOf(route) === 'staff') {
    throw notFound('page');
  }

  if (route.public) {
    return route.handler({ request, env, ctx, url, params, session: NO_SESSION });
  }

  // Authenticate BEFORE authorizing: a caller with no valid session gets 401,
  // never a 403 that would confirm the route exists to someone who has not
  // signed in.
  let session: Session;
  if (route.auth === 'applicant') {
    // The magic-link door. Deliberately NOT a fallback from the staff check:
    // a route names one front door, and trying the other on failure is how a
    // handler ends up serving the wrong kind of caller.
    const cookie = readSessionCookie(request);
    const resolved = cookie ? await resolveSession(env, cookie) : null;
    if (!resolved) {
      throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.', {
        internalMessage: cookie ? 'session cookie did not resolve' : 'no session cookie',
        severity: 'warn',
      });
    }
    session = resolved;
  } else {
    session = await requireStaffSession(request, env, ctx);
  }
  ctx.session = session;
  authorizeRoute(route, session);

  const response = await route.handler({ request, env, ctx, url, params, session });

  /*
   * THE LAST GATE BEFORE A NONPROFIT'S BROWSER.
   *
   * CLAUDE.md, non-negotiable 5: reviewer scores, internal notes and decision
   * rationale "never appear in an applicant or grantee API response. Not
   * hidden in the UI. Absent from the payload."
   *
   * assertNoInternalFields has enforced exactly that since Phase 1, with
   * thorough tests -- and was never called by anything that serves a request.
   * It was reachable only from its own test file. Every external handler
   * builds its payload by naming columns explicitly, which is why nothing has
   * leaked; but "every handler is careful" is a property that holds until
   * somebody writes the next handler.
   *
   * Applied HERE, on route.auth, so it covers the routes that exist and the
   * ones added later without anybody having to remember. Staff responses are
   * left alone: internal notes are exactly what a staff response is for.
   *
   * IT FAILS CLOSED, which is the deliberate part. A leak turns into a 500 and
   * a fatal log line rather than a nonprofit reading what a reviewer wrote
   * about them. The one legitimate payload that could trip it -- an answers
   * map keyed by a form field someone named `comment` -- is refused at the
   * point the form is built, by 0026, rather than at the point an applicant
   * submits.
   */
  if (route.auth === 'applicant') return await guardExternalPayload(response);
  return response;
}

/**
 * Inspect an external JSON response for internal-only fields before it leaves.
 *
 * Reads a CLONE. Consuming the body here would hand the caller a used stream,
 * and the symptom -- an empty response on a route whose handler is correct --
 * is a long way from the cause.
 *
 * Non-JSON responses pass through untouched: app shells, redirects and signed
 * URLs are not payloads this can reason about, and parsing them would only
 * add a failure mode. Error responses pass through too; their shape is built
 * by the error boundary from a fixed template and carries no row data.
 */
async function guardExternalPayload(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;
  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    // A response that claims JSON and is not one is a bug, but it is not this
    // function's bug, and swallowing the body would turn it into one.
    return response;
  }
  assertNoInternalFields(parsed);
  return response;
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
    /*
     * TWO JOBS, EACH IN ITS OWN TRY, which is what the single-job version said
     * to do when a second arrived. A shared try block means a failing export
     * silently cancels retention, and the symptom -- financial documents
     * quietly outliving the policy -- looks like nothing at all.
     *
     * The export runs FIRST. It is the only copy of the database that outlives
     * the account, and retention destroys things; taking the snapshot before
     * the destruction means a mistaken purge is recoverable from last night's
     * export rather than from nothing.
     */
    const failures: string[] = [];

    for (const job of [
      { name: 'backup', run: () => scheduledBackup(env, ctx) },
      { name: 'retention', run: () => runRetention(env, ctx) },
      /*
       * REMINDERS LAST. They are the only job here that writes to people
       * rather than to storage, and a night where the export or the retention
       * pass has already failed is a night when the least useful thing to do
       * is mail two hundred nonprofits. Ordering it after both means a failure
       * upstream is visible in the dashboard before the send goes out, and the
       * loop below still gives it its own turn.
       */
      { name: 'reminders', run: () => runReportReminders(env, ctx) },
    ]) {
      try {
        await job.run();
      } catch (err) {
        failures.push(job.name);
        await logError(env, ctx, {
          severity: 'error',
          code: 'CRON_FAILED',
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? (err.stack ?? null) : null,
          context: { cron: event.cron, job: job.name },
        });
      }
    }

    // Thrown AFTER both have had their turn, so Cloudflare records the run as
    // failed and it is visible in the dashboard rather than only in a log
    // table somebody has to think to read.
    if (failures.length > 0) {
      throw new Error(`scheduled job(s) failed: ${failures.join(', ')}`);
    }
  },
};

// Re-exported so tests can assert the exact error shape the boundary produces.
export { AppError };
// Exported for a test that asserts every route declares its roles.
export { routes };
