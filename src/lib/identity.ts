/**
 * Resolving who is applying.
 *
 * An eligibility screen gives us three facts: a legal name, an EIN, and an
 * email. This turns those into an organization, a contact and a user -- or
 * refuses, clearly, when it cannot do so safely.
 *
 * THIS IS WHERE DUPLICATE ORGANIZATIONS ARE PREVENTED OR CREATED FOREVER.
 *
 * `organizations.ein` deliberately has NO unique index (0002:155 is a plain
 * index). CLAUDE.md is explicit that duplicates are expected -- two contacts
 * from the same nonprofit, an EIN typed with a dash one year and without it
 * the next -- and that an admin merges them with a tool built later. So a
 * lookup by EIN can legitimately return several rows, and this file must not
 * assume otherwise. Matching on the NORMALIZED EIN is what stops the
 * dash/no-dash case from ever becoming two rows in the first place.
 *
 * WHAT IT REFUSES, AND WHY IT REFUSES RATHER THAN GUESSING:
 *
 * Every failure here fails closed with a named reason, because the failure
 * mode of guessing is filing one nonprofit's application under another
 * nonprofit's organization -- which is a confidentiality breach, not a data
 * quality problem, and would be discovered by the wrong person.
 */

import type { RequestContext } from '../types';
import { AppError } from './errors';
import { normalizeEin } from './ein';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';

/** Chain depth before we call a merge graph broken rather than following it. */
const MAX_MERGE_DEPTH = 8;

export interface OrganizationCandidate {
  id: string;
  legal_name: string;
  ein: string | null;
}

export type OrganizationMatch =
  | { kind: 'matched'; organizationId: string; legalName: string }
  /**
   * Several live organizations share this EIN. Expected, since duplicates are
   * a documented state of this table -- but picking one at random would file
   * an application against an arbitrary half of a split nonprofit.
   */
  | { kind: 'ambiguous'; candidates: OrganizationCandidate[] }
  | { kind: 'none' };

/**
 * Follow `merged_into_id` to the surviving organization.
 *
 * An applicant whose organization was merged last year must land on the row
 * that survived, not on the tombstone -- otherwise their history splits again
 * the moment they reapply, which is the exact thing merging fixed.
 */
export async function resolveMergeTarget(
  db: D1Database,
  organizationId: string,
): Promise<string> {
  let current = organizationId;
  const seen = new Set<string>([current]);

  for (let depth = 0; depth < MAX_MERGE_DEPTH; depth++) {
    const row = await db
      .prepare(`SELECT merged_into_id FROM organizations WHERE id = ? AND deleted_at IS NULL`)
      .bind(current)
      .first<{ merged_into_id: string | null }>();

    if (!row || !row.merged_into_id) return current;
    // A cycle means the merge graph is corrupt. Stopping where we are beats
    // looping, and beats silently picking one side of the cycle.
    if (seen.has(row.merged_into_id)) return current;
    seen.add(row.merged_into_id);
    current = row.merged_into_id;
  }
  return current;
}

/** Find live organizations by normalized EIN. */
export async function findOrganizationByEin(
  db: D1Database,
  rawEin: string,
): Promise<OrganizationMatch> {
  const ein = normalizeEin(rawEin);
  if (!ein) return { kind: 'none' };

  const rows = await db
    .prepare(
      `SELECT id, legal_name, ein
         FROM organizations
        WHERE ein = ? AND deleted_at IS NULL AND status <> 'merged'
        ORDER BY created_at`,
    )
    .bind(ein)
    .all<OrganizationCandidate>();

  const live = rows.results ?? [];
  if (live.length === 0) {
    // Nothing live, but the EIN may belong to a row that was merged away.
    const merged = await db
      .prepare(
        `SELECT id FROM organizations
          WHERE ein = ? AND deleted_at IS NULL AND merged_into_id IS NOT NULL
          ORDER BY created_at LIMIT 1`,
      )
      .bind(ein)
      .first<{ id: string }>();
    if (!merged) return { kind: 'none' };

    const survivorId = await resolveMergeTarget(db, merged.id);
    const survivor = await db
      .prepare(`SELECT id, legal_name FROM organizations WHERE id = ? AND deleted_at IS NULL`)
      .bind(survivorId)
      .first<{ id: string; legal_name: string }>();
    return survivor
      ? { kind: 'matched', organizationId: survivor.id, legalName: survivor.legal_name }
      : { kind: 'none' };
  }

  if (live.length > 1) return { kind: 'ambiguous', candidates: live };
  const only = live[0]!;
  return { kind: 'matched', organizationId: only.id, legalName: only.legal_name };
}

