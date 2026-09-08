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
