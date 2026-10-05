/**
 * Types for buckets.mjs.
 *
 * The module itself is plain JavaScript because scripts/ is run by node
 * directly, with no build step -- a .ts file there would need compiling before
 * a runbook command could use it, and a runbook command that needs a build
 * step is one more thing to get wrong on the day somebody is restoring a
 * database. The declarations live beside it so the test suite still typechecks.
 */
export function isBackupsBucket(bucket: string): boolean;
export function isProductionBucket(bucket: string): boolean;
export function refusalForRead(bucket: string): string | null;
