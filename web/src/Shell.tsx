/**
 * The internal chrome: masthead, primary navigation, theme toggle.
 *
 * THE NAVIGATION IS TWO LISTS, not one, and that is the whole point of this
 * file. It reached twelve items and wrapped onto a second line, at which stage
 * a navigation stops being a map and becomes a search problem -- the reader
 * scans every label every time, because nothing tells them which few matter.
 *
 * So the bar carries only what this Foundation touches week to week, and
 * everything else lives behind one "More" button. The split is by HOW OFTEN
 * somebody goes there, not by what the code calls it:
 *
 *   Bar     -- To do, Grants, Organizations, Applications, Impact, Results
 *   More    -- My reviews, Data health, Retention, Programs
 *
 * AND IT DIFFERS BY ROLE, because "rarely used" is a fact about a person. A
 * reviewer's only screen is My reviews; burying it would be the same mistake
 * in the other direction. So it is promoted into the bar for a reviewer and
 * tucked into More for an admin, who visits it during a cycle and not
 * otherwise.
 *
 * TWO SECTIONS HAVE A SECOND VIEW RATHER THAN A SECOND TAB. Reporting is the
 * same subject as Grants at a different grain -- grants, and what those grants
 * owe -- and the past-grantee claims queue is the same subject as
 * Organizations. Each is a sub-navigation inside its section instead of a
 * top-level entry, which is two fewer things to scan and a truer description
 * of what they are.
 */

import { useEffect, useId, useRef, useState } from 'react';
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

interface NavItem {
  path: string;
  label: string;
  /** The route name this entry owns, plus any that live inside its section. */
  routes: string[];
  adminOnly?: boolean;
  /** In the bar for an admin, or behind More. */
  primary: boolean;
  /** Promoted into the bar for a reviewer, whose work this is. */
  primaryForReviewer?: boolean;
}

