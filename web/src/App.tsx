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
import { EligibilityForm } from './EligibilityForm';
import { granteeApi, type GranteeHomeResponse, type ReportResponse } from './granteeApi';
import { GranteeHome } from './GranteeHome';
import { ReportForm } from './ReportForm';
import { Home } from './Home';
import { FormRenderer } from './FormRenderer';
import { Pipeline } from './Pipeline';
import { Reports } from './Reports';
import { DataHealth } from './DataHealth';
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
  | { name: 'openCycles' }
  | { name: 'eligibility'; cycleId: string }
  | { name: 'portal' }
  | { name: 'report'; id: string };

function parseRoute(pathname: string): Route | null {
  const parts = pathname.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) return { name: 'pipeline' };
  if (parts.length === 1 && parts[0] === 'configuration') return { name: 'home' };
  if (parts.length === 1 && parts[0] === 'pipeline') return { name: 'pipeline' };
  // The staff compliance desk. NOT /reports, which is the grantee portal --
  // two different audiences must never share a path.
  if (parts.length === 1 && parts[0] === 'reporting') return { name: 'reporting' };
  if (parts.length === 1 && parts[0] === 'data-health') return { name: 'dataHealth' };
  if (parts.length === 2 && parts[0] === 'applications' && parts[1]) {
    return { name: 'application', id: parts[1] };
  }
  if (parts.length === 2 && parts[0] === 'forms' && parts[1]) return { name: 'form', id: parts[1] };
  // The public front door. Checked BEFORE /apply/:id, because "start" is not
  // an application id and the three-segment path is the more specific match.
  if (parts.length === 1 && parts[0] === 'apply') return { name: 'openCycles' };
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
      route?.name === 'eligibility' ||
      route?.name === 'portal' ||
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
          route?.name === 'dataHealth'
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
        } else if (route?.name === 'openCycles') {
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
          setPortal(await granteeApi.home(signal));
        } else if (route?.name === 'report') {
          setReport(await granteeApi.report(route.id, signal));
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [route, reloadKey]);

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
        <GranteeHome
          data={portal}
          onOpenReport={(id) => navigate(`/reports/${encodeURIComponent(id)}`)}
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
