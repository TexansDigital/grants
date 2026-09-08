import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

/**
 * Tests run inside a real Workers runtime (workerd) against a real local D1,
 * with the real migrations applied from empty. Not a mock, not better-sqlite3:
 * the point of this suite is to prove the migrations and the SQL work where
 * they will actually run.
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
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
