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
import type { CycleRow, FormSummary, ProgramRow, SessionUser } from './api';
import type { FormDefinition } from '../../src/lib/forms';
import { Home } from './Home';
import { FormRenderer } from './FormRenderer';
import { Pipeline } from './Pipeline';
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
  | { name: 'form'; id: string };

function parseRoute(pathname: string): Route | null {
  const parts = pathname.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) return { name: 'pipeline' };
  if (parts.length === 1 && parts[0] === 'configuration') return { name: 'home' };
  if (parts.length === 1 && parts[0] === 'pipeline') return { name: 'pipeline' };
  if (parts.length === 2 && parts[0] === 'applications' && parts[1]) {
    return { name: 'application', id: parts[1] };
  }
  if (parts.length === 2 && parts[0] === 'forms' && parts[1]) return { name: 'form', id: parts[1] };
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
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [themePref, setThemePref] = useState<ThemePreference>(loadPreference);
  const [systemIsLight, setSystemIsLight] = useState(systemPrefersLight);

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
    const internal = route?.name !== 'form';
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
      form: 'Form preview · Steward',
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
        if (route?.name === 'home' || route?.name === 'pipeline' || route?.name === 'application') {
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
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [route]);

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
      forms={home.forms}
      onOpenForm={(id) => navigate(`/forms/${encodeURIComponent(id)}`)}
    />,
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
