/**
 * Writing imported awards into the database.
 *
 * TWO PHASES, ALWAYS. `planAwardImport` reads and decides; `applyAwardImport`
 * writes what was planned. Nothing writes without a plan somebody could have
 * read first, and the dry run is the plan with the second call not made.
 *
 * THE AUTHORITY QUESTION, which this file has to get right.
 *
 * An EIN identifies an organization. It does NOT prove that the person holding
 * it may act for that organization -- EINs are printed on every Form 990. The
 * public eligibility screen therefore refuses to put an unknown email inside a
 * matched organization, and creates a duplicate for an admin to merge instead.
 *
 * This path is different, and deliberately so. An admin running an import is
 * asserting, as a human with an Access session, that these organizations are
 * real, these are their grants, and these people may report on them. That
 * assertion is the authority the public path does not have. It is why this
 * MATCHES on EIN where the public path refuses to, and why it is admin-only and
 * audited rather than merely convenient.
 *
 * RECOVERY IS IDEMPOTENCE, NOT ATOMICITY. Two hundred awards will not fit in
 * one D1 batch, so this writes in chunks and a failure can leave some awards
 * written. That is survivable because `external_reference` is unique over live
 * rows: re-running the same file skips what already landed and finishes the
 * rest. Pretending otherwise -- one giant batch that D1 refuses -- would be a
 * worse answer than a resumable one.
 */

import type { RequestContext } from '../types';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { nowIso } from '../lib/time';
import { auditStatement } from '../lib/audit';
import { resolveMergeTarget } from '../lib/identity';
import type { ParsedAward } from './awards';

/** What the import would do with one row. */
export type RowPlan =
  | { kind: 'create'; award: ParsedAward; awardId: string; organizationId: string;
      createdOrganization: boolean; userId: string; createdUser: boolean; contactId: string;
      createdContact: boolean; programId: string; cycleId: string | null;
      parentAwardId: string | null }
  /** Already imported. A second run of the same file is a no-op, by design. */
  | { kind: 'skip'; award: ParsedAward; reason: string }
  /** Needs a human before anything is written. */
  | { kind: 'blocked'; award: ParsedAward; reason: string };

export interface ImportPlan {
  rows: RowPlan[];
  /** True when nothing is blocked. The import will not run otherwise. */
  ok: boolean;
  summary: {
    toCreate: number;
    toSkip: number;
    blocked: number;
    organizationsToCreate: number;
    usersToCreate: number;
    totalCents: number;
  };
}

interface OrgRow {
  id: string;
  legal_name: string;
}

/**
 * Decide what would happen, without writing anything.
 *
 * Resolution happens IN FILE ORDER and remembers what it decided, so two rows
 * for the same nonprofit -- year one and year two of a multi-year grant --
 * resolve to one organization and one user rather than two of each. Without
 * that, a two-year file would create a duplicate of every returning grantee on
 * its first run.
 */
