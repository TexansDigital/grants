import { request } from './http';

/**
 * The client's view of the staff API.
 *
 * Every call is same-origin, so the Cloudflare Access cookie rides along and
 * there is no token for this code to hold, store or leak. A 401 means the
 * Access session lapsed; the only correct response is to reload the page and
 * let Access re-authenticate, which is what the UI offers.
 */

export interface SessionUser {
  email: string;
  role: string;
}

export interface ProgramRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  fiscal_year: number | null;
  compliance_policy: string;
}

export interface CycleRow {
  id: string;
  program_id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  status: string;
  draft_grace_hours: number | null;
  opens_at_display: string;
  closes_at_display: string;
}

export interface FormSummary {
  id: string;
  program_id: string;
  form_key: string;
  stage_id: string | null;
  kind: 'application' | 'report';
  name: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  published_at: string | null;
  program_name: string;
  stage_name: string | null;
}

export interface ApplicationRow {
  id: string;
  cycle_id: string;
  stage_id: string;
  organization_id: string;
  status: string;
  project_title: string | null;
  requested_amount_cents: number | null;
  submitted_at: string | null;
  organization_name: string | null;
  organization_ein: string | null;
  cycle_name: string | null;
  program_id: string;
  /** Admin only. Absent from a reviewer's payload by design, not by hiding. */
  internal_notes?: string | null;
  decision_notes?: string | null;
}

export interface StoredAnswer {
  /** The label as the applicant was asked it, not as the form reads now. */
  label_at_answer: string;
  field_type: string;
  value_text: string | null;
  value_int: number | null;
  value_real: number | null;
  value_json: string | null;
  answered_at: string | null;
}

export interface ApplicationDetail {
  application: ApplicationRow;
  organization: Record<string, unknown> | null;
  answers: Record<string, StoredAnswer>;
  attachments: { id: string; filename: string; mime_type: string; size_bytes: number }[];
}

export interface SearchHit {
  application_id: string;
  rank: number;
  snippet: string;
}

export interface OrganizationHistory {
  organization: Record<string, unknown>;
  applications: {
    id: string;
    status: string;
    submitted_at: string | null;
    requested_amount_cents: number | null;
    project_title: string | null;
    cycle_name: string | null;
  }[];
  summary: { total_applications: number; by_status: Record<string, number> };
}

export { ApiError } from './http';

const get = <T,>(path: string, signal?: AbortSignal): Promise<T> =>
  request<T>(path, signal ? { signal } : {});

export const api = {
  session: (signal?: AbortSignal) => get<{ user: SessionUser }>('/api/session', signal),
  programs: (signal?: AbortSignal) => get<{ programs: ProgramRow[] }>('/api/programs', signal),
  cycles: (signal?: AbortSignal) => get<{ cycles: CycleRow[] }>('/api/cycles', signal),
  forms: (signal?: AbortSignal) => get<{ forms: FormSummary[] }>('/api/forms', signal),
  applications: (query: string, signal?: AbortSignal) =>
    get<{ applications: ApplicationRow[]; total: number }>(
      `/api/applications${query ? `?${query}` : ''}`,
      signal,
    ),
  application: (id: string, signal?: AbortSignal) =>
    get<ApplicationDetail>(`/api/applications/${encodeURIComponent(id)}`, signal),
  search: (q: string, signal?: AbortSignal) =>
    get<{ query: string; hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`, signal),
  history: (organizationId: string, signal?: AbortSignal) =>
    get<OrganizationHistory>(
      `/api/organizations/${encodeURIComponent(organizationId)}/history`,
      signal,
    ),
  form: (id: string, signal?: AbortSignal) =>
    get<{ form: import('../../src/lib/forms').FormDefinition }>(
      `/api/forms/${encodeURIComponent(id)}`,
      signal,
    ),
};
