/**
 * Full-text search index maintenance.
 *
 * One FTS document per application, built from the promoted columns plus every
 * long-text answer. Populated at submit and on admin edit - never on autosave.
 * See the design note in migration 0005 for why.
 */

import type { FormDefinition } from './forms';
import { allFields } from './forms';
import type { StoredValue } from './fieldTypes';

export interface SearchSource {
  applicationId: string;
  organizationName: string;
  ein: string;
  projectTitle: string;
  counties: string;
  focusArea: string;
  narrative: string;
}

/** Field keys whose answers are treated as focus-area metadata rather than prose. */
const FOCUS_AREA_KEYS = ['area_of_focus', 'focus_area', 'funding_type', 'type_of_funding'];

function textOf(stored: StoredValue | undefined): string {
  if (!stored) return '';
  if (stored.value_text) return stored.value_text;
  if (stored.value_json) {
    try {
      const parsed = JSON.parse(stored.value_json);
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string').join(' ');
      if (parsed && typeof parsed === 'object') {
        return Object.values(parsed)
          .filter((x) => typeof x === 'string')
          .join(' ');
      }
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Build the searchable document for one application.
 *
 * Narrative is every long_text answer concatenated. Short text that is already
 * promoted (organization name, title) is indexed in its own column so it can be
 * weighted differently at query time.
 */
export function buildSearchDoc(args: {
  applicationId: string;
  definition: FormDefinition;
  answers: ReadonlyMap<string, StoredValue>;
  promoted: Record<string, string | number | null>;
}): SearchSource {
  const fields = allFields(args.definition);
  const narrativeParts: string[] = [];
  const focusParts: string[] = [];

  for (const field of fields) {
    const stored = args.answers.get(field.id);
    if (!stored) continue;

    if (FOCUS_AREA_KEYS.includes(field.field_key)) {
      focusParts.push(textOf(stored));
      continue;
    }
    if (field.field_type === 'long_text' || field.field_type === 'other_specify') {
      // Include the label so a search for "timeline" finds the timeline answer
      // even when the applicant did not use the word.
      const body = textOf(stored);
      if (body) narrativeParts.push(`${field.label}: ${body}`);
    }
  }

  const counties = args.promoted.counties_served_json;
  let countiesText = '';
  if (typeof counties === 'string') {
    try {
      const parsed = JSON.parse(counties);
      if (Array.isArray(parsed)) countiesText = parsed.join(' ');
    } catch {
      countiesText = '';
    }
  }

  return {
    applicationId: args.applicationId,
    organizationName: String(args.promoted.organization_name_at_submit ?? ''),
    ein: String(args.promoted.ein_at_submit ?? ''),
    projectTitle: String(args.promoted.project_title ?? ''),
    counties: countiesText,
    focusArea: focusParts.join(' ').trim(),
    narrative: narrativeParts.join('\n\n'),
  };
}

/** Cheap content hash so a reindex sweep can skip unchanged applications. */
export function contentHash(doc: SearchSource): string {
  const s = [
    doc.organizationName,
    doc.ein,
    doc.projectTitle,
    doc.counties,
    doc.focusArea,
    doc.narrative,
  ].join(' ');
  // FNV-1a, 32-bit. Not cryptographic; it only has to detect change.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Statements that replace an application's FTS document.
 *
 * Delete-then-insert, returned as statements so they join the submit batch and
 * are atomic with the application write. A search index that disagrees with the
 * data is a support ticket nobody can reproduce.
 */
export function reindexStatements(
  db: D1Database,
  doc: SearchSource,
  indexedAt: string,
): D1PreparedStatement[] {
  const hash = contentHash(doc);
  return [
    db.prepare(`DELETE FROM application_fts WHERE application_id = ?`).bind(doc.applicationId),
    db
      .prepare(
        `INSERT INTO application_fts (
           application_id, organization_name, ein, project_title,
           counties, focus_area, narrative
         ) VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(
        doc.applicationId,
        doc.organizationName,
        doc.ein,
        doc.projectTitle,
        doc.counties,
        doc.focusArea,
        doc.narrative,
      ),
    db
      .prepare(
        `INSERT INTO application_search_state (application_id, indexed_at, content_hash)
         VALUES (?,?,?)
         ON CONFLICT(application_id) DO UPDATE SET indexed_at = excluded.indexed_at,
                                                   content_hash = excluded.content_hash`,
      )
      .bind(doc.applicationId, indexedAt, hash),
  ];
}

/** Remove an application from the index, e.g. on soft delete or withdrawal. */
export function unindexStatements(db: D1Database, applicationId: string): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM application_fts WHERE application_id = ?`).bind(applicationId),
    db.prepare(`DELETE FROM application_search_state WHERE application_id = ?`).bind(applicationId),
  ];
}

/**
 * Escape user input for an FTS5 MATCH query.
 *
 * FTS5 has its own query syntax; an unescaped apostrophe or a bare `NEAR` from
 * a search box is a syntax error, and a crafted string is a way to probe the
 * index. Every term is quoted, which makes the whole thing a literal phrase
 * search across terms.
 */
export function toFtsQuery(userInput: string): string | null {
  const terms = userInput
    .replace(/"/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 64)
    .slice(0, 12);

  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' AND ');
}

export interface SearchHit {
  application_id: string;
  rank: number;
  snippet: string;
}

/**
 * Search submitted applications. STAFF ONLY - this returns cross-organization
 * results by design and must never be reachable from an external session.
 */
export async function searchApplications(
  db: D1Database,
  userInput: string,
  limit = 50,
): Promise<SearchHit[]> {
  const query = toFtsQuery(userInput);
  if (!query) return [];

  const { results } = await db
    .prepare(
      `SELECT application_id,
              rank AS rank,
              snippet(application_fts, 6, '[', ']', '...', 20) AS snippet
         FROM application_fts
        WHERE application_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .bind(query, Math.min(Math.max(limit, 1), 200))
    .all<SearchHit>();

  return results ?? [];
}
