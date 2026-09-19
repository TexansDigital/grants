import { describe, it, expect } from 'vitest';
import { db } from './helpers';
describe('d1 upsert-with-where parse', () => {
  it('parses INSERT..SELECT..WHERE with ON CONFLICT', async () => {
    await db.prepare(`CREATE TABLE p (a TEXT, b TEXT, v TEXT, UNIQUE(a,b))`).run();
    const sql = `INSERT INTO p (a,b,v) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM programs WHERE 1=0)
                 ON CONFLICT(a,b) DO UPDATE SET v = excluded.v`;
    await db.prepare(sql).bind('1','2','x').run();
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM p`).first<{n:number}>();
    expect(n?.n).toBe(0); // guard false -> no row
    const sql2 = `INSERT INTO p (a,b,v) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE name='p')
                  ON CONFLICT(a,b) DO UPDATE SET v = excluded.v`;
    await db.prepare(sql2).bind('1','2','y').run();
    await db.prepare(sql2).bind('1','2','z').run();
    const row = await db.prepare(`SELECT v FROM p`).first<{v:string}>();
    expect(row?.v).toBe('z'); // guard true -> insert then upsert
  });
});

/**
 * Test TITLES stay ASCII.
 *
 * vitest-pool-workers puts the current test's name in an `MF-Vitest-Source`
 * HTTP header. A curly apostrophe there is legal UTF-8 but not a legal header
 * value, so workerd prints an eight-line warning -- once per worker, per file.
 * Eleven titles produced enough noise to bury the actual results.
 *
 * Only titles. Comments, fixtures and user-facing strings keep their
 * typography: this is about what crosses a header, not about house style.
 */
describe('test titles', () => {
  it('are ASCII, because vitest puts them in an HTTP header', async () => {
    const dir = 'test';
    const names: string[] = [];
    // import.meta.glob is a Vite feature and is how a test reads its siblings
    // without a filesystem, which workerd does not have.
    const files = import.meta.glob('./*.test.ts', { query: '?raw', import: 'default', eager: true });
    for (const [path, src] of Object.entries(files as Record<string, string>)) {
      for (const m of String(src).matchAll(/\b(?:it|describe)\(\s*'([^']*)'/g)) {
        // eslint-disable-next-line no-control-regex
        if (/[^\x00-\x7F]/.test(m[1]!)) names.push(`${dir}/${path.slice(2)}: ${m[1]!}`);
      }
    }
    expect(names, 'use a straight apostrophe, or reword').toEqual([]);
  });
});
