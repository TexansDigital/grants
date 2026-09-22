/**
 * Router and data loading.
 *
 * Two routes and no router dependency:
 *
 *   /            the internal shell (dark)
 *   /forms/:id   the applicant form renderer (light)
 *
 * The surface theme is set on <html> so the whole document -- including the
 * ground behind the card -- switches with the route, rather than each component
 * remembering to.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ApiError, api } from './api';
import { applicantApi, type DraftResponse } from './applicantApi';
import type { CycleRow, FormSummary, ProgramRow, SessionUser } from './api';
import type { FormDefinition } from '../../src/lib/forms';
import { publicApi, type OpenCycle } from './publicApi';
import { OpenCycles } from './OpenCycles';
import { PublicGrants } from './PublicGrants';
import { SignIn } from './SignIn';
import { EligibilityForm } from './EligibilityForm';
import {
  granteeApi,
  type GranteeHomeResponse,
  type ReportResponse,
  type PendingAward,
} from './granteeApi';
import { GranteeHome } from './GranteeHome';
import { PortalApplications } from './PortalApplications';
import { ReportForm } from './ReportForm';
import { Home } from './Home';
import { FormRenderer } from './FormRenderer';
import { Pipeline } from './Pipeline';
import { Reports } from './Reports';
import { DataHealth } from './DataHealth';
import { Retention } from './Retention';
import { RubricBuilder } from './RubricBuilder';
import { ReviewQueue } from './ReviewQueue';
import { ScoringSheet } from './ScoringSheet';
import { Communications } from './Communications';
import { Scorecards } from './Scorecards';
import { ReviewCoverage } from './ReviewCoverage';
import { Dashboard } from './Dashboard';
import { AwardOffer } from './AwardOffer';
import { ApplicationDetail } from './ApplicationDetail';
import { Shell } from './Shell';
import {
  loadPreference,
  savePreference,
  resolveTheme,
  nextPreference,
  systemPrefersLight,
  type ThemePreference,
} from './theme';

type Route =
  | { name: 'home' }
  | { name: 'pipeline' }
  | { name: 'application'; id: string }
  | { name: 'form'; id: string }
  | { name: 'apply'; id: string }
  | { name: 'reporting' }
  | { name: 'dataHealth' }
  | { name: 'retention' }
  | { name: 'rubrics'; programId: string }
  | { name: 'reviewQueue' }
  | { name: 'scoringSheet'; assignmentId: string }
  | { name: 'communications'; cycleId: string }
  | { name: 'scorecards'; cycleId: string }
  | { name: 'coverage'; cycleId: string }
  | { name: 'dashboard' }
  | { name: 'openCycles' }
  | { name: 'publicGrants' }
  | { name: 'signIn' }
  | { name: 'eligibility'; cycleId: string }
  | { name: 'portal' }
  | { name: 'report'; id: string };

function parseRoute(pathname: string): Route | null {
  const parts = pathname.split('/').filter((s) => s.length > 0);
  // '/' is the STAFF pipeline, and only ever reached on the staff hostname:
  // the Worker redirects '/' to '/sign-in' on the applicant hostname, because
  // this router cannot see which host served it and mapping '/' to the staff
  // app on apply.<domain> produced a sign-in loop with no way out.
  if (parts.length === 0) return { name: 'pipeline' };
  // The external front door. Served on BOTH hostnames -- the sign-in email
  // links here, and which address a grantee arrives at is not their problem.
  if (parts.length === 1 && parts[0] === 'sign-in') return { name: 'signIn' };
  if (parts.length === 1 && parts[0] === 'configuration') return { name: 'home' };
  if (parts.length === 1 && parts[0] === 'pipeline') return { name: 'pipeline' };
  // The staff compliance desk. NOT /reports, which is the grantee portal --
  // two different audiences must never share a path.
  if (parts.length === 1 && parts[0] === 'reporting') return { name: 'reporting' };
  if (parts.length === 1 && parts[0] === 'data-health') return { name: 'dataHealth' };
  // Linked from the nightly retention notice. If this path did not exist,
  // that email would send admins to a 404 on the night it matters most.
  if (parts.length === 1 && parts[0] === 'retention') return { name: 'retention' };
  if (parts.length === 1 && parts[0] === 'dashboard') return { name: 'dashboard' };
  // A reviewer's own queue. NOT /pipeline, which is the admin's view of
  // everything -- two different questions must not share a path.
  if (parts.length === 1 && parts[0] === 'my-reviews') return { name: 'reviewQueue' };
  if (parts.length === 3 && parts[0] === 'cycles' && parts[2] === 'letters' && parts[1]) {
    return { name: 'communications', cycleId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === 'cycles' && parts[2] === 'coverage' && parts[1]) {
    return { name: 'coverage', cycleId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === 'cycles' && parts[2] === 'scorecards' && parts[1]) {
    return { name: 'scorecards', cycleId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === 'my-reviews' && parts[2] === 'score' && parts[1]) {
    return { name: 'scoringSheet', assignmentId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === 'programs' && parts[2] === 'rubrics' && parts[1]) {
    return { name: 'rubrics', programId: parts[1] };
  }
  if (parts.length === 2 && parts[0] === 'applications' && parts[1]) {
    return { name: 'application', id: parts[1] };
  }
  if (parts.length === 2 && parts[0] === 'forms' && parts[1]) return { name: 'form', id: parts[1] };
  // The public front door. Checked BEFORE /apply/:id, because "start" is not
  // an application id and the three-segment path is the more specific match.
  if (parts.length === 1 && parts[0] === 'apply') return { name: 'openCycles' };
  // Public and read-only. Served on both hostnames, like the other public
  // pages: which address somebody arrives at is not their problem.
  if (parts.length === 1 && parts[0] === 'grants') return { name: 'publicGrants' };
  if (parts.length === 3 && parts[0] === 'apply' && parts[1] === 'start' && parts[2]) {
    return { name: 'eligibility', cycleId: parts[2] };
  }
  // The applicant's own application. Not behind Cloudflare Access -- an
  // applicant holds an app-native session from a magic link.
  if (parts.length === 2 && parts[0] === 'apply' && parts[1]) return { name: 'apply', id: parts[1] };
  // The grantee portal. Same front door as the applicant: an app-native
  // session from a magic link, never Cloudflare Access.
  if (parts.length === 1 && parts[0] === 'reports') return { name: 'portal' };
  if (parts.length === 2 && parts[0] === 'reports' && parts[1]) {
    return { name: 'report', id: parts[1] };
  }
  return null;
}

/**
 * Routes whose data belongs to an EXTERNAL user holding a magic-link session.
 *
 * A 401 on one of these means a nonprofit's sign-in ran out, and the answer is
 * the sign-in page. A 401 anywhere else means a staff member's Cloudflare
 * Access session ran out, and the answer is to reload so Access can
 * re-authenticate. Telling an applicant to "reload and sign in" sends them
 * somewhere that will never sign them in.
 *
 * 'form' is deliberately absent: it is the staff form preview, rendered light
 * but fed by a staff-only endpoint.
 */
