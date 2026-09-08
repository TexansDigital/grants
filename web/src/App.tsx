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

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ApiError, api } from './api';
import type { CycleRow, FormSummary, ProgramRow, SessionUser } from './api';
import type { FormDefinition } from '../../src/lib/forms';
import { Home } from './Home';
import { FormRenderer } from './FormRenderer';

type Route = { name: 'home' } | { name: 'form'; id: string };

function parseRoute(pathname: string): Route | null {
  const parts = pathname.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) return { name: 'home' };
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

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setRoute(parseRoute(path));
  }, []);

  // Back and forward have to work. An applicant who presses Back and lands on a
  // blank page assumes they lost their answers.
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The applicant form is light; staff views are dark. See web/src/theme.css.
  useEffect(() => {
    const internal = route?.name !== 'form';
    document.documentElement.dataset.surface = internal ? 'internal' : 'applicant';
  }, [route]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setError(null);
    setLoading(true);

    (async () => {
      try {
        if (route?.name === 'home') {
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
  return (
    <Home
      user={home.user}
      programs={home.programs}
      cycles={home.cycles}
      forms={home.forms}
      onOpenForm={(id) => navigate(`/forms/${encodeURIComponent(id)}`)}
    />
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
