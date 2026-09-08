import { describe, it, expect } from 'vitest';
import { db, ctxFor } from './helpers';
import { writeAudit } from '../src/lib/audit';

/**
 * Definition of done #1 and the structural guarantees the schema is supposed to
 * provide. These tests exist because a CHECK constraint that was never
 * exercised is a comment.
 */
describe('migrations', () => {
  it('creates every expected table from empty', async () => {
    const { results } = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all<{ name: string }>();
    const names = new Set(results.map((r) => r.name));

    for (const t of [
      'audit_log',
      'error_log',
      'programs',
      'program_stages',
      'cycles',
      'organizations',
      'contacts',
      'users',
      'form_definitions',
      'form_sections',
      'form_fields',
      'applications',
      'application_answers',
      'attachments',
      'application_fts',
      'application_search_state',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it('supports FTS5 virtual tables on D1', async () => {
    await db
      .prepare(
        `INSERT INTO application_fts (application_id, organization_name, ein, project_title, counties, focus_area, narrative)
         VALUES ('a1','Bayou Reach Collective','001234567','Literacy Lab','harris fort_bend','education','after school reading support')`,
      )
      .run();
    const { results } = await db
      .prepare(`SELECT application_id FROM application_fts WHERE application_fts MATCH ?`)
      .bind('"reading"')
      .all<{ application_id: string }>();
    expect(results.map((r) => r.application_id)).toEqual(['a1']);
  });

  describe('audit_log is append-only', () => {
    it('rejects UPDATE', async () => {
      await writeAudit(db, ctxFor(), {
        action: 'program.created',
        entityType: 'program',
        entityId: 'p-append-1',
        after: { name: 'x' },
      });
      await expect(
        db.prepare(`UPDATE audit_log SET action = 'tampered' WHERE entity_id = 'p-append-1'`).run(),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects DELETE', async () => {
      await writeAudit(db, ctxFor(), {
        action: 'program.created',
        entityType: 'program',
        entityId: 'p-append-2',
        after: { name: 'x' },
      });
      await expect(
        db.prepare(`DELETE FROM audit_log WHERE entity_id = 'p-append-2'`).run(),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('error_log is append-only', () => {
    it('rejects UPDATE and DELETE', async () => {
      await db
        .prepare(
          `INSERT INTO error_log (id, severity, code, message, created_at)
           VALUES ('e1','error','INTERNAL','boom', datetime('now'))`,
        )
        .run();
      await expect(
        db.prepare(`UPDATE error_log SET message = 'x' WHERE id = 'e1'`).run(),
      ).rejects.toThrow(/append-only/);
      await expect(db.prepare(`DELETE FROM error_log WHERE id = 'e1'`).run()).rejects.toThrow(
        /append-only/,
      );
    });
  });

  describe('money columns physically reject floats', () => {
    it('rejects a float total_budget_cents', async () => {
      await expect(
        db
          .prepare(
            `INSERT INTO programs (id,name,slug,status,total_budget_cents,compliance_policy,created_at,updated_at)
             VALUES ('p-float','Float','float-slug','draft', 1234.56, 'warn', datetime('now'), datetime('now'))`,
          )
          .run(),
      ).rejects.toThrow(/CHECK/i);
    });

    it('rejects a float annual_operating_budget_cents', async () => {
      await expect(
        db
          .prepare(
            `INSERT INTO organizations (id,legal_name,annual_operating_budget_cents,status,created_at,updated_at)
             VALUES ('o-float','Float Org', 99.99, 'active', datetime('now'), datetime('now'))`,
          )
          .run(),
      ).rejects.toThrow(/CHECK/i);
    });

  });

  describe('EIN storage', () => {
    it('rejects a dashed EIN, forcing normalization on the way in', async () => {
      await expect(
        db
          .prepare(
            `INSERT INTO organizations (id,legal_name,ein,status,created_at,updated_at)
             VALUES ('o-dash','Dashed','76-1234567','active',datetime('now'),datetime('now'))`,
          )
          .run(),
      ).rejects.toThrow(/CHECK/i);
    });
  });

  describe('users role/organization invariant', () => {
    it('rejects an applicant with no organization', async () => {
      await expect(
        db
          .prepare(
            `INSERT INTO users (id,email,role,organization_id,is_active,created_at,updated_at)
             VALUES ('u-bad','a@example.org','applicant',NULL,1,datetime('now'),datetime('now'))`,
          )
          .run(),
      ).rejects.toThrow(/CHECK/i);
    });

    it('rejects an admin bound to an organization', async () => {
      await db
        .prepare(
          `INSERT INTO organizations (id,legal_name,status,created_at,updated_at)
           VALUES ('o-admin','Org','active',datetime('now'),datetime('now'))`,
        )
        .run();
      await expect(
        db
          .prepare(
            `INSERT INTO users (id,email,role,organization_id,is_active,created_at,updated_at)
             VALUES ('u-bad2','b@example.org','admin','o-admin',1,datetime('now'),datetime('now'))`,
          )
          .run(),
      ).rejects.toThrow(/CHECK/i);
    });
  });

  describe('soft delete does not break uniqueness', () => {
    it('allows reusing a program slug after soft delete', async () => {
      const now = `datetime('now')`;
      await db
        .prepare(
          `INSERT INTO programs (id,name,slug,status,compliance_policy,created_at,updated_at,deleted_at)
           VALUES ('p-del','Old','reused-slug','archived','warn',${now},${now},${now})`,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO programs (id,name,slug,status,compliance_policy,created_at,updated_at)
           VALUES ('p-new','New','reused-slug','active','warn',${now},${now})`,
        )
        .run();
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM programs WHERE slug='reused-slug'`)
        .first<{ n: number }>();
      expect(row?.n).toBe(2);
    });
  });
});
