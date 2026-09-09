declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    FILES: R2Bucket;
    SESSIONS: KVNamespace;
    ENVIRONMENT: string;
    DISPLAY_TIMEZONE: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

/**
 * Raw text imports.
 *
 * test/configCheck.test.ts imports the real wrangler.toml as a string so the
 * config guards are exercised against the actual file rather than a fixture
 * shaped to suit them. Vite resolves `?raw`; TypeScript needs telling.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
