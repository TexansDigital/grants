import { applyD1Migrations, env } from 'cloudflare:test';

/**
 * Definition of done #1: migrations run clean from EMPTY on a fresh database.
 * Every test file gets a database built only by the numbered migrations in
 * /migrations, in order. There is no separate test schema to drift from prod.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
