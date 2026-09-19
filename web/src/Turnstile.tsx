/**
 * The Turnstile widget.
 *
 * Renders nothing when there is no site key, which mirrors the server exactly:
 * verifyTurnstile skips outside production when the secret is unset and fails
 * closed in production. If these two disagreed, preview would show a challenge
 * nobody can pass, or production would accept a form with no protection.
 *
 * The script is loaded on demand rather than in index.html. It is a
 * third-party script on a page nonprofits fill in with financial statements;
 * loading it only where it is actually used is the smaller surface.
 */

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'light' | 'dark' | 'auto';
    },
  ) => string;
  remove: (id: string) => void;
}

/** Declared structurally: no global type from a script we load ourselves. */
function turnstileApi(): TurnstileApi | null {
  const t = (globalThis as { turnstile?: TurnstileApi }).turnstile;
  return t && typeof t.render === 'function' ? t : null;
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (turnstileApi()) return Promise.resolve();
  // One load per page, however many widgets ask for it.
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever.
      scriptPromise = null;
      reject(new Error('turnstile script failed to load'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

interface Props {
  siteKey: string | null;
  /** Called with a fresh token, or null when it expires or errors. */
  onToken: (token: string | null) => void;
}

export function Turnstile({ siteKey, onToken }: Props): ReactElement | null {
  const host = useRef<HTMLDivElement>(null);
  // Held in a ref so the effect does not re-run when the callback identity
  // changes, which would tear down and re-render the widget mid-challenge.
  const notify = useRef(onToken);
  notify.current = onToken;

  useEffect(() => {
    if (!siteKey || !host.current) return undefined;
    let widgetId: string | null = null;
    let cancelled = false;
    const el = host.current;

    void loadScript()
      .then(() => {
        const api = turnstileApi();
        if (cancelled || !api) return;
        widgetId = api.render(el, {
          sitekey: siteKey,
          theme: 'light',
          callback: (token) => notify.current(token),
          'expired-callback': () => notify.current(null),
          'error-callback': () => notify.current(null),
        });
      })
      .catch(() => {
        /*
         * The script did not load. Say nothing here and let the SERVER decide.
         *
         * Blocking submit in the browser would turn "an ad blocker ate a
         * third-party script" into "this nonprofit cannot apply". The server
         * rejects a missing token in production and skips outside it, which is
         * the decision that counts either way.
         */
        if (!cancelled) notify.current(null);
      });

    return () => {
      cancelled = true;
      const api = turnstileApi();
      if (widgetId && api) api.remove(widgetId);
    };
  }, [siteKey]);

  if (!siteKey) return null;
  return <div className="turnstile" ref={host} aria-hidden="true" />;
}
