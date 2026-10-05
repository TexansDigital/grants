import { describe, it, expect } from 'vitest';
import { refusalForRead, isProductionBucket, isBackupsBucket } from '../scripts/lib/buckets.mjs';

/**
 * THE GUARD THAT BLOCKED THE DRILL IT WAS WRITTEN TO PROTECT.
 *
 * pull-backup.mjs refused any bucket whose name contained "prod", so the
 * production restore drill -- the procedure in docs/RESTORE.md, the one thing
 * that turns a nightly export from a hypothesis into something somebody has
 * seen work -- could not be run at all. The runbook said to pass
 * --bucket=steward-production-backups and the script said no.
 *
 * It was found by following the runbook rather than by reading either file,
 * which is the whole argument for drilling a backup.
 *
 * The rule now follows what is IN the bucket. Both of these are production;
 * only one of them is somebody else's confidential documents.
 */
describe('which production buckets a local script may read', () => {
  it('allows the database export, because reading it is the drill', () => {
    expect(refusalForRead('steward-production-backups')).toBeNull();
  });

  it('refuses the files bucket, which holds applicants financial statements', () => {
    const r = refusalForRead('steward-production-files');
    expect(r).not.toBeNull();
    // The refusal has to say what to do instead, or the next person works
    // around it rather than understanding it.
    expect(r).toMatch(/financial statements/);
    expect(r).toMatch(/RESTORE\.md/);
  });

  it('leaves preview alone entirely', () => {
    expect(refusalForRead('steward-preview-backups')).toBeNull();
    expect(refusalForRead('steward-preview-files')).toBeNull();
  });

  it('does not let a name ending in -backups smuggle through a files bucket', () => {
    // The suffix is the test, not a substring: a bucket called
    // "steward-production-files-backups" would be a backups bucket, but
    // "steward-production-backups-files" must not pass.
    expect(isBackupsBucket('steward-production-backups-files')).toBe(false);
    expect(refusalForRead('steward-production-backups-files')).not.toBeNull();
  });

  it('knows production when it sees it', () => {
    expect(isProductionBucket('steward-production-backups')).toBe(true);
    expect(isProductionBucket('steward-PROD-backups')).toBe(true);
    expect(isProductionBucket('steward-preview-backups')).toBe(false);
  });
});
