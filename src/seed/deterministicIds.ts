/**
 * Deterministic identifiers for seeded rows.
 *
 * Seeding must be re-runnable. With random ids, running the seed twice creates
 * a second copy of every program, stage, section and field, and there is no way
 * to clean it up: nothing is hard-deleted and `audit_log` is append-only, so a
 * bad seed is PERMANENT in the target database.
 *
 * Deriving each id from a stable path (`inspire-change/field/ein`) means a
 * second run produces the same ids, so it collides with the rows already there
 * and is refused rather than silently duplicating.
 *
 * These are ordinary opaque ids, formatted the same as the random ones so the
 * shape of an id never tells you how a row was created.
 */

/**
 * FNV-1a, 32-bit. Not cryptographic, and deliberately so: this needs to be
 * synchronous, stable across runtimes and versions, and identical every time.
 * `crypto.subtle` is async and would force the whole seed path to be async for
 * no benefit.
 */
function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

/**
 * A stable id for a seeded row.
 *
 * `path` must uniquely identify the row within the seed, e.g.
 * `inspire-change/stage/application/field/ein`. Four independently seeded
 * hashes give 128 bits, formatted as a UUID so seeded and runtime ids are
 * indistinguishable.
 */
export function seededId(path: string): string {
  const a = hex8(fnv1a(path, 0x811c9dc5));
  const b = hex8(fnv1a(path, 0x1000193));
  const c = hex8(fnv1a(path, 0x9e3779b9));
  const d = hex8(fnv1a(path, 0x85ebca6b));
  const raw = `${a}${b}${c}${d}`;
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20, 32),
  ].join('-');
}

/**
 * An id factory. `seedProgram` takes one so the same code path produces random
 * ids at runtime and deterministic ids when seeding.
 */
export type IdFactory = (path: string) => string;

/** Deterministic factory, namespaced to one seed run. */
export function deterministicIds(namespace: string): IdFactory {
  return (path: string) => seededId(`${namespace}/${path}`);
}