// ---------------------------------------------------------------------------
// Applicant identity
// ---------------------------------------------------------------------------

export interface EligibilityIdentity {
  ein: string;
  legalName: string;
  email: string;
  firstName: string;
  lastName: string;
}

export type IdentityOutcome =
  | {
      kind: 'ready';
      userId: string;
      organizationId: string;
      contactId: string;
      /** True when this call created the organization rather than matching one. */
      createdOrganization: boolean;
      /** True when this call created the user. */
      createdUser: boolean;
    }
  /**
   * This email already signs in for a DIFFERENT organization.
   *
   * `users_email_uniq` is global and an applicant user binds to exactly one
   * organization; the owner accepted that limitation. The consequence has to
   * be handled rather than ignored: silently reusing the existing user would
   * file this application under the other nonprofit, and silently moving the
   * user would cut the first nonprofit off from its own drafts. Both are worse
   * than telling a human.
   */
  | { kind: 'email_belongs_to_other_organization'; existingOrganizationId: string }
  /** Staff sign in through Cloudflare Access and must not get a magic link. */
  | { kind: 'email_belongs_to_staff' }
  | { kind: 'ambiguous_organization'; candidates: OrganizationCandidate[] }
  | { kind: 'invalid_ein' };

/**
 * Turn a passed eligibility screen into an identity that can hold a session.
 *
 * Everything it writes goes in ONE `db.batch()`. D1 has no interactive
 * transactions, so a batch is the only atomic unit: an organization created
 * without its user, or a user created without its audit row, is exactly the
 * drift that batch exists to prevent.
 */
