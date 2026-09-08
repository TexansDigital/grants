/**
 * Development and test fixtures.
 *
 * EVERY organization name here is invented and every EIN is fake. Production
 * rows are never copied into a fixture file - those are real nonprofits'
 * identifiers and financial positions, and a fixture file ends up on laptops,
 * in CI logs, and in screenshots.
 *
 * The EINs use prefix 00, which the IRS does not issue, so a fixture can never
 * collide with a real organization.
 */

import type { RequestContext } from '../types';
import { newId } from '../lib/ids';
import { nowIso } from '../lib/time';
import { auditStatement } from '../lib/audit';

export interface SeededOrg {
  organizationId: string;
  contactId: string;
  userId: string;
}

export interface OrgFixture {
  legalName: string;
  ein: string;
  email: string;
  firstName: string;
  lastName: string;
  city: string;
  mission: string;
  budgetCents: number;
}

export const ORG_FIXTURES: OrgFixture[] = [
  {
    legalName: 'Bayou Reach Collective',
    ein: '001234567',
    email: 'director@example-bayoureach.org',
    firstName: 'Alex',
    lastName: 'Moreno',
    city: 'Houston',
    mission: 'Expanding after-school literacy programs in under-resourced neighborhoods.',
    budgetCents: 82_500_00,
  },
  {
    legalName: 'Third Ward Futures Alliance',
    ein: '007654321',
    email: 'grants@example-twfa.org',
    firstName: 'Robin',
    lastName: 'Okafor',
    city: 'Houston',
    mission: 'Workforce training and job placement for returning citizens.',
    budgetCents: 1_240_000_00,
  },
  {
    legalName: 'Gulf Coast Youth Wellness Project',
    ein: '009876543',
    email: 'hello@example-gcywp.org',
    firstName: 'Sam',
    lastName: 'Delacroix',
    city: 'Galveston',
    mission: 'Youth mental health services and peer counseling across coastal counties.',
    budgetCents: 415_000_00,
  },
];

/** Seed one organization with a primary contact and a login-capable user. */
export async function seedOrganization(
  db: D1Database,
  ctx: RequestContext,
  fixture: OrgFixture,
): Promise<SeededOrg> {
  const now = nowIso();
  const organizationId = newId();
  const contactId = newId();
  const userId = newId();
  const email = fixture.email.toLowerCase();

  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (
           id, legal_name, ein, website, address_json, mission,
           annual_operating_budget_cents, status, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        organizationId,
        fixture.legalName,
        fixture.ein,
        `https://example-${fixture.legalName.toLowerCase().replace(/[^a-z]+/g, '')}.org`,
        JSON.stringify({
          address_1: '100 Example Street',
          city: fixture.city,
          state: 'TX',
          postal_code: '77002',
          country: 'US',
        }),
        fixture.mission,
        fixture.budgetCents,
        'active',
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO contacts (
           id, organization_id, first_name, last_name, email, phone,
           job_title, is_primary, can_login, marketing_opt_in, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        contactId,
        organizationId,
        fixture.firstName,
        fixture.lastName,
        email,
        '7135550100',
        'Executive Director',
        1,
        1,
        0,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO users (
           id, email, role, organization_id, display_name, is_active, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(
        userId,
        email,
        'applicant',
        organizationId,
        `${fixture.firstName} ${fixture.lastName}`,
        1,
        now,
        now,
      ),
    auditStatement(db, ctx, {
      action: 'organization.created',
      entityType: 'organization',
      entityId: organizationId,
      after: { legal_name: fixture.legalName, ein: fixture.ein, source: 'fixture' },
    }),
  ]);

  return { organizationId, contactId, userId };
}

/**
 * Seed the two admin accounts.
 *
 * Two from day one is deliberate. A single admin is a continuity failure: if
 * that person is unavailable during an open cycle, nobody can extend a
 * deadline, answer an applicant, or record a decision.
 */
export async function seedAdmins(db: D1Database, ctx: RequestContext): Promise<string[]> {
  const now = nowIso();
  const admins = [
    { email: 'admin.primary@example.org', name: 'Primary Admin' },
    { email: 'admin.secondary@example.org', name: 'Secondary Admin' },
  ];
  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const a of admins) {
    const id = newId();
    ids.push(id);
    statements.push(
      db
        .prepare(
          `INSERT INTO users (id, email, role, organization_id, display_name, is_active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(id, a.email, 'admin', null, a.name, 1, now, now),
      auditStatement(db, ctx, {
        action: 'user.created',
        entityType: 'user',
        entityId: id,
        after: { email: a.email, role: 'admin', source: 'fixture' },
      }),
    );
  }

  await db.batch(statements);
  return ids;
}
