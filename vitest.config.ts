import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

/**
 * Tests run inside a real Workers runtime (workerd) against a real local D1,
 * with the real migrations applied from empty. Not a mock, not better-sqlite3:
 * the point of this suite is to prove the migrations and the SQL work where
 * they will actually run.
 *
 * THE SUITE MUST NOT DEPEND ON AN UNTRACKED FILE. miniflare is pointed at
 * wrangler.toml below, which also makes it read `.dev.vars` -- and `.dev.vars`
 * is gitignored, correctly, because it holds secrets. The consequence was a
 * suite that passed on one machine and failed 56 tests on a clean checkout of
 * the same commit, in three files at once, all with the same 403. It looks
 * exactly like a code regression and it stopped a deploy.
 *
 * So anything the tests need in order to run is declared HERE, in version
 * control, and `.dev.vars` is left to hold only real credentials.
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));

  return {
    test: {
      setupFiles: ['./test/applyMigrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              /*
               * Turnstile cannot be solved by a test, and verifyTurnstile
               * fails closed without a secret -- which is the right posture
               * for a public form and the wrong one for a test runner. This
               * is the same opt-out the public endpoints' own tests set by
               * hand; declaring it once here is what stops it depending on
               * whether a particular laptop has a `.dev.vars`.
               *
               * SAFE, and guarded twice over independently of this file:
               * verifyTurnstile refuses the opt-out outright when
               * ENVIRONMENT === 'production', and checkConfig fails the build
               * if TURNSTILE_OPTIONAL ever appears in the production block of
               * wrangler.toml. The tests that prove the fail-closed behaviour
               * set it back to undefined on their own env, so this does not
               * weaken them.
               */
              TURNSTILE_OPTIONAL: '1',
            },
          },
        },
      },
    },
  };
});