export async function resolveApplicantIdentity(
  db: D1Database,
  ctx: RequestContext,
  input: EligibilityIdentity,
): Promise<IdentityOutcome> {
  const ein = normalizeEin(input.ein);
  if (!ein) return { kind: 'invalid_ein' };

  const email = input.email.trim().toLowerCase();
  const legalName = input.legalName.trim();
  if (!email || !legalName) {
    throw new AppError('VALIDATION_FAILED', 'An organization name and email are required.', {
      internalMessage: 'resolveApplicantIdentity called with a blank name or email',
    });
  }

  const existingUser = await db
    .prepare(
      `SELECT id, role, organization_id FROM users
        WHERE email = ? AND deleted_at IS NULL`,
    )
    .bind(email)
    .first<{ id: string; role: string; organization_id: string | null }>();

  if (existingUser && existingUser.role !== 'applicant' && existingUser.role !== 'grantee') {
    return { kind: 'email_belongs_to_staff' };
  }

  const match = await findOrganizationByEin(db, ein);
  if (match.kind === 'ambiguous') {
    return { kind: 'ambiguous_organization', candidates: match.candidates };
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];

  /*
   * AN EIN IS NOT A CREDENTIAL, and this is where that nearly went wrong.
   *
   * A matching EIN used to be enough to put a brand-new email inside an
   * existing organization. EINs are public -- they are in the IRS Business
   * Master File, in Publication 78, and on the face of every Form 990 -- so
   * anyone who could read a nonprofit's 990 could type its EIN on the public
   * eligibility screen, receive a magic link at their own address, and hold a
   * session scoped to that nonprofit. From there they inherited its
   * eligibility pass, filed applications under its name, and on submit
   * overwrote its legal name, mission and operating budget through promotion.
   *
   * So a match only JOINS when the email already belongs to that organization
   * -- a returning applicant. Any other email with a matching EIN gets its own
   * new organization row, which is a duplicate, which is a case this platform
   * already expects and already has an answer for: match on EIN at submit and
   * let an admin merge. That turns a security hole into a data-quality task
   * that was always going to exist.
   *
   * The cost is real and is the right trade: a genuine second person at the
   * same nonprofit, applying with a different address, creates a duplicate an
   * admin has to merge. Making them wait for a human beats letting a stranger
   * in.
   */
  /*
   * Which organization this email ALREADY belongs to, resolved through the
   * merge chain rather than read off the row.
   *
   * A merge leaves the user pointing at the row that was merged away, so raw
   * id equality answers "no" for a person who plainly still belongs there --
   * and both decisions below hang on that answer.
   */
  const existingUserOrganizationId =
    existingUser?.organization_id != null
      ? await resolveMergeTarget(db, existingUser.organization_id)
      : null;

  const joinsExistingOrganization =
    match.kind === 'matched' && existingUserOrganizationId === match.organizationId;

  let organizationId: string;
  let createdOrganization = false;
  if (match.kind === 'matched' && joinsExistingOrganization) {
    // Already the survivor: findOrganizationByEin excludes merged rows from a
    // live match and resolves the chain itself on the merged-away path, and
    // 0002 CHECKs that merged_into_id is set exactly when status is 'merged'.
    // A second resolveMergeTarget call here would be unreachable code.
    organizationId = match.organizationId;
  } else {
    organizationId = newId();
    createdOrganization = true;
    statements.push(
      db
        .prepare(
          `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
           VALUES (?,?,?,'active',?,?)`,
        )
        .bind(organizationId, legalName, ein, now, now),
      auditStatement(db, ctx, {
        action: 'organization.created',
        entityType: 'organization',
        entityId: organizationId,
        // ein_verified_at stays null: matching the IRS file is a separate step
        // and a mismatch there is a flag for a human, never a rejection.
        after: {
          legal_name: legalName,
          ein,
          status: 'active',
          source: 'eligibility_screen',
          /*
           * The merge queue's input. A duplicate created because an unknown
           * email presented a known EIN is exactly the row an admin needs to
           * look at, and burying that in "we made an organization" would mean
           * the merge tool has to rediscover it by scanning for EIN
           * collisions later.
           */
          ...(match.kind === 'matched'
            ? { duplicate_of_organization_id: match.organizationId, needs_merge_review: true }
            : {}),
        },
      }),
    );
  }

  if (existingUser && existingUserOrganizationId !== organizationId) {
    return {
      kind: 'email_belongs_to_other_organization',
      // The SURVIVOR's id, not the merged-away one the user row happens to
      // hold. An admin sent to look at a merged row learns nothing.
      existingOrganizationId: existingUserOrganizationId ?? '',
    };
  }

  // Contacts are unique per (organization, email), so the same person at two
  // nonprofits is two contacts -- unlike users, which are one per email.
  const existingContact = await db
    .prepare(
      `SELECT id FROM contacts
        WHERE organization_id = ? AND email = ? AND deleted_at IS NULL`,
    )
    .bind(organizationId, email)
    .first<{ id: string }>();

  let contactId: string;
  if (existingContact) {
    contactId = existingContact.id;
  } else {
    contactId = newId();
    statements.push(
      db
        .prepare(
          `INSERT INTO contacts (id, organization_id, first_name, last_name, email,
             is_primary, can_login, created_at, updated_at)
           VALUES (?,?,?,?,?,?,1,?,?)`,
        )
        .bind(
          contactId,
          organizationId,
          input.firstName.trim() || null,
          input.lastName.trim() || null,
          email,
          // The first contact for an organization is its primary one. A later
          // one is not promoted over somebody already holding the role.
          createdOrganization ? 1 : 0,
          now,
          now,
        ),
      auditStatement(db, ctx, {
        action: 'contact.created',
        entityType: 'contact',
        entityId: contactId,
        after: { organization_id: organizationId, email, source: 'eligibility_screen' },
      }),
    );
  }

  let userId: string;
  let createdUser = false;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    userId = newId();
    createdUser = true;
    statements.push(
      db
        .prepare(
          `INSERT INTO users (id, email, role, organization_id, display_name, is_active,
             created_at, updated_at)
           VALUES (?,?, 'applicant', ?, ?, 1, ?, ?)`,
        )
        .bind(
          userId,
          email,
          organizationId,
          `${input.firstName.trim()} ${input.lastName.trim()}`.trim() || null,
          now,
          now,
        ),
      auditStatement(db, ctx, {
        action: 'user.created',
        entityType: 'user',
        entityId: userId,
        after: { email, role: 'applicant', organization_id: organizationId },
      }),
    );
  }

  if (statements.length > 0) await db.batch(statements);

  return { kind: 'ready', userId, organizationId, contactId, createdOrganization, createdUser };
}
