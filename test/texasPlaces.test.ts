import { describe, it, expect } from 'vitest';
import { TEXAS_COUNTIES } from '../src/data/texasCounties';
import { TEXAS_CITY_COUNTIES } from '../src/data/texasCities';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';

/**
 * The place vocabulary.
 *
 * WHY PIN GENERATED DATA. These files are rebuilt by a script nobody will run
 * for a year, from packages that will have moved on. The checks below are the
 * things that must stay true however it is regenerated -- not a copy of the
 * contents, which would be a second place to maintain the same list.
 *
 * The one that earns its place above all the others is the last: the Inspire
 * Change form's eighteen counties have to BE Texas counties, spelled the way
 * the vocabulary spells them. That list was typed by hand in a seed file, and
 * nothing has ever checked it.
 */

describe('the Texas place vocabulary', () => {
  it('has every county and only counties', () => {
    expect(TEXAS_COUNTIES).toHaveLength(254);
    expect(new Set(TEXAS_COUNTIES).size).toBe(254);
  });

  it('writes them without the suffix, as this project always has', () => {
    expect(TEXAS_COUNTIES.filter((c) => /\bCounty$/.test(c))).toEqual([]);
    expect(TEXAS_COUNTIES).toContain('Fort Bend');
    expect(TEXAS_COUNTIES).toContain('Harris');
  });

  /*
   * THE TWO THE ZIP DATA SPELLS WRONG. It carries "De Witt" and "Mclennan";
   * the Census carries DeWitt and McLennan. The generator canonicalises to the
   * Census spelling and refuses to emit anything it cannot resolve, so these
   * two are the proof that the reconciliation ran.
   */
  it('carries the Census spelling of the two that are usually got wrong', () => {
    expect(TEXAS_COUNTIES).toContain('DeWitt');
    expect(TEXAS_COUNTIES).toContain('McLennan');
    expect(TEXAS_COUNTIES).not.toContain('De Witt');
    expect(TEXAS_COUNTIES).not.toContain('Mclennan');
  });

  it('is sorted, so a picker does not have to be', () => {
    expect([...TEXAS_COUNTIES]).toEqual([...TEXAS_COUNTIES].sort());
  });

  /* ---- cities ----------------------------------------------------------- */

  it('maps a city that spans three counties to all three', () => {
    // The case the whole file exists for. A nonprofit says it serves Katy;
    // picking one county would be picking the wrong one two times in three.
    expect(TEXAS_CITY_COUNTIES['Katy']).toEqual(['Fort Bend', 'Harris', 'Waller']);
  });

  it('names a county for every city, and only real ones', () => {
    const known = new Set(TEXAS_COUNTIES);
    const bad: string[] = [];
    for (const [city, counties] of Object.entries(TEXAS_CITY_COUNTIES)) {
      if (counties.length === 0) bad.push(`${city}: none`);
      for (const c of counties) if (!known.has(c)) bad.push(`${city}: ${c}`);
    }
    expect(bad).toEqual([]);
  });

  it('covers the big ones', () => {
    expect(TEXAS_CITY_COUNTIES['Houston']).toContain('Harris');
    expect(TEXAS_CITY_COUNTIES['Austin']).toContain('Travis');
    expect(TEXAS_CITY_COUNTIES['Sugar Land']).toContain('Fort Bend');
  });

  /* ---- and the seed that nothing has ever checked ------------------------ */

  /*
   * THE CHECK WORTH HAVING. Greater Houston's eighteen counties were typed by
   * hand into the Inspire Change seed and have never been verified against
   * anything. One typo there is an option a nonprofit selects, promoted into
   * `counties_served_json`, and then quietly matching nothing for ever.
   */
  it('agrees with the counties the Inspire Change form offers', () => {
    // Across every stage, because the counties question lives on the
    // eligibility screen and a second program could put it anywhere.
    const field = INSPIRE_CHANGE.stages
      .flatMap((stage) => stage.form.sections)
      .flatMap((section) => section.fields)
      .find((f) => f.mapsTo === 'counties_served');
    expect(field, 'the eligibility form still has a counties field').toBeTruthy();
    /*
     * THE OPTIONS ARE {value, label} PAIRS, not bare strings: the value is a
     * slug ("fort_bend") and the label is "Fort Bend County". That matters
     * beyond this assertion -- an application promotes the VALUE into
     * `counties_served_json`, so what an application stores and what an award
     * stores are not the same strings. See awardSubject.ts.
     */
    const offered = (field!.options ?? []) as { value: string; label: string }[];
    expect(offered.length).toBeGreaterThan(0);
    const known = new Set(TEXAS_COUNTIES);
    const names = offered.map((o) => o.label.replace(/ County$/, ''));
    expect(names.filter((c) => !known.has(c))).toEqual([]);
    // And the slug is derivable from the name, which is what lets the two
    // storage formats be reconciled at all.
    expect(offered.map((o) => o.value)).toEqual(
      names.map((n) => n.toLowerCase().replace(/\s+/g, '_')),
    );
  });
});
