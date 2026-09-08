/**
 * The internal chrome: masthead, primary navigation, theme toggle.
 *
 * Extracted from Home the moment there was more than one internal screen. The
 * navigation is a real <nav> with aria-current, so a screen reader announces
 * which section you are in rather than reading four identical links.
 */

import type { ReactElement, ReactNode } from 'react';
import type { SessionUser } from './api';
import { labelFor, type ResolvedTheme, type ThemePreference } from './theme';

interface Props {
  user: SessionUser;
  active: string;
  themePref: ThemePreference;
  resolvedTheme: ResolvedTheme;
  onCycleTheme: () => void;
  onNavigate: (path: string) => void;
  children: ReactNode;
}

const NAV: { path: string; label: string; route: string }[] = [
  { path: '/pipeline', label: 'Pipeline', route: 'pipeline' },
  { path: '/configuration', label: 'Configuration', route: 'home' },
];

export function Shell({
  user,
  active,
  themePref,
  resolvedTheme,
  onCycleTheme,
  onNavigate,
  children,
}: Props): ReactElement {
  return (
    <div className="page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="masthead">
        <div className="masthead-inner">
          <h1>Steward</h1>
          <nav className="mainnav" aria-label="Sections">
            {NAV.map((item) => (
              <button
                key={item.path}
                type="button"
                // `page`, not `true`: the section IS the current page, and
                // screen readers announce it that way.
                aria-current={
                  active === item.route || (item.route === 'pipeline' && active === 'application')
                    ? 'page'
                    : undefined
                }
                onClick={() => onNavigate(item.path)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <span className="spacer" />
          <span className="program">
            {user.email} · {user.role}
          </span>
          <button type="button" className="theme-toggle" onClick={onCycleTheme}>
            {labelFor(themePref, resolvedTheme)}
          </button>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="wide">
        {children}
      </main>
    </div>
  );
}
