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

export interface PortfolioRow {
  reportPeriodId: string;
  awardId: string;
  organizationId: string;
  organizationName: string;
  programName: string;
  label: string;
  periodType: string;
  dueDate: string;
  status: string;
  /** Integer cents. Formatted at the display edge, never before. */
  awardedAmountCents: number;
  submittedAt: string | null;
  fundsSpentCents: number | null;
  daysUntilDue: number;
  overdue: boolean;
}

export interface StaffReport {
  period: {
    id: string;
    label: string;
    periodType: string;
    periodStart: string | null;
    periodEnd: string | null;
    dueDate: string;
    status: string;
    waivedReason: string | null;
  };
  award: {
    id: string;
    organizationId: string;
    organizationName: string;
    programName: string;
    awardedAmountCents: number;
    termStart: string | null;
    termEnd: string | null;
  };
  submissions: {
    id: string;
    submittedAt: string;
    submittedBy: string | null;
    fundsSpentCents: number | null;
    adminFeedback: string | null;
    acceptedAt: string | null;
    answers: { fieldKey: string; label: string; display: string | null }[];
    metrics: { metricKey: string; label: string; display: string | null }[];
    attachments: { id: string; filename: string; sizeBytes: number }[];
  }[];
}

export interface OrganizationSummary {
  id: string;
  legalName: string;
  ein: string | null;
  status: string;
  createdAt: string;
  applications: number;
  awards: number;
  contacts: number;
  users: number;
  openReports: number;
  lastActivityAt: string | null;
}

export interface DuplicateGroup {
  reason: 'same_ein' | 'same_name';
  key: string;
  organizations: OrganizationSummary[];
}

export interface MergePlan {
  survivor: OrganizationSummary;
  merged: OrganizationSummary;
  moves: {
    applications: number;
    awards: number;
    reportDrafts: number;
    contacts: number;
    contactsRetired: number;
    users: number;
    attachments: number;
  };
  conflicts: string[];
  ok: boolean;
}

export type Severity = 'blocking' | 'attention' | 'informational';

export interface HealthRow {
  id: string;
  kind: 'award' | 'organization' | 'application' | 'report_period' | 'attachment';
  title: string;
  detail: string;
  /** Integer cents, formatted at the display edge. Null when not about money. */
  amountCents: number | null;
}

export interface HealthCheck {
  key: string;
  label: string;
  guidance: string;
  severity: Severity;
  count: number;
  rows: HealthRow[];
  truncated: boolean;
}

export interface HealthReport {
  generatedAt: string;
  checks: HealthCheck[];
  blocking: number;
  attention: number;
}

export interface GenerateResult {
  awardId: string;
  created: number;
  skipped: string | null;
}

export interface BulkGenerateResult {
  generated: GenerateResult[];
  skipped: GenerateResult[];
  periodsCreated: number;
  more: boolean;
}

export interface ImportIssue {
  rowNumber: number;
  column: string | null;
  message: string;
}

export interface ImportPreview {
  parse: {
    ok: boolean;
    rows: number;
    issues: ImportIssue[];
    unknownColumns: string[];
    report: string;
  };
  plan: {
    ok: boolean;
    summary: {
      toCreate: number;
      toSkip: number;
      blocked: number;
      organizationsToCreate: number;
      usersToCreate: number;
      totalCents: number;
    };
    rows: {
      reference: string;
      organization: string;
      kind: 'create' | 'skip' | 'blocked';
      reason: string | null;
      amountCents: number;
      createsOrganization: boolean;
      createsUser: boolean;
    }[];
  } | null;
}

export interface ImportRunResult {
  awardsCreated: number;
  organizationsCreated: number;
  usersCreated: number;
  skipped: number;
}

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
  buildReportForm: (programId: string) =>
    request<{ formDefinitionId: string; version: number; fieldCount: number }>(
      `/api/programs/${encodeURIComponent(programId)}/report-form`,
      { method: 'POST', body: {} },
    ),
  publishForm: (formDefinitionId: string) =>
    request<{
      formDefinitionId: string;
      version: number;
      retiredFormDefinitionId: string | null;
      periodsAttached: number;
    }>(`/api/forms/${encodeURIComponent(formDefinitionId)}/publish`, {
      method: 'POST',
      body: {},
    }),
  previewAwardImport: (csv: string) =>
    request<ImportPreview>('/api/awards/import/preview', { method: 'POST', body: { csv } }),
  runAwardImport: (csv: string) =>
    request<ImportRunResult>('/api/awards/import', { method: 'POST', body: { csv } }),
  generateReportPeriods: () =>
    request<BulkGenerateResult>('/api/report-periods/generate', { method: 'POST', body: {} }),
  dataHealth: (signal?: AbortSignal) => get<HealthReport>('/api/data-health', signal),
  duplicates: (signal?: AbortSignal) =>
    get<{ groups: DuplicateGroup[] }>('/api/organizations/duplicates', signal),
  mergePreview: (duplicateId: string, into: string, signal?: AbortSignal) =>
    get<MergePlan>(
      `/api/organizations/${encodeURIComponent(duplicateId)}/merge-preview` +
        `?into=${encodeURIComponent(into)}`,
      signal,
    ),
  merge: (duplicateId: string, into: string) =>
    request<{ survivorId: string; mergedId: string }>(
      `/api/organizations/${encodeURIComponent(duplicateId)}/merge`,
      { method: 'POST', body: { into } },
    ),
  reports: (query: string, signal?: AbortSignal) =>
    get<{ rows: PortfolioRow[]; total: number }>(
      `/api/reports${query ? `?${query}` : ''}`,
      signal,
    ),
  report: (id: string, signal?: AbortSignal) =>
    get<StaffReport>(`/api/reports/${encodeURIComponent(id)}`, signal),
  acceptReport: (id: string) =>
    request<{ reportSubmissionId: string; acceptedAt: string }>(
      `/api/reports/${encodeURIComponent(id)}/accept`,
      { method: 'POST', body: {} },
    ),
  requestReportRevisions: (id: string, feedback: string) =>
    request<{ reportSubmissionId: string }>(
      `/api/reports/${encodeURIComponent(id)}/revisions`,
      { method: 'POST', body: { feedback } },
    ),
  waiveReport: (id: string, reason: string) =>
    request<{ waived: boolean }>(`/api/reports/${encodeURIComponent(id)}/waive`, {
      method: 'POST',
      body: { reason },
    }),
  form: (id: string, signal?: AbortSignal) =>
    get<{ form: import('../../src/lib/forms').FormDefinition }>(
      `/api/forms/${encodeURIComponent(id)}`,
      signal,
    ),
};
