import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { describeForm } from '../src/lib/publicRoutes';
import { loadFormDefinition } from '../src/lib/loadForm';
import { nowIso } from '../src/lib/time';
import type { Env } from '../src/types';

const ORIGIN = 'https://apply.example.org';
const env = () => ({
  ...(testEnv as unknown as Env),
  APPLICANT_BASE_URL: ORIGIN,
  DISPLAY_TIMEZONE: 'America/Chicago',
});

const get = (path: string) =>
  worker.fetch(new Request(`${ORIGIN}${path}`), env(), {} as ExecutionContext);

let n = 0;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

/** A seeded program whose cycle is in whatever state the test needs. */
async function program(over: { status?: string; opens?: string; closes?: string } = {}) {
  const p = await seedProgram(db, ctxFor(adminSession()), {
    ...INSPIRE_CHANGE,
    slug: `pub-${++n}`,
    name: `Inspire Change ${n}`,
  });
  const cycleId = Object.values(p.cycleIds)[0]!;
  await db.prepare(`UPDATE cycles SET status=?, opens_at=?, closes_at=? WHERE id=?`)
    .bind(over.status ?? 'open', over.opens ?? ago(1), over.closes ?? ahead(30), cycleId)
    .run();
  const formId = Object.values(p.formDefinitionIds)[0]!;
  return { ...p, cycleId, formId };
}

interface CycleOut {
  id: string;
  name: string;
  programName: string;
  closesAtDisplay: string;
  formDefinitionId: string;
  shape: { questions: number; writtenAnswers: number; documents: number } | null;
  requiresReportsFiled: boolean;
}
const cycles = async (): Promise<CycleOut[]> =>
  (await (await get('/api/public/cycles')).json<{ cycles: CycleOut[] }>()).cycles;

