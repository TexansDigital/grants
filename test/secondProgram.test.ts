import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { SECOND_PROGRAM } from '../src/seed/secondProgram';
import { loadFormDefinition, validateSubmission, allFields, lintFormDefinition } from '../src/lib/forms';

const ctx = () => ctxFor(adminSession());

/**
 * PHASE 0 VERIFICATION.
 *
 * The claim: "adding a hypothetical second program with different stages and
 * fields requires zero schema changes." This file is that claim, executed.
 *
 * The method: snapshot the database schema, seed a deliberately dissimilar
 * second program, snapshot again, and assert the two are byte-identical.
 */

async function schemaSnapshot(): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT type, name, COALESCE(sql,'') AS sql
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
          AND name NOT LIKE 'd1_%'
        ORDER BY type, name`,
    )
    .all<{ type: string; name: string; sql: string }>();
  return results.map((r) => `${r.type}:${r.name}\n${r.sql}`).join('\n---\n');
}

describe('a second program requires zero schema changes', () => {
  it('seeds a two-stage gated program against the identical schema', async () => {
    await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const before = await schemaSnapshot();

    const second = await seedProgram(db, ctx(), SECOND_PROGRAM);

    const after = await schemaSnapshot();
    expect(after).toBe(before); // no table, index, or trigger changed

    expect(Object.keys(second.stageIds)).toEqual(['loi', 'full']);
    expect(Object.keys(second.formDefinitionIds)).toEqual(['loi', 'full']);
  });

  it('the second program differs structurally from the first in every way that matters', async () => {
    const first = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const second = await seedProgram(db, ctx(), SECOND_PROGRAM);

    const firstDef = await loadFormDefinition(db, first.formDefinitionIds.application!);
    const loiDef = await loadFormDefinition(db, second.formDefinitionIds.loi!);
    const fullDef = await loadFormDefinition(db, second.formDefinitionIds.full!);

    // Different stage counts.
    expect(Object.keys(first.stageIds)).toHaveLength(1);
    expect(Object.keys(second.stageIds)).toHaveLength(2);

    // Different section keys.
    const firstSections = firstDef.sections.map((s) => s.section_key);
    const loiSections = loiDef.sections.map((s) => s.section_key);
    expect(firstSections.some((s) => loiSections.includes(s))).toBe(false);

    // Different field keys.
    const firstKeys = new Set(allFields(firstDef).map((f) => f.field_key));
    const loiKeys = allFields(loiDef).map((f) => f.field_key);
    expect(loiKeys.some((k) => firstKeys.has(k))).toBe(false);

    // Different option sets on the same maps_to target.
    const firstCounties = allFields(firstDef).find((f) => f.maps_to === 'counties_served')!;
    const secondRegions = allFields(loiDef).find((f) => f.maps_to === 'counties_served')!;
    expect(firstCounties.options[0]!.value).not.toBe(secondRegions.options[0]!.value);

    // Both still map the universal set, and both lint clean.
    expect(lintFormDefinition(loiDef)).toEqual([]);
    expect(lintFormDefinition(fullDef)).toEqual([]);
  });

  it('records the stage gate that Inspire Change does not have', async () => {
    const second = await seedProgram(db, ctx(), SECOND_PROGRAM);
    const rows = await db
      .prepare(
        `SELECT stage_key, gate_on_prior_decision AS gate
           FROM program_stages WHERE id IN (?,?) ORDER BY sort_order`,
      )
      .bind(second.stageIds.loi!, second.stageIds.full!)
      .all<{ stage_key: string; gate: number }>();
    expect(rows.results).toEqual([
      { stage_key: 'loi', gate: 0 },
      { stage_key: 'full', gate: 1 },
    ]);
  });

  it('validates a second-program submission through the same engine', async () => {
    const second = await seedProgram(db, ctx(), SECOND_PROGRAM);
    const loiDef = await loadFormDefinition(db, second.formDefinitionIds.loi!);

    const complete = validateSubmission(loiDef, {
      org_legal_name: 'Invented Futures Inc',
      tax_id: '00-1112223',
      lead_contact_email: 'contact@example-invented.org',
      years_operating: '12',
      org_website: 'example-invented.org',
      amount_sought: '$35,000',
      regions_served: ['gulf_coast', 'east_texas'],
      concept_summary: 'A short concept description.',
      prior_funding: 'no',
    });
    expect(complete.errors).toEqual([]);

    // The conditional year field is required only when prior_funding is yes.
    const withPrior = validateSubmission(loiDef, {
      org_legal_name: 'Invented Futures Inc',
      tax_id: '00-1112223',
      lead_contact_email: 'contact@example-invented.org',
      years_operating: '12',
      org_website: 'example-invented.org',
      amount_sought: '$35,000',
      regions_served: ['gulf_coast'],
      concept_summary: 'A short concept description.',
      prior_funding: 'yes',
    });
    expect(withPrior.errors.map((e) => e.field)).toContain('prior_funding_year');
  });

  it('enforces the second program own bounds, not the first program bounds', async () => {
    const second = await seedProgram(db, ctx(), SECOND_PROGRAM);
    const loiDef = await loadFormDefinition(db, second.formDefinitionIds.loi!);

    // Inspire Change allows up to $100,000. This program caps at $75,000.
    const over = validateSubmission(loiDef, { amount_sought: '$90,000' }, { partial: true });
    expect(over.errors.some((e) => e.field === 'amount_sought')).toBe(true);

    const ok = validateSubmission(loiDef, { amount_sought: '$70,000' }, { partial: true });
    expect(ok.errors.some((e) => e.field === 'amount_sought')).toBe(false);
  });

  it('keeps each program compliance policy and grace rule separate', async () => {
    const first = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const second = await seedProgram(db, ctx(), SECOND_PROGRAM);

    const p1 = await db.prepare(`SELECT compliance_policy AS p FROM programs WHERE id = ?`).bind(first.programId).first<{ p: string }>();
    const p2 = await db.prepare(`SELECT compliance_policy AS p FROM programs WHERE id = ?`).bind(second.programId).first<{ p: string }>();
    expect(p1?.p).toBe('warn');
    expect(p2?.p).toBe('block');

    const c1 = await db.prepare(`SELECT draft_grace_hours AS g FROM cycles WHERE program_id = ?`).bind(first.programId).first<{ g: number }>();
    const c2 = await db.prepare(`SELECT draft_grace_hours AS g FROM cycles WHERE program_id = ?`).bind(second.programId).first<{ g: number }>();
    expect(c1?.g).toBe(0);
    expect(c2?.g).toBe(24);
  });
});