export async function planAwardImport(
  db: D1Database,
  parsed: readonly ParsedAward[],
): Promise<ImportPlan> {
  const rows: RowPlan[] = [];

  // Decisions already made in this pass, so later rows see them.
  const orgByEin = new Map<string, { id: string; created: boolean }>();
  const userByEmail = new Map<string, { id: string; created: boolean }>();
  const contactByOrgEmail = new Map<string, { id: string; created: boolean }>();
  const awardIdByReference = new Map<string, string>();

  for (const award of parsed) {
    const blocked = (reason: string) => rows.push({ kind: 'blocked', award, reason });

    // Already imported? The unique index would refuse it anyway; saying so in
    // the plan means a re-run reads as "nothing to do" rather than an error.
    const existing = await db
      .prepare(
        `SELECT id FROM awards
          WHERE source_system = 'spreadsheet' AND source_reference = ?
            AND deleted_at IS NULL`,
      )
      .bind(award.externalReference)
      .first<{ id: string }>();
    if (existing) {
      awardIdByReference.set(award.externalReference, existing.id);
      rows.push({ kind: 'skip', award, reason: 'already imported' });
      continue;
    }

    const program = await db
      .prepare(`SELECT id FROM programs WHERE slug = ? AND deleted_at IS NULL`)
      .bind(award.programSlug)
      .first<{ id: string }>();
    if (!program) {
      blocked(`No program with slug "${award.programSlug}".`);
      continue;
    }

    /*
     * Attaching a legacy award to a cycle, WITHOUT guessing.
     *
     * cycle_id is nullable precisely because a grant made before this platform
     * may belong to no cycle we have a row for. So: match only when exactly one
     * live cycle's window contains the award date. Two overlapping cycles, or
     * none, leaves it null -- an award on the wrong cycle would land in the
     * wrong year's totals, and a null is visibly missing where a wrong answer
     * is not.
     *
     * `fiscal_year` lives on programs, not cycles, so it cannot discriminate
     * between two cycles of the same program and is not used here.
     */
    const { results: cycleMatches } = await db
      .prepare(
        `SELECT id FROM cycles
          WHERE program_id = ? AND deleted_at IS NULL
            AND opens_at <= ? AND closes_at >= ?`,
      )
      .bind(program.id, award.awardedAt, award.awardedAt)
      .all<{ id: string }>();
    const cycle = (cycleMatches ?? []).length === 1 ? cycleMatches![0]! : null;

    // ---- organization ------------------------------------------------------
    let org = orgByEin.get(award.ein);
    if (!org) {
      const { results } = await db
        .prepare(
          `SELECT id, legal_name FROM organizations
            WHERE ein = ? AND deleted_at IS NULL AND status <> 'merged'`,
        )
        .bind(award.ein)
        .all<OrgRow>();
      const live = results ?? [];
      if (live.length > 1) {
        // Two live rows share this EIN. Guessing which holds the grant is not
        // a decision an importer gets to make.
        blocked(
          `${live.length} organizations share EIN ${award.ein}: ${live
            .map((o) => o.legal_name)
            .join(', ')}. Merge them first.`,
        );
        continue;
      }
      org =
        live.length === 1
          ? { id: live[0]!.id, created: false }
          : { id: newId(), created: true };
    }

    // ---- the person who will file reports ----------------------------------
    let user = userByEmail.get(award.contactEmail);
    if (!user) {
      const existingUser = await db
        .prepare(`SELECT id, role, organization_id FROM users WHERE email = ? AND deleted_at IS NULL`)
        .bind(award.contactEmail)
        .first<{ id: string; role: string; organization_id: string | null }>();

      if (existingUser) {
        if (existingUser.role !== 'applicant' && existingUser.role !== 'grantee') {
          // A staff address cannot also be a grantee login: staff sign in
          // through Access and must never hold a magic-link session.
          blocked(
            `${award.contactEmail} is a staff account and cannot be used as a grantee login.`,
          );
          continue;
        }
        const theirOrg = existingUser.organization_id
          ? await resolveMergeTarget(db, existingUser.organization_id)
          : null;
        if (theirOrg && theirOrg !== org.id) {
          // One email, one organization. Silently moving them would cut the
          // first nonprofit off from its own records.
          blocked(
            `${award.contactEmail} already signs in for a different organization. ` +
              `Use a different address for this grantee, or merge the organizations.`,
          );
          continue;
        }
        user = { id: existingUser.id, created: false };
      } else {
        user = { id: newId(), created: true };
      }
    }

    // ---- the contact record ------------------------------------------------
    const contactKey = `${org.id}:${award.contactEmail}`;
    let contact = contactByOrgEmail.get(contactKey);
    if (!contact) {
      const existingContact = org.created
        ? null
        : await db
            .prepare(
              `SELECT id FROM contacts
                WHERE organization_id = ? AND email = ? AND deleted_at IS NULL`,
            )
            .bind(org.id, award.contactEmail)
            .first<{ id: string }>();
      contact = existingContact
        ? { id: existingContact.id, created: false }
        : { id: newId(), created: true };
    }

    // ---- a renewal's parent ------------------------------------------------
    let parentAwardId: string | null = null;
    if (award.parentExternalReference) {
      parentAwardId = awardIdByReference.get(award.parentExternalReference) ?? null;
      if (!parentAwardId) {
        const parent = await db
          .prepare(
            `SELECT id FROM awards
              WHERE source_system = 'spreadsheet' AND source_reference = ?
                AND deleted_at IS NULL`,
          )
          .bind(award.parentExternalReference)
          .first<{ id: string }>();
        parentAwardId = parent?.id ?? null;
      }
      if (!parentAwardId) {
        blocked(
          `Parent award "${award.parentExternalReference}" is neither in this file above ` +
            `this row nor already imported.`,
        );
        continue;
      }
    }

    const awardId = newId();
    awardIdByReference.set(award.externalReference, awardId);
    rows.push({
      kind: 'create',
      award,
      awardId,
      organizationId: org.id,
      createdOrganization: org.created,
      userId: user.id,
      createdUser: user.created,
      contactId: contact.id,
      createdContact: contact.created,
      programId: program.id,
      cycleId: cycle?.id ?? null,
      parentAwardId,
    });
    /*
     * THE ONE PLACE DECISIONS ARE REMEMBERED, and only for a row that will
     * actually be written.
     *
     * Recording them here rather than at each lookup means only the first row
     * for an organization creates it -- without which a two-year file would
     * duplicate every returning grantee on its first run. It also means a
     * BLOCKED row leaves nothing behind: the next row with the same EIN
     * re-derives its own answer instead of inheriting one from a row that is
     * not being imported.
     */
    orgByEin.set(award.ein, { id: org.id, created: false });
    userByEmail.set(award.contactEmail, { id: user.id, created: false });
    contactByOrgEmail.set(contactKey, { id: contact.id, created: false });
  }

  const creates = rows.filter((r): r is Extract<RowPlan, { kind: 'create' }> => r.kind === 'create');
  return {
    rows,
    ok: !rows.some((r) => r.kind === 'blocked'),
    summary: {
      toCreate: creates.length,
      toSkip: rows.filter((r) => r.kind === 'skip').length,
      blocked: rows.filter((r) => r.kind === 'blocked').length,
      organizationsToCreate: creates.filter((r) => r.createdOrganization).length,
      usersToCreate: creates.filter((r) => r.createdUser).length,
      totalCents: creates.reduce((n, r) => n + r.award.awardedAmountCents, 0),
    },
  };
}

