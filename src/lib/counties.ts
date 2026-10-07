/**
 * County names, in one place, because this system stores them two ways.
 *
 * WHAT IS ACTUALLY TRUE, and 0028's header says otherwise -- that migration
 * claims `awards.counties_served_json` is "the same shape as
 * `applications.counties_served_json` ... so one reporting query can read both
 * tables without a translation layer". It is not, and I wrote that without
 * checking. An applied migration is never edited, so the correction lives here:
 *
 *   applications  the multi_select's OPTION VALUES, promoted by mapsTo.ts
 *                 through scalarFor, which returns value_json verbatim. For
 *                 Inspire Change that is ["harris","fort_bend"] -- slugs.
 *   awards        the names a person reads: ["Harris","Fort Bend"].
 *
 * They are reconcilable, which is the next best thing to identical, and this
 * module is the only place that knows how. Anything comparing counties across
 * the two tables goes through `countySlug`.
 *
 * WHY AWARDS HOLD THE READABLE FORM. An award's counties are typed or picked
 * by staff, not chosen from one program's option list, and they are rendered
 * on the grant page and in exports. Storing "st._marys_parish" and
 * de-slugifying it for display loses the apostrophe and the capital for ever;
 * storing the name loses nothing and costs one function here.
 */

import { TEXAS_COUNTIES } from '../data/texasCounties';

/**
 * A county name to the slug an application stores.
 *
 * Matches the transform the Inspire Change seed applies to its options:
 * lowercase, whitespace runs to single underscores.
 */
export function countySlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

/*
 * Lookup key: case, spacing, punctuation and a trailing "County" all ignored,
 * so "fort bend", "Fort Bend County", "FORT  BEND" and "fort_bend" are one
 * key. Deliberately NOT fuzzy -- "Ft Bend" is a different word and this does
 * not guess. The picker is what stops that being typed in the first place.
 */
function key(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+county$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

const CANONICAL = new Map<string, string>(TEXAS_COUNTIES.map((c) => [key(c), c]));

/**
 * The vocabulary's spelling of a county, or null when it is not one of the 254.
 *
 * Null is not an error. A program funding in Louisiana is a program this
 * platform has to run, and the counties field accepts whatever a grantmaker
 * types. This answers "is this a Texas county, and how is it spelled", nothing
 * more.
 */
export function canonicalCounty(input: string): string | null {
  return CANONICAL.get(key(input)) ?? null;
}

/**
 * Tidy a list of counties for storage: canonical spelling where the name is a
 * Texas county, the person's own words where it is not, de-duplicated.
 *
 * This is what turns "harris", "Harris County" and "HARRIS" into one row in a
 * report instead of three.
 */
export function canonicalCountyList(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const name = raw.trim();
    if (name === '') continue;
    const canonical = canonicalCounty(name) ?? name;
    const k = key(canonical);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(canonical);
  }
  return out;
}

/** Is this one of the 254? Offered to a screen that wants to flag the rest. */
export function isTexasCounty(input: string): boolean {
  return canonicalCounty(input) !== null;
}
