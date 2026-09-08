/**
 * Theme preference for internal staff views.
 *
 * Three-state on purpose. "system" is the default and follows the operating
 * system, so someone who switches their laptop to light at 4pm gets a light
 * Steward without having been asked to configure anything. An explicit choice
 * is remembered and wins over the system.
 *
 * The applicant form is not covered by any of this. It is always light -- see
 * the note in theme.css.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'steward.theme.v1';

export function loadPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    // Storage disabled by policy or unavailable in a private window. Follow the
    // system rather than failing to render.
    return 'system';
  }
}

export function savePreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(KEY, pref);
  } catch {
    // A preference that cannot be remembered still applies for this session.
  }
}

/** Does the operating system currently ask for light? */
export function systemPrefersLight(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

export function resolveTheme(pref: ThemePreference, systemIsLight: boolean): ResolvedTheme {
  if (pref === 'system') return systemIsLight ? 'light' : 'dark';
  return pref;
}

/** Cycle order for the toggle: whatever you are on now, then the other, then back to system. */
export function nextPreference(pref: ThemePreference, resolved: ResolvedTheme): ThemePreference {
  if (pref === 'system') return resolved === 'dark' ? 'light' : 'dark';
  return 'system';
}

export function labelFor(pref: ThemePreference, resolved: ResolvedTheme): string {
  if (pref === 'system') return `Theme: system (${resolved})`;
  return `Theme: ${pref}`;
}
