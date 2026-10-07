/**
 * What a grant was for, recorded against the award.
 *
 * WHY THIS IS NOT AN AMENDMENT. `amendAward` covers the TERMS -- the amount,
 * the term dates, the announcement date -- and demands a written reason,
 * writes an `award_amendments` row per field and is refused on a cancelled
 * award. That is right for a promise of money. It is wrong for cataloguing:
 * writing down that a 2025 grant paid for literacy coaching in Fort Bend
 * County does not change what the Foundation promised anybody, and requiring
 * "say why this award is being changed" thirteen times to fill in blanks that
 * were never filled in would teach the person doing it to type anything.
 *
 * So these fields have their own write. It still produces an audit row --
 * CLAUDE.md requires one for every award write, and this is one -- and it
 * still takes the same optimistic lock, because two admins cataloguing the
 * same grant from the same spreadsheet is exactly the scenario `amendAward`
 * guards against. What it does not do is pretend a description is a change to
 * a grant's terms.
 *
 * AND IT IS ALLOWED ON A CANCELLED AWARD, where an amendment is not. A grant
 * that was rescinded is still part of the funding history somebody will search
 * one day, and refusing to say what it had been for would make that history
 * less complete rather than more careful.
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { auditStatement } from './audit';
import { nowIso } from './time';

/** The columns this write owns. Spelled as the database spells them. */
const FIELDS = ['project_title', 'purpose', 'focus_area', 'counties_served_json'] as const;
type SubjectField = (typeof FIELDS)[number];

export interface AwardSubjectInput {
  /*
   * PRESENT-OR-ABSENT MATTERS, as it does on an amendment. An omitted key is
   * "leave this alone"; an explicit null is "clear it". Copying a whole
   * request body would turn every field the screen did not render into an
   * attempt to blank it.
   */
  projectTitle?: string | null;
  purpose?: string | null;
  focusArea?: string | null;
  /** A list of place names. Not a fixed set: see 0028 on why. */
  countiesServed?: string[] | null;
  /** The `updated_at` the caller believes the award carries. */
  expectedUpdatedAt?: string;
}

/*
 * Caps, so a paste of an entire grant agreement into a one-line field is
 * refused at the edge rather than stored and then truncated in every view
 * that renders it. D1's row ceiling is 2 MB; these are about legibility.
 */
const LIMITS: Record<SubjectField, number> = {
  project_title: 200,
  purpose: 4000,
  focus_area: 120,
  counties_served_json: 4000,
};
const MAX_COUNTIES = 60;
const MAX_COUNTY_LENGTH = 80;

function cleanText(raw: string | null | undefined, field: SubjectField, label: string): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  if (text.length > LIMITS[field]) {
    throw new AppError('VALIDATION_FAILED', `${label} is too long.`, {
      internalMessage: `${field} ${text.length} chars, limit ${LIMITS[field]}`,
      severity: 'warn',
      fieldErrors: [{ field, message: `Keep this under ${LIMITS[field]} characters.` }],
    });
  }
  return text;
}

/**
 * A list of counties to the JSON the column holds, or null.
 *
 * Stored in the same shape as `applications.counties_served_json` -- a JSON
 * array of strings -- so one reporting query can read across both tables. An
 * empty list is null, not `[]`: "nobody recorded this" and "recorded as none"
 * are not a distinction this Foundation has ever needed, and `[]` would read
 * as an answer on every screen that checks for one.
 */
