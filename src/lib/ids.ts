/**
 * Identifier generation.
 *
 * Ids are opaque UUIDv4 strings. They are not sequential, so an id in a URL
 * leaks nothing about volume and cannot be walked. Scoping still does the real
 * work of access control; unguessable ids are defence in depth, not the fence.
 */
export function newId(): string {
  return crypto.randomUUID();
}

/** Stable request id used to correlate audit rows, error rows, and logs. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
