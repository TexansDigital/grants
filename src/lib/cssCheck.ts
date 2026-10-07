/**
 * Find CSS custom properties a stylesheet reads but nothing defines.
 *
 * WHY THIS EXISTS. `.danger-row` set `border-top: 1px solid var(--rule)` and
 * `--rule` is defined nowhere in this project. CSS drops the WHOLE declaration
 * when a var() inside it resolves to nothing, so that rule had never rendered
 * -- on the compliance desk or on the applicant form, which share the class.
 * Two more turned up the moment I swept for the pattern: `.storage-usage` and
 * `.request-updates` both set `border-left: 3px solid var(--accent)`, and
 * `--accent` does not exist either, so neither ever had the accent bar that is
 * the entire point of the treatment. One of those is the panel that writes
 * report obligations against other organizations' grants, whose own comment
 * says it "should not look like the rest of the page's furniture".
 *
 * None of it is a syntax error. Nothing logs. The typechecker has no opinion.
 * It is visible only by looking at the right pixel, which is why it stayed
 * shipped for months.
 *
 * Pure, with no fs, so the test suite can exercise it on strings.
 *
 * A var() WITH a fallback is deliberately allowed:
 * `var(--line-control-hover, var(--line-control))` is an extension point with
 * a working default, not a hole.
 */

export interface CssTokenProblem {
  sheet: string;
  token: string;
  /** 1-based, so a person can go straight to it. */
  line: number;
  context: string;
}

const DECLARED = /(--[a-z0-9-]+)\s*:/g;
/* A read with no fallback: `var(--x)` rather than `var(--x, something)`. */
const READ_NO_FALLBACK = /var\(\s*(--[a-z0-9-]+)\s*\)/g;

export function cssTokenProblems(sheets: readonly { name: string; body: string }[]): CssTokenProblem[] {
  const declared = new Set<string>();
  for (const { body } of sheets) {
    for (const m of body.matchAll(DECLARED)) declared.add(m[1] as string);
  }

  const problems: CssTokenProblem[] = [];
  for (const { name, body } of sheets) {
    const lines = body.split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(READ_NO_FALLBACK)) {
        const token = m[1] as string;
        if (declared.has(token)) continue;
        problems.push({ sheet: name, token, line: i + 1, context: text.trim() });
      }
    });
  }
  return problems;
}