function cleanCounties(raw: string[] | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_FAILED', 'Counties must be a list.', {
      internalMessage: `countiesServed was ${typeof raw}`,
      severity: 'warn',
      fieldErrors: [{ field: 'counties_served_json', message: 'Counties must be a list.' }],
    });
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new AppError('VALIDATION_FAILED', 'Counties must be a list of names.', {
        internalMessage: `countiesServed contained a ${typeof entry}`,
        severity: 'warn',
        fieldErrors: [{ field: 'counties_served_json', message: 'Counties must be names.' }],
      });
    }
    const name = entry.trim();
    if (name === '') continue;
    if (name.length > MAX_COUNTY_LENGTH) {
      throw new AppError('VALIDATION_FAILED', 'That is too long for a place name.', {
        internalMessage: `county name ${name.length} chars`,
        severity: 'warn',
        fieldErrors: [{ field: 'counties_served_json', message: 'That is too long for a place name.' }],
      });
    }
    // Case-insensitively unique: "Fort Bend" twice is a typo, not two places.
    if (!seen.has(name.toLowerCase())) seen.add(name.toLowerCase());
  }
  if (seen.size === 0) return null;
  if (seen.size > MAX_COUNTIES) {
    throw new AppError('VALIDATION_FAILED', 'That is more places than this field holds.', {
      internalMessage: `${seen.size} counties, limit ${MAX_COUNTIES}`,
      severity: 'warn',
      fieldErrors: [{ field: 'counties_served_json', message: `At most ${MAX_COUNTIES}.` }],
    });
  }
  /*
   * The ORIGINAL casing is stored, de-duplicated case-insensitively. Lowercasing
   * what somebody typed would render "fort bend" on a board report.
   */
  const kept: string[] = [];
  const used = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name === '' || used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    kept.push(name);
  }
  const json = JSON.stringify(kept);
  if (json.length > LIMITS.counties_served_json) {
    throw new AppError('VALIDATION_FAILED', 'That is more places than this field holds.', {
      internalMessage: `counties json ${json.length} chars`,
      severity: 'warn',
      fieldErrors: [{ field: 'counties_served_json', message: 'Too many to store.' }],
    });
  }
  return json;
}

interface Current {
  id: string;
  updatedAt: string;
  project_title: string | null;
  purpose: string | null;
  focus_area: string | null;
  counties_served_json: string | null;
}

/**
 * Record what a grant was for.
 *
 * Returns the fields that actually changed, so the caller can say so rather
 * than claiming a save that moved nothing.
 */
export async function describeAward(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  awardId: string,
  input: AwardSubjectInput,
): Promise<{ awardId: string; changed: SubjectField[]; updatedAt: string }> {
  // A 404 rather than a 403: a reviewer must not learn which award ids exist.
  if (session.role !== 'admin') throw notFound('award');

  const award = await db
    .prepare(
      `SELECT id, updated_at AS updatedAt, project_title, purpose, focus_area,
              counties_served_json
         FROM awards WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(awardId)
    .first<Current>();
  if (!award) throw notFound('award');

  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== award.updatedAt) {
    throw new AppError(
      'CONFLICT',
      'Somebody else changed this award while you were working on it. Reload and look at it again.',
      {
        internalMessage:
          `stale describe on ${awardId}: expected ${input.expectedUpdatedAt}, found ${award.updatedAt}`,
        severity: 'warn',
      },
    );
  }

  const next = new Map<SubjectField, string | null>();
  if ('projectTitle' in input) {
    next.set('project_title', cleanText(input.projectTitle, 'project_title', 'The title'));
  }
  if ('purpose' in input) {
    next.set('purpose', cleanText(input.purpose, 'purpose', 'The description'));
  }
  if ('focusArea' in input) {
    next.set('focus_area', cleanText(input.focusArea, 'focus_area', 'The focus area'));
  }
  if ('countiesServed' in input) {
    next.set('counties_served_json', cleanCounties(input.countiesServed));
  }

  const changed: SubjectField[] = [];
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  for (const [field, value] of next) {
    if (value === award[field]) continue;
    changed.push(field);
    before[field] = award[field];
    after[field] = value;
  }

  if (changed.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Nothing on this award would change.', {
      internalMessage: `describe on ${awardId} with no changes`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  const sets = changed.map((f) => `${f} = ?`).join(', ');
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE awards SET ${sets}, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
            ${input.expectedUpdatedAt !== undefined ? 'AND updated_at = ?' : ''}`,
      )
      .bind(
        ...changed.map((f) => after[f] ?? null),
        now,
        awardId,
        ...(input.expectedUpdatedAt !== undefined ? [input.expectedUpdatedAt] : []),
      ),
    auditStatement(
      db,
      ctx,
      {
        action: 'award.described',
        entityType: 'award',
        entityId: awardId,
        before,
        after: { ...after, actor_user_id: session.userId },
      },
      {
        /*
         * The audit row is conditional on the same predicate as its UPDATE.
         * Without the guard a lost optimistic-lock race would leave a record
         * of a change that did not happen, which is worse than no record.
         */
        guard: {
          sql: `EXISTS (SELECT 1 FROM awards WHERE id = ? AND updated_at = ?)`,
          binds: [awardId, now],
        },
      },
    ),
  ];

  await db.batch(statements);
  return { awardId, changed, updatedAt: now };
}
