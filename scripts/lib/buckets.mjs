/**
 * Which buckets a local script may read, and why the answer is not "no
 * production, ever".
 *
 * CLAUDE.md's non-negotiable is that nothing WRITES to the production database
 * or bucket. Reading is a different act, and conflating the two broke the one
 * production operation this project actually requires: the restore drill in
 * docs/RESTORE.md exists to pull the real nightly export and prove it restores,
 * and pull-backup.mjs refused to do it. A backup nobody can read is not a
 * backup, and a guard that blocks the drill protects nothing while costing the
 * only thing that makes an export trustworthy.
 *
 * So the line is drawn by WHAT IS IN THE BUCKET, not by its name:
 *
 *   steward-production-backups  — a database export. Reading it is the drill.
 *                                 Allowed, loudly.
 *   steward-production-files    — applicants' audited financial statements and
 *                                 operating budgets. Pulling those onto a
 *                                 laptop is a real exposure with no drill to
 *                                 justify it. Refused.
 *
 * Both are production. Only one of them is somebody else's confidential
 * documents.
 */

/** True when this bucket holds database exports rather than uploaded files. */
export function isBackupsBucket(bucket) {
  return /-backups$/.test(String(bucket));
}

/** True when this bucket is a production resource. */
export function isProductionBucket(bucket) {
  return /prod/i.test(String(bucket));
}

/**
 * The reason to refuse reading this bucket, or null to allow it.
 *
 * Returns a sentence rather than a boolean so the caller prints something a
 * human can act on instead of "refused".
 */
export function refusalForRead(bucket) {
  if (isProductionBucket(bucket) && !isBackupsBucket(bucket)) {
    return (
      `refusing to read "${bucket}". That is a production bucket that is not a ` +
      'database export -- it holds applicants\' financial statements, and ' +
      'pulling those onto a laptop is an exposure with nothing to justify it. ' +
      'Only a *-backups bucket can be read from production, and only for the ' +
      'restore drill in docs/RESTORE.md.'
    );
  }
  return null;
}
