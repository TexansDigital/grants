declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    FILES: R2Bucket;
    BACKUPS?: R2Bucket;
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

/**
 * `import.meta.glob` is Vite's, not TypeScript's.
 *
 * Declared here rather than by pulling in `vite/client`, whose ambient types
 * also assert that every .css and .svg import resolves -- true for the web
 * build, false for the Worker, and enabling it would make the Worker typecheck
 * agree with things it should not.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, unknown>;
}
