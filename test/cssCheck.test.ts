import { describe, it, expect } from 'vitest';
import { cssTokenProblems } from '../src/lib/cssCheck';

/**
 * The checker that found three dropped declarations.
 *
 * Exercised on strings rather than on the real stylesheets, and that is not
 * laziness: importing CSS with `?raw` inside this suite returns an EMPTY
 * STRING under vitest-pool-workers, so the first version of this file asserted
 * happily against nothing. The real sheets are checked by `npm run check:css`,
 * in Node, where files exist. This pins the logic.
 */
describe('cssTokenProblems', () => {
  it('finds a property nothing defines', () => {
    const out = cssTokenProblems([
      { name: 'a.css', body: ':root { --line: #ccc; }\n.x { border-top: 1px solid var(--rule); }' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sheet: 'a.css', token: '--rule', line: 2 });
    // The line is quoted back, because "--rule is undefined" without the
    // declaration it kills is a puzzle rather than a bug report.
    expect(out[0]?.context).toContain('border-top');
  });

  it('allows a read that carries its own fallback', () => {
    // `var(--x, var(--y))` is an extension point with a working default. The
    // declaration still renders, so it is not a hole.
    expect(
      cssTokenProblems([
        { name: 'a.css', body: ':root { --b: #000; }\n.x { color: var(--hover, var(--b)); }' },
      ]),
    ).toEqual([]);
  });

  it('counts a definition in any sheet, not only the one reading it', () => {
    // theme.css declares; internal.css reads. Treating sheets separately would
    // report every token in the project as missing.
    expect(
      cssTokenProblems([
        { name: 'theme.css', body: ':root { --blue: #0080c6; }' },
        { name: 'internal.css', body: '.x { border-left: 3px solid var(--blue); }' },
      ]),
    ).toEqual([]);
  });

  it('reports every bad read, not just the first', () => {
    const out = cssTokenProblems([
      {
        name: 'a.css',
        body: '.x { border-left: 3px solid var(--accent); }\n.y { color: var(--accent); }',
      },
    ]);
    expect(out.map((p) => p.line)).toEqual([1, 2]);
  });

  it('is not fooled by a definition appearing later in the file', () => {
    // CSS custom properties are not order-dependent the way this checker reads
    // them, and neither is the cascade for :root tokens.
    expect(
      cssTokenProblems([
        { name: 'a.css', body: '.x { color: var(--late); }\n:root { --late: red; }' },
      ]),
    ).toEqual([]);
  });

  it('ignores a property name inside a declaration, which is a definition', () => {
    expect(cssTokenProblems([{ name: 'a.css', body: ':root { --only-defined: 1px; }' }])).toEqual([]);
  });
});
