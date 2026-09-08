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