// ---------------------------------------------------------------------------
describe('what an open cycle tells the public', () => {
  it('lists an open cycle with its deadline in Central', async () => {
    const p = await program();
    const found = (await cycles()).find((c) => c.id === p.cycleId);
    expect(found).toBeTruthy();
    expect(found!.programName).toBe(`Inspire Change ${n}`);
    // The same string the confirmation email will give them.
    expect(found!.closesAtDisplay).toMatch(/C[SD]T$/);
  });

  it('needs no authentication at all', async () => {
    await program();
    const res = await get('/api/public/cycles');
    expect(res.status).toBe(200);
  });

  it('is never cached, because a cycle can shut at any moment', async () => {
    await program();
    const res = await get('/api/public/cycles');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('says what the form asks, as counts rather than an invented duration', async () => {
    // "About 45 minutes" is a number nobody measured and everybody quotes
    // back. These are facts off the published definition.
    const p = await program();
    const found = (await cycles()).find((c) => c.id === p.cycleId)!;
    const def = await loadFormDefinition(db, p.formId);
    expect(found.shape).toEqual(describeForm(def));
    expect(found.shape!.questions).toBeGreaterThan(0);
  });

  it('says up front when a program blocks over an unfiled report', async () => {
    // On the page where somebody decides whether to spend an evening on the
    // form, not in an email after they have filled it in.
    const p = await program();
    await db.prepare(`UPDATE programs SET compliance_policy='block' WHERE id=?`)
      .bind(p.programId).run();
    expect((await cycles()).find((c) => c.id === p.cycleId)!.requiresReportsFiled).toBe(true);

    await db.prepare(`UPDATE programs SET compliance_policy='warn' WHERE id=?`)
      .bind(p.programId).run();
    expect((await cycles()).find((c) => c.id === p.cycleId)!.requiresReportsFiled).toBe(false);
  });

  it('orders by the deadline, so the urgent one is first', async () => {
    const soon = await program({ closes: ahead(3) });
    const later = await program({ closes: ahead(60) });
    const list = await cycles();
    const i = list.findIndex((c) => c.id === soon.cycleId);
    const j = list.findIndex((c) => c.id === later.cycleId);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(j);
  });
});

// ---------------------------------------------------------------------------
describe('what it refuses to advertise', () => {
  it('hides a cycle that is still in draft', async () => {
    // Opening a cycle is the deliberate act that publishes it to the world.
    // There is no second switch, because a second switch is a second thing to
    // forget.
    const p = await program({ status: 'draft' });
    expect((await cycles()).map((c) => c.id)).not.toContain(p.cycleId);
  });

  it('hides a closed, decided or archived cycle', async () => {
    for (const status of ['closed', 'decided', 'archived']) {
      const p = await program({ status });
      expect((await cycles()).map((c) => c.id), status).not.toContain(p.cycleId);
    }
  });

  it('hides a cycle left open past its own closing date', async () => {
    // The submit path would refuse it anyway. Advertising it as accepting
    // applications would send somebody to a dead end on purpose.
    const p = await program({ opens: ago(30), closes: ago(1) });
    expect((await cycles()).map((c) => c.id)).not.toContain(p.cycleId);
  });

  it('hides a cycle that has not opened yet', async () => {
    const p = await program({ opens: ahead(7), closes: ahead(60) });
    expect((await cycles()).map((c) => c.id)).not.toContain(p.cycleId);
  });

  it('hides a cycle whose first stage has no published form', async () => {
    const p = await program();
    await db.prepare(`UPDATE form_definitions SET status='retired' WHERE id=?`)
      .bind(p.formId).run();
    expect((await cycles()).map((c) => c.id)).not.toContain(p.cycleId);
  });

  it('never leaks anything about who has applied', async () => {
    const p = await program();
    const body = await (await get('/api/public/cycles')).text();
    for (const word of ['application', 'organization_id', 'ein', 'contact']) {
      expect(body.toLowerCase()).not.toContain(word);
    }
    expect(body).toContain(p.cycleId);
  });
});

// ---------------------------------------------------------------------------
describe('the eligibility form, fetched without a session', () => {
  it('serves the published form of an open cycle', async () => {
    const p = await program();
    const res = await get(`/api/public/forms/${p.formId}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ form: { id: string; status: string; sections: unknown[] } }>();
    expect(body.form.id).toBe(p.formId);
    expect(body.form.status).toBe('published');
    expect(body.form.sections.length).toBeGreaterThan(0);
  });

  it('404s a form whose cycle is not open', async () => {
    // 404, not 403. A 403 confirms the form exists, which is the one thing a
    // caller poking at ids is trying to learn.
    const p = await program({ status: 'draft' });
    expect((await get(`/api/public/forms/${p.formId}`)).status).toBe(404);
  });

  it('404s an unpublished form even when a cycle is open', async () => {
    const p = await program();
    const draftId = await db.prepare(
      `SELECT id FROM form_definitions WHERE program_id=? AND status<>'published' LIMIT 1`,
    ).bind(p.programId).first<{ id: string }>();
    if (draftId) {
      expect((await get(`/api/public/forms/${draftId.id}`)).status).toBe(404);
    }
    // And the belt: retire the published one and it goes away too.
    await db.prepare(`UPDATE form_definitions SET status='retired' WHERE id=?`)
      .bind(p.formId).run();
    expect((await get(`/api/public/forms/${p.formId}`)).status).toBe(404);
  });

  it('404s a report form, which the public has no business reading', async () => {
    const p = await program();
    const now = nowIso();
    const reportFormId = `rpt-${n}`;
    await db.prepare(
      `INSERT INTO form_definitions
         (id, program_id, form_key, stage_id, kind, name, version, status, published_at,
          created_at, updated_at)
       VALUES (?,?,'grant_report',NULL,'report','Grant report',1,'published',?,?,?)`,
    ).bind(reportFormId, p.programId, now, now, now).run();
    expect((await get(`/api/public/forms/${reportFormId}`)).status).toBe(404);
  });

  it('404s an id that does not exist', async () => {
    await program();
    expect((await get('/api/public/forms/nope')).status).toBe(404);
  });

  it('serves the page shell for the public paths', async () => {
    for (const path of ['/apply', '/apply/start/abc']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('text/html');
    }
  });
});