const NAV: NavItem[] = [
  /*
   * FIRST, and the landing page. Everything else here is a place to go
   * looking; this is the only one that tells you whether you needed to.
   */
  { path: '/to-do', label: 'To do', routes: ['toDo'], primary: true, primaryForReviewer: true },
  /*
   * Grants and Organizations: the two nouns this Foundation works in. Each
   * owns a second view -- the compliance desk under Grants, the claims queue
   * under Organizations -- so being on either highlights its section here.
   */
  {
    path: '/awards',
    label: 'Grants',
    routes: ['awardsList', 'award', 'reporting'],
    adminOnly: true,
    primary: true,
  },
  {
    path: '/organizations',
    label: 'Organizations',
    routes: ['organizationsList', 'organization', 'granteeClaims'],
    adminOnly: true,
    primary: true,
  },
  /*
   * "Applications", not "Pipeline". A pipeline is a word about the system;
   * applications are the thing on the screen, and the person reading this nav
   * is looking for the latter.
   */
  {
    path: '/pipeline',
    label: 'Applications',
    routes: ['pipeline', 'application'],
    primary: true,
    primaryForReviewer: true,
  },
  { path: '/impact', label: 'Impact', routes: ['impact'], adminOnly: true, primary: true },
  /*
   * "Results", not "Dashboard". Nobody goes looking for a dashboard; they go
   * looking for how the program did.
   */
  { path: '/dashboard', label: 'Results', routes: ['dashboard'], adminOnly: true, primary: true },

  // ---- behind More ---------------------------------------------------------
  /*
   * Shown to everyone with a staff session, admins included: an admin who is
   * also assigned as a reviewer needs somewhere to do that work. Primary for a
   * reviewer, for whom it is the whole job.
   */
  {
    path: '/my-reviews',
    label: 'My reviews',
    routes: ['reviewQueue', 'scoringSheet'],
    primary: false,
    primaryForReviewer: true,
  },
  { path: '/data-health', label: 'Data health', routes: ['dataHealth'], adminOnly: true, primary: false },
  { path: '/retention', label: 'Retention', routes: ['retention'], adminOnly: true, primary: false },
  /*
   * "Programs", not "Configuration". It is where a program, its cycles, its
   * forms and its rubrics are set up -- which is a subject, not a settings
   * screen, and calling it settings is why nobody could guess what was in it.
   */
  { path: '/configuration', label: 'Programs', routes: ['home', 'rubrics'], primary: false },
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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  /*
   * A menu that cannot be dismissed is a trap. Both exits are here because a
   * mouse user reaches for the background and a keyboard user reaches for
   * Escape, and a menu that answers only one of them is broken for the other.
   */
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setMoreOpen(false);
      /*
       * Focus goes back to the button that opened it. Without this a keyboard
       * user who tabbed into the menu and pressed Escape is dropped on
       * <body>, which is the same as being lost.
       */
      toggleRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const visible = NAV.filter((item) => !item.adminOnly || user.role === 'admin');
  const inBar = (item: NavItem): boolean =>
    user.role === 'reviewer' ? (item.primaryForReviewer ?? false) : item.primary;

  let bar = visible.filter(inBar);
  let more = visible.filter((item) => !inBar(item));
  /*
   * A ONE-ITEM MENU IS WORSE THAN THE ITEM. It costs a click and a guess to
   * reach something that would have fitted in the space the "More" button
   * occupies. A reviewer hit this exactly: everything they can see is their
   * daily work except Programs, so they were offered a dropdown containing
   * one entry.
   */
  if (more.length === 1) {
    bar = [...bar, ...more];
    more = [];
  }
  const current = (item: NavItem): boolean => item.routes.includes(active);
  /*
   * The More button is marked current when the open screen lives inside it.
   * Without this, opening Retention leaves nothing in the bar highlighted and
   * the reader has no idea where they are.
   */
  const moreHoldsCurrent = more.some(current);

  return (
    <div className="page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="masthead">
        <div className="masthead-inner">
          {/* Decorative, as on the applicant masthead: the product is named in
              the h1 beside it. */}
          <img className="mark" src="/bullhead.png" alt="" aria-hidden="true" />
          <h1>Steward</h1>
          <nav className="mainnav" aria-label="Sections">
            {bar.map((item) => (
              <button
                key={item.path}
                type="button"
                // `page`, not `true`: the section IS the current page, and
                // screen readers announce it that way.
                aria-current={current(item) ? 'page' : undefined}
                onClick={() => onNavigate(item.path)}
              >
                {item.label}
              </button>
            ))}

            {more.length > 0 ? (
              <div className="navmore" ref={moreRef}>
                {/*
                  NO aria-haspopup, and NOT aria-current.

                  `aria-haspopup="true"` means "menu", and the panel below is
                  a plain group of buttons with no role="menu" and no arrow
                  keys -- promising behaviour that is not there is worse than
                  promising nothing. It is a disclosure, and aria-expanded /
                  aria-controls say so correctly.

                  And marking the toggle aria-current="page" put TWO current
                  controls in one nav whenever the menu was open: this one and
                  the item inside it. The visual mark moves to a data
                  attribute, which the stylesheet keys on beside the real one.
                */}
                <button
                  type="button"
                  ref={toggleRef}
                  className="navmore-toggle"
                  aria-expanded={moreOpen}
                  aria-controls={menuId}
                  data-section-current={moreHoldsCurrent ? 'true' : undefined}
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  More
                  <span aria-hidden="true" className="navmore-caret">
                    ▾
                  </span>
                </button>
                {moreOpen ? (
                  <div className="navmore-menu" id={menuId}>
                    {more.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        aria-current={current(item) ? 'page' : undefined}
                        onClick={() => {
                          setMoreOpen(false);
                          onNavigate(item.path);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
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

/**
 * The second view inside a section.
 *
 * Grants and its compliance desk are the same subject at two grains, as are
 * Organizations and the queue of people claiming a past grant. Making each of
 * those a top-level tab said they were unrelated, and cost two slots in a bar
 * that had already run out.
 */
export function SectionNav({
  items,
  active,
  onNavigate,
}: {
  items: { path: string; label: string; route: string }[];
  active: string;
  onNavigate: (path: string) => void;
}): ReactElement {
  return (
    <nav className="sectionnav" aria-label="Views">
      {items.map((item) => (
        <button
          key={item.path}
          type="button"
          aria-current={active === item.route ? 'page' : undefined}
          onClick={() => onNavigate(item.path)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