/**
 * Statements per award. Kept small enough that a chunk of rows stays inside
 * D1's limits, and grouped so one award's writes never straddle two batches --
 * an award without its organization is not a state worth being recoverable
 * from.
 */
const ROWS_PER_BATCH = 10;

export interface ImportResult {
  awardsCreated: number;
  organizationsCreated: number;
  usersCreated: number;
  skipped: number;
}

export async function applyAwardImport(
  db: D1Database,
  ctx: RequestContext,
  plan: ImportPlan,
): Promise<ImportResult> {
  if (!plan.ok) {
    throw new AppError('VALIDATION_FAILED', 'This import cannot run until the problems are fixed.', {
      internalMessage: `applyAwardImport called with ${plan.summary.blocked} blocked row(s)`,
      severity: 'error',
    });
  }

  const creates = plan.rows.filter(
    (r): r is Extract<RowPlan, { kind: 'create' }> => r.kind === 'create',
  );
  const now = nowIso();
  const result: ImportResult = {
    awardsCreated: 0,
    organizationsCreated: 0,
    usersCreated: 0,
    skipped: plan.summary.toSkip,
  };

  for (let i = 0; i < creates.length; i += ROWS_PER_BATCH) {
    const chunk = creates.slice(i, i + ROWS_PER_BATCH);
    const statements: D1PreparedStatement[] = [];

    for (const row of chunk) {
      const a = row.award;

      if (row.createdOrganization) {
        statements.push(
          db
            .prepare(
              `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
               VALUES (?,?,?,'active',?,?)`,
            )
            .bind(row.organizationId, a.organizationName, a.ein, now, now),
          auditStatement(db, ctx, {
            action: 'organization.created',
            entityType: 'organization',
            entityId: row.organizationId,
            after: {
              legal_name: a.organizationName,
              status: 'active',
              // How this organization came to exist, so a later question about
              // it lands on the import rather than on a mystery.
              source: 'awards_import',
              source_reference: a.externalReference,
            },
          }),
        );
        result.organizationsCreated += 1;
      }

      if (row.createdContact) {
        const [first, ...rest] = a.contactName.trim().split(/\s+/);
        statements.push(
          db
            .prepare(
              `INSERT INTO contacts (id, organization_id, first_name, last_name, email, phone,
                 is_primary, can_login, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,1,?,?)`,
            )
            .bind(
              row.contactId,
              row.organizationId,
              first ?? null,
              rest.length > 0 ? rest.join(' ') : null,
              a.contactEmail,
              a.contactPhone,
              row.createdOrganization ? 1 : 0,
              now,
              now,
            ),
        );
      }

      if (row.createdUser) {
        statements.push(
          db
            .prepare(
              `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
               VALUES (?,?,'grantee',?,1,?,?)`,
            )
            .bind(row.userId, a.contactEmail, row.organizationId, now, now),
          auditStatement(db, ctx, {
            action: 'user.created',
            entityType: 'user',
            entityId: row.userId,
            after: { role: 'grantee', organization_id: row.organizationId, source: 'awards_import' },
          }),
        );
        result.usersCreated += 1;
      }

      statements.push(
        db
          .prepare(
            `INSERT INTO awards (id, application_id, organization_id, program_id, cycle_id,
               awarded_amount_cents, awarded_at, announcement_date, agreement_signed_at,
               w9_received_at, media_release_at, term_start, term_end, is_multi_year,
               parent_award_id, status, source_system, source_reference, notes,
               created_at, updated_at)
             VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'spreadsheet',?,?,?,?)`,
          )
          .bind(
            row.awardId,
            row.organizationId,
            row.programId,
            row.cycleId,
            a.awardedAmountCents,
            a.awardedAt,
            a.announcementDate,
            a.agreementSignedAt,
            a.w9ReceivedAt,
            a.mediaReleaseAt,
            a.termStart,
            a.termEnd,
            a.isMultiYear ? 1 : 0,
            row.parentAwardId,
            a.status,
            a.externalReference,
            a.notes,
            now,
            now,
          ),
        /*
         * Non-negotiable #6: every award write produces an audit row. An
         * imported award is still an award, and "where did this grant come
         * from" is exactly the question somebody asks two years later about a
         * row nobody remembers entering.
         */
        auditStatement(db, ctx, {
          action: 'award.created',
          entityType: 'award',
          entityId: row.awardId,
          after: {
            organization_id: row.organizationId,
            program_id: row.programId,
            awarded_amount_cents: a.awardedAmountCents,
            awarded_at: a.awardedAt,
            status: a.status,
            source: 'awards_import',
            source_reference: a.externalReference,
            ...(row.parentAwardId ? { parent_award_id: row.parentAwardId } : {}),
          },
        }),
      );
      result.awardsCreated += 1;
    }

    await db.batch(statements);
  }

  return result;
}