const EXTERNAL_SESSION_ROUTES: ReadonlySet<string> = new Set(['portal', 'report', 'apply']);

interface HomeData {
  user: SessionUser;
  programs: ProgramRow[];
  cycles: CycleRow[];
  forms: FormSummary[];
}

export function App(): ReactElement {
  const [route, setRoute] = useState<Route | null>(() => parseRoute(window.location.pathname));
  const [home, setHome] = useState<HomeData | null>(null);
  const [form, setForm] = useState<FormDefinition | null>(null);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [portal, setPortal] = useState<GranteeHomeResponse | null>(null);
  /** Open cycles, read on the portal so a signed-in nonprofit can reach them. */
  const [portalCycles, setPortalCycles] = useState<OpenCycle[]>([]);
  /** Awards this organization has been offered and not yet answered. */
  const [pendingAwards, setPendingAwards] = useState<PendingAward[]>([]);
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [open, setOpen] = useState<{
    cycles: OpenCycle[];
    turnstileSiteKey: string | null;
  } | null>(null);
  const [eligibility, setEligibility] = useState<{
    cycle: OpenCycle;
    form: FormDefinition;
    turnstileSiteKey: string | null;
  } | null>(null);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [themePref, setThemePref] = useState<ThemePreference>(loadPreference);
  const [systemIsLight, setSystemIsLight] = useState(systemPrefersLight);
  // Bumped after a configuration write, so the screen reflects what just
  // happened rather than what was true when it loaded.
  const [reloadKey, setReloadKey] = useState(0);

  const [search, setSearch] = useState(() => window.location.search.replace(/^\?/, ''));

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    const url = new URL(path, window.location.origin);
    setRoute(parseRoute(url.pathname));
    setSearch(url.search.replace(/^\?/, ''));
  }, []);

  /**
   * Filters live in the URL so a filtered pipeline is a link someone can send.
   * replaceState, not pushState: typing in a filter should not put a dozen
   * entries in the history that Back has to walk through one at a time.
   */
  // The last pipeline query, so returning from a detail view lands back on the
  // filtered list. Without this a reviewer working a filtered set of forty
  // re-applies the filter after every single application -- which defeats the
  // entire reason the filters live in the URL.
  const lastPipelineQuery = useRef('');

  const setPipelineQuery = useCallback((next: string) => {
    lastPipelineQuery.current = next;
    const url = next === '' ? window.location.pathname : `${window.location.pathname}?${next}`;
    window.history.replaceState({}, '', url);
    setSearch(next);
  }, []);

  // Back and forward have to work. An applicant who presses Back and lands on a
  // blank page assumes they lost their answers.
  useEffect(() => {
    const onPop = () => {
      setRoute(parseRoute(window.location.pathname));
      setSearch(window.location.search.replace(/^\?/, ''));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Follow the operating system while the preference is "system", live -- not
  // only at load. Someone whose machine switches to light in the evening should
  // not have to reload Steward.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemIsLight(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme = resolveTheme(themePref, systemIsLight);

  /**
   * Surface and theme, both on <html> so the ground behind the card switches
   * with them rather than each component remembering to.
   *
   * The applicant form is pinned light whatever the staff preference says. A
   * dark ground under a forty-field form filled in over an hour is a
   * readability problem, and an applicant has no toggle to escape it with.
   */
  useEffect(() => {
    const external =
      route?.name === 'form' ||
      route?.name === 'apply' ||
      route?.name === 'openCycles' ||
      route?.name === 'signIn' ||
      route?.name === 'eligibility' ||
      route?.name === 'portal' ||
      route?.name === 'publicGrants' ||
      route?.name === 'report';
    const internal = !external;
    const html = document.documentElement;
    html.dataset.surface = internal ? 'internal' : 'applicant';
    html.dataset.theme = internal ? resolvedTheme : 'light';
  }, [resolvedTheme, route]);

  /*
   * Move focus and set the title on every route change.
   *
   * Focus was landing on <body>, so a keyboard user paid eleven Tabs to get
   * back to where they were and a screen reader user got no signal that
   * navigation had happened at all. FormRenderer already did this correctly for
   * its steps; the internal shell never got the same treatment.
   */
  useEffect(() => {
    const titles: Record<string, string> = {
      pipeline: 'Pipeline · Steward',
      application: 'Application · Steward',
      home: 'Configuration · Steward',
      reporting: 'Grant reports · Steward',
      dataHealth: 'Data health · Steward',
      openCycles: 'Apply for a grant · Houston Texans Foundation',
      signIn: 'Sign in · Houston Texans Foundation',
      eligibility: 'Before you start · Houston Texans Foundation',
      form: 'Form preview · Steward',
      apply: 'Your application · Steward',
      portal: 'Your grants · Steward',
      report: 'File your report · Steward',
    };
    document.title = route ? (titles[route.name] ?? 'Steward') : 'Page not found · Steward';
    if (loading) return;
    // After paint, so the heading being focused actually exists.
    const id = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('main [data-route-heading]')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [loading, route]);

  const cycleTheme = useCallback(() => {
    setThemePref((prev) => {
      const next = nextPreference(prev, resolvedTheme);
      savePreference(next);
      return next;
    });
  }, [resolvedTheme]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setError(null);
    setLoading(true);

    (async () => {
      try {
        if (
          route?.name === 'home' ||
          route?.name === 'pipeline' ||
          route?.name === 'application' ||
          route?.name === 'reporting' ||
          route?.name === 'dataHealth' ||
          /*
           * EVERY STAFF SCREEN GOES IN THIS LIST. Both of these were added
           * without it, and the symptom is not an error -- `home` stays null
           * and the screen shows "Loading…" forever, on a page whose own unit
           * tests were entirely green. The browser harness found it in the
           * first second of the first run, which is what the harness is for.
           *
           * Retention needs `home.user` for the admin check; the rubric
           * builder needs `home.programs` as well, to name the program.
           */
          route?.name === 'retention' ||
          route?.name === 'rubrics' ||
          route?.name === 'reviewQueue' ||
          route?.name === 'scoringSheet' ||
          route?.name === 'communications' ||
          route?.name === 'scorecards' ||
          route?.name === 'coverage' ||
          route?.name === 'dashboard'
        ) {
          const [s, p, c, f] = await Promise.all([
            api.session(signal),
            api.programs(signal),
            api.cycles(signal),
            api.forms(signal),
          ]);
          setHome({ user: s.user, programs: p.programs, cycles: c.cycles, forms: f.forms });
        } else if (route?.name === 'form') {
          const { form: def } = await api.form(route.id, signal);
          setForm(def);
        } else if (route?.name === 'apply') {
          const d = await applicantApi.draft(route.id, signal);
          setDraft(d);
        } else if (route?.name === 'openCycles' || route?.name === 'signIn') {
          /*
           * The sign-in page reads the same public list as the grants page.
           *
           * It needs the Turnstile site key, which this endpoint already
           * returns, and the cycle count tells it whether offering "See open
           * grants" would lead anywhere. One public read rather than a second
           * endpoint carrying one field.
           */
          setOpen(await publicApi.cycles(signal));
        } else if (route?.name === 'eligibility') {
          const list = await publicApi.cycles(signal);
          const cycle = list.cycles.find((c) => c.id === route.cycleId) ?? null;
          if (!cycle) {
            // Not an error page: a cycle that closed between one page and the
            // next is an ordinary thing, and the list says what is open now.
            setEligibility(null);
            setOpen(list);
          } else {
            const { form: def } = await publicApi.form(cycle.formDefinitionId, signal);
            setEligibility({
              cycle,
              form: def,
              turnstileSiteKey: list.turnstileSiteKey,
            });
          }
        } else if (route?.name === 'portal') {
          /*
           * BOTH READS, TOGETHER. An unanswered award and the reporting
           * schedule are the two things this page is about, and fetching them
           * in sequence would show the reports first and then push them down
           * the page as the offer arrives -- under somebody's thumb.
           */
          /*
           * THREE READS, TOGETHER. The two this page was always about -- an
           * unanswered award and the reporting schedule -- plus the open
           * cycles, which are public and are what makes "apply again" a
           * button rather than a path somebody has to be told.
           *
           * The cycles read is allowed to fail on its own. It is the least
           * important of the three, and a nonprofit should not lose sight of
           * a report that is due because the public cycle list had a bad
           * minute.
           */
          const [home, offers, cycles] = await Promise.all([
            granteeApi.home(signal),
            granteeApi.pendingAwards(signal),
            publicApi.cycles(signal).catch(() => ({ cycles: [] as OpenCycle[] })),
          ]);
          setPortal(home);
          setPendingAwards(offers.awards);
          setPortalCycles(cycles.cycles);
        } else if (route?.name === 'report') {
          setReport(await granteeApi.report(route.id, signal));
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        /*
         * An expired magic-link session is not an error page.
         *
         * Send them to the front door instead, with a real URL they can
         * reload. Rendering the sign-in form in place would mean rendering it
         * without the Turnstile site key -- which this route never loaded --
         * and a challenge-less form fails closed in production, locking out
         * exactly the person trying to get back in.
         */
        if (
          e instanceof ApiError &&
          e.isSignedOut &&
          route !== null &&
          EXTERNAL_SESSION_ROUTES.has(route.name)
        ) {
          navigate('/sign-in?expired=1');
          return;
        }
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [route, reloadKey, navigate]);

  if (route === null) {
    return (
      <Message title="Page not found">
        <p>There is nothing at this address.</p>
        <p>
          <a href="/">Go back to Steward</a>
        </p>
      </Message>
    );
  }

  if (error?.isSignedOut) {
    return (
      <Message title="Please sign in">
        <p>
          Your Cloudflare Access session has expired. Reloading this page will send you back
          through sign-in.
        </p>
        <p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload and sign in
          </button>
        </p>
      </Message>
    );
  }

  if (error) {
    return (
      <Message title="Something went wrong">
        <p>{error.message}</p>
        {error.requestId && (
          <p>
            Quote this reference to staff: <code>{error.requestId}</code>
          </p>
        )}
        <p>
          <button type="button" className="btn secondary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </p>
      </Message>
    );
  }

  if (loading) {
    return (
      <Message title="Loading">
        <p aria-live="polite">Loading…</p>
      </Message>
    );
  }

  if (route.name === 'signIn') {
    const hasOpenCycles = (open?.cycles.length ?? 0) > 0;
    return (
      <PortalShell organization={null} heading="Sign in">
        <SignIn
          turnstileSiteKey={open?.turnstileSiteKey ?? null}
          reason={new URLSearchParams(search).has('expired') ? 'expired' : null}
          onSeeOpenGrants={hasOpenCycles ? () => navigate('/apply') : undefined}
        />
      </PortalShell>
    );
  }

  if (route.name === 'publicGrants') {
    /*
     * NO PRELOAD in the effect above, unlike every other route. This page
     * fetches its own data, because it is the one screen that must render for
     * somebody who has never signed in and never will -- and routing it
     * through the shared loader would tie a public page to the session reads
     * the rest of the app does first.
     */
    return (
      <PortalShell organization={null} heading="Grants">
        <PublicGrants />
      </PortalShell>
    );
  }

  if (route.name === 'openCycles') {
    if (!open) return <Message title="Loading"><p>Loading…</p></Message>;
    return (
      <PortalShell organization={null} heading="Grants">
        <OpenCycles
          cycles={open.cycles}
          onStart={(c) => navigate(`/apply/start/${encodeURIComponent(c.id)}`)}
        />
      </PortalShell>
    );
  }

  if (route.name === 'eligibility') {
    if (!eligibility) {
      // The cycle closed, or the link is stale. Say so and show what is open.
      return (
        <PortalShell organization={null} heading="Grants">
          <div className="card portal-empty">
            <h2 tabIndex={-1} data-route-heading>
              That program is not open
            </h2>
            <p>
              It may have closed since this link was made. Anything currently accepting
              applications is listed on the grants page.
            </p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => navigate('/apply')}>
                See what is open
              </button>
            </div>
          </div>
        </PortalShell>
      );
    }
    return (
      <PortalShell organization={null} heading="Grants">
        <EligibilityForm
          cycle={eligibility.cycle}
          form={eligibility.form}
          turnstileSiteKey={eligibility.turnstileSiteKey}
          onBack={() => navigate('/apply')}
        />
      </PortalShell>
    );
  }

  if (route.name === 'portal') {
    if (!portal) return <Message title="Loading"><p>Loading…</p></Message>;
    return (
      <PortalShell organization={portal.organization.name}>
        {/*
          * ABOVE the reports, deliberately. The portal's rule is that the
          * outstanding thing is the first thing on the page with a button on
          * it, and an unanswered award is more outstanding than a report that
          * is not due for three months.
          */}
        <AwardOffer
          awards={pendingAwards}
          busy={offerBusy}
          error={offerError}
          onAccept={async (id, attestation) => {
            setOfferBusy(true);
            setOfferError(null);
            try {
              await granteeApi.acceptAward(id, attestation);
              // Re-read the whole portal, not just the offer list: accepting
              // generates the reporting schedule, and the reports section
              // below is now wrong.
              setReloadKey((k) => k + 1);
            } catch (e) {
              setOfferError(e instanceof ApiError ? e.message : String(e));
            } finally {
              setOfferBusy(false);
            }
          }}
          onDecline={async (id, reason) => {
            setOfferBusy(true);
            setOfferError(null);
            try {
              await granteeApi.declineAward(id, reason);
              setReloadKey((k) => k + 1);
            } catch (e) {
              setOfferError(e instanceof ApiError ? e.message : String(e));
            } finally {
              setOfferBusy(false);
            }
          }}
        />
        <GranteeHome
          data={portal}
          onOpenReport={(id) => navigate(`/reports/${encodeURIComponent(id)}`)}
        />
        {/*
          BELOW the grants and the reports, and that ordering is the portal's
          one rule: the outstanding thing is the first thing on the page with a
          button on it. An application already sent is not outstanding; a
          report due in three weeks is.

          It is here at all because there was no way out of this page. The
          shell carries no navigation -- correct when the portal was only a
          grantee's reporting page -- so a nonprofit signing in to reapply, or
          to check whether an application went through, reached a dead end and
          had to be sent a link.
        */}
        <PortalApplications
          applications={portal.applications ?? []}
          openCycles={portalCycles}
          onStartApplication={() => navigate('/apply')}
          onOpenApplication={(id) => navigate(`/apply/${encodeURIComponent(id)}`)}
          onContinue={async (cycleId) =>
            (await applicantApi.startApplication(cycleId)).application.id
          }
        />
      </PortalShell>
    );
  }

  if (route.name === 'report') {
    if (!report) return <Message title="Loading"><p>Loading…</p></Message>;
    return (
      <PortalShell organization={null}>
        <ReportForm data={report} onBack={() => navigate('/reports')} />
      </PortalShell>
    );
  }

  if (route.name === 'apply') {
    if (!draft) return <Message title="Loading"><p>Loading…</p></Message>;
    // An application that is no longer a draft is read-only. Rendering an
    // editable form over a submitted application would let somebody type for
    // an hour into answers the server will refuse.
    if (draft.application.status !== 'draft') {
      return (
        <Message title="This application has been submitted">
          <p>
            Submitted work cannot be changed. A copy of everything you sent was emailed to
            you when you submitted.
          </p>
        </Message>
      );
    }
    return (
      <FormRenderer
        def={draft.form}
        onBack={() => navigate('/')}
        draft={{ applicationId: draft.application.id, initialValues: draft.answers }}
      />
    );
  }

  if (route.name === 'form') {
    if (!form) return <Message title="Loading"><p>Loading…</p></Message>;
    return <FormRenderer def={form} onBack={() => navigate('/')} />;
  }

  if (!home) return <Message title="Loading"><p>Loading…</p></Message>;

  const toPipeline = () =>
    lastPipelineQuery.current ? `/pipeline?${lastPipelineQuery.current}` : '/pipeline';

  const shell = (children: ReactNode) => (
    <Shell
      user={home.user}
      active={route.name}
      themePref={themePref}
      resolvedTheme={resolvedTheme}
      onCycleTheme={cycleTheme}
      onNavigate={(path) => navigate(path === '/pipeline' ? toPipeline() : path)}
    >
      {children}
    </Shell>
  );

  if (route.name === 'application') {
    return shell(
      <ApplicationDetail
        applicationId={route.id}
        isAdmin={home.user.role === 'admin'}
        onBack={() => navigate(toPipeline())}
      />,
    );
  }

  if (route.name === 'dataHealth') {
    return shell(
      <DataHealth
        isAdmin={home.user.role === 'admin'}
        onNavigate={(path) => navigate(path)}
      />,
    );
  }

  if (route.name === 'dashboard') {
    return shell(<Dashboard />);
  }

  if (route.name === 'coverage') {
    const cycle = home.cycles.find((c) => c.id === route.cycleId);
    const program = home.programs.find((p) => p.id === cycle?.program_id);
    return shell(
      <ReviewCoverage
        cycleId={route.cycleId}
        cycleName={cycle ? `${program?.name ?? ''} ${cycle.name}`.trim() : 'This cycle'}
      />,
    );
  }

  if (route.name === 'scorecards') {
    return shell(
      <Scorecards cycleId={route.cycleId} onBack={() => navigate('/configuration')} />,
    );
  }

  if (route.name === 'communications') {
    return shell(
      <Communications cycleId={route.cycleId} onBack={() => navigate('/configuration')} />,
    );
  }

  if (route.name === 'reviewQueue') {
    return shell(
      <ReviewQueue
        onOpenSheet={(id) => navigate(`/my-reviews/${encodeURIComponent(id)}/score`)}
      />,
    );
  }

  if (route.name === 'scoringSheet') {
    return shell(
      <ScoringSheet
        assignmentId={route.assignmentId}
        onBack={() => navigate('/my-reviews')}
      />,
    );
  }

  if (route.name === 'rubrics') {
    const program = home.programs.find((p) => p.id === route.programId);
    return shell(
      <RubricBuilder
        programId={route.programId}
        programName={program?.name ?? 'this program'}
      />,
    );
  }

  if (route.name === 'retention') {
    return shell(<Retention isAdmin={home.user.role === 'admin'} />);
  }

  if (route.name === 'reporting') {
    return shell(
      <Reports
        programs={home.programs}
        isAdmin={home.user.role === 'admin'}
        query={search}
        onQueryChange={setPipelineQuery}
      />,
    );
  }

  if (route.name === 'pipeline') {
    return shell(
      <Pipeline
        programs={home.programs}
        cycles={home.cycles}
        query={search}
        onQueryChange={setPipelineQuery}
        onOpen={(id) => navigate(`/applications/${encodeURIComponent(id)}`)}
      />,
    );
  }

  return shell(
    <Home
      programs={home.programs}
      cycles={home.cycles}
      isAdmin={home.user.role === 'admin'}
      onChanged={() => setReloadKey((n) => n + 1)}
      forms={home.forms}
      onOpenForm={(id) => navigate(`/forms/${encodeURIComponent(id)}`)}
      onOpenRubrics={(id) => navigate(`/programs/${encodeURIComponent(id)}/rubrics`)}
      onOpenLetters={(id) => navigate(`/cycles/${encodeURIComponent(id)}/letters`)}
      onOpenScorecards={(id) => navigate(`/cycles/${encodeURIComponent(id)}/scorecards`)}
      onOpenCoverage={(id: string) => navigate(`/cycles/${encodeURIComponent(id)}/coverage`)}
    />,
  );
}

/**
 * The portal's frame.
 *
 * Deliberately not the internal Shell: there is no navigation here, because
 * there is nowhere else to go. A grantee's whole relationship with this system
 * is one page and the report they are filing from it, and a sidebar of links
 * they cannot use would only invite the question of what is behind them.
 */
function PortalShell({
  organization,
  children,
  heading,
}: {
  organization: string | null;
  children: ReactNode;
  /** What this surface is, when it is not a signed-in grantee's own page. */
  heading?: string;
}): ReactElement {
  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-inner">
          <h1>Houston Texans Foundation</h1>
          <span className="program">{organization ?? heading ?? 'Grant reporting'}</span>
        </div>
      </header>
      <div className="shell single">
        <main>{children}</main>
      </div>
    </div>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="state">
      <h1>{title}</h1>
      {children}
    </div>
  );
}
