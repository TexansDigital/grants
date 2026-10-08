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
  /** The award made from this application, if one exists. Id and status only. */
  award: { id: string; status: string } | null;
}

/** A short-lived signed URL. Treat it as a credential and do not store it. */
export interface DownloadGrant {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  expiresAt: string;
}

export interface RetentionDueFile {
  id: string;
  filename: string;
  organization_name: string;
  project_title: string | null;
  application_id: string;
  effective_due_at: string;
  /** When a download LINK was issued. Not proof the bytes were fetched. */
  download_url_first_issued_at: string | null;
}

export interface RetentionScreen {
  upcoming: RetentionDueFile[];
  purged: Record<string, unknown>[];
}

/** One outstanding obligation. Mirrors TodoItem in src/lib/todo.ts. */
export interface TodoItem {
  id: string;
  kind: 'claim' | 'report_filed' | 'report_overdue' | 'report_due' | 'files_due';
  title: string;
  detail: string;
  href: string | null;
  dueAt: string | null;
  urgency: 'now' | 'soon' | 'watch';
}

export interface TodoScreen {
  items: TodoItem[];
  generatedAt: string;
  /** False when the report portfolio was longer than one page. */
  complete: boolean;
}

/** A linked award, named as little as the award page needs for the link. */
export interface RelatedAward {
  id: string;
  awardedAmountCents: number;
  awardedAt: string;
  status: string;
  termStart: string | null;
  termEnd: string | null;
}

/** Mirrors AwardOverview in src/lib/awardPage.ts. */
export interface AwardOverview {
  awardId: string;
  organizationId: string;
  organizationName: string;
  programId: string;
  programName: string;
  cycleId: string | null;
  cycleName: string | null;
  applicationId: string | null;
  projectTitle: string | null;
  /*
   * WHAT THE GRANT WAS FOR. Null on everything imported: the award importer
   * accepts identity and dates and nothing describing the work, so for the
   * thirteen 2025 grants these start empty and the page offers to fill them.
   */
  subject: {
    projectTitle: string | null;
    purpose: string | null;
    focusArea: string | null;
    countiesServed: string[];
  };
  /** The token a save carries, so two admins cannot overwrite each other. */
  updatedAt: string;
  awardedAmountCents: number;
  awardedAt: string;
  announcementDate: string | null;
  termStart: string | null;
  termEnd: string | null;
  status: string;
  isMultiYear: boolean;
  isPublic: boolean;
  sourceSystem: string | null;
  sourceReference: string | null;
  acceptedAt: string | null;
  declinedByGranteeAt: string | null;
  parent: RelatedAward | null;
  renewals: RelatedAward[];
  reports: PortfolioRow[];
  whyNoReports: 'has_reports' | 'no_term_dates' | 'not_requested';
}

/** Mirrors the types in src/lib/organizationPage.ts. */
export interface OrganizationAward {
  id: string;
  programName: string;
  awardedAmountCents: number;
  awardedAt: string;
  status: string;
  termStart: string | null;
  termEnd: string | null;
  reportsTotal: number;
  reportsAccepted: number;
  reportsOverdue: number;
  reportsOutstanding: number;
}

export interface OrganizationApplicationRow {
  id: string;
  status: string;
  submittedAt: string | null;
  requestedAmountCents: number | null;
  projectTitle: string | null;
  cycleName: string | null;
}

export interface OrganizationContact {
  name: string;
  email: string;
  jobTitle: string | null;
  isPrimary: boolean;
  hasAccount: boolean;
  lastLoginAt: string | null;
}

export interface OrganizationOverview {
  id: string;
  legalName: string;
  ein: string | null;
  einVerifiedAt: string | null;
  website: string | null;
  mission: string | null;
  annualOperatingBudgetCents: number | null;
  status: string;
  mergedIntoId: string | null;
  mergedIntoName: string | null;
  awards: OrganizationAward[];
  applications: OrganizationApplicationRow[];
  contacts: OrganizationContact[];
  totalAwardedCents: number;
  hasAccount: boolean;
  lastSignInAt: string | null;
}

export interface AwardListRow {
  id: string;
  organizationId: string;
  organizationName: string;
  programName: string;
  awardedAmountCents: number;
  awardedAt: string;
  status: string;
  termStart: string | null;
  termEnd: string | null;
  reportsTotal: number;
  reportsOverdue: number;
  reportsOutstanding: number;
  /** What the grant was for; null where nobody has recorded it yet. */
  focusArea: string | null;
  /** Null when nobody at the grantee has ever completed a sign-in. */
  granteeLastSignInAt: string | null;
}

export interface OrganizationListRow {
  id: string;
  legalName: string;
  ein: string | null;
  einVerifiedAt: string | null;
  status: string;
  grants: number;
  totalAwardedCents: number;
  lastAwardedAt: string | null;
  applications: number;
  reportsOverdue: number;
  /** An account exists. Says nothing about whether anybody has used it. */
  hasAccount: boolean;
  /** When anybody here last signed in. Null if nobody ever has. */
  lastSignInAt: string | null;
}

/** Mirrors src/lib/impact.ts. */
export interface ImpactMetric {
  metricDefinitionId: string;
  label: string;
  metricType: string;
  unit: string | null;
  total: number | null;
  answered: number;
}

export interface ImpactProgram {
  programId: string;
  programName: string;
  metrics: ImpactMetric[];
  obligations: number;
  accepted: number;
  grantsNeverAsked: number;
  grants: number;
  totalAwardedCents: number;
  acceptedAwardedCents: number;
}

export interface Impact {
  generatedAt: string;
  year: number | null;
  years: number[];
  programs: ImpactProgram[];
}

export interface RubricRow {
  id: string;
  program_id: string;
  name: string;
  rubric_key: string;
  version: number;
  status: string;
  /** Score-BASIS-POINTS, like cents. Divide by 10000 at the display edge. */
  max_total_score: number | null;
  published_at: string | null;
}

export interface RubricCriterionRow {
  id: string;
  criterion_key: string;
  label: string;
  description: string | null;
  /** Basis points. 10000 is a weight of 1.0. */
  weight_bp: number;
  max_score: number;
  sort_order: number;
}

export interface RubricDetail {
  rubric: RubricRow;
  criteria: RubricCriterionRow[];
  maxTotalScoreBp: number;
  cyclesUsing: { id: string; name: string; status: string }[];
}

export interface CriterionInput {
  criterionKey: string;
  label: string;
  description: string | null;
  weightBp: number;
  maxScore: number;
}

export interface ScoringCriterion {
  id: string;
  criterion_key: string;
  label: string;
  description: string | null;
  weight_bp: number;
  max_score: number;
  sort_order: number;
  /** THIS reviewer's own score. Another reviewer's is never sent. */
  score: number | null;
  comment: string | null;
}

export interface ScoringSheet {
  assignmentId: string;
  applicationId: string;
  projectTitle: string | null;
  organizationName: string;
  rubric: { id: string; name: string; version: number; maxTotalScoreBp: number };
  criteria: ScoringCriterion[];
  totalSoFarBp: number;
  completedAt: string | null;
  conflictDeclaredAt: string | null;
  /** When an admin recorded it is not a conflict. Null while it still blocks. */
  conflictClearedAt: string | null;
  editable: boolean;
}

export interface AmendmentRow {
  id: string;
  awardId: string;
  amendedAt: string;
  /** The amending admin's email, or their id if the user row is gone. */
  amendedBy: string;
  fieldChanged: 'awarded_amount_cents' | 'term_start' | 'term_end' | 'announcement_date';
  oldValue: string | null;
  newValue: string | null;
  reason: string;
}

export interface AwardPaperwork {
  awardId: string;
  organizationName: string;
  status: string;
  awardedAmountCents: number;
  termStart: string | null;
  termEnd: string | null;
  announcementDate: string | null;
  /** The token an amendment sends back, so two admins cannot overwrite each other. */
  updatedAt: string;
  acceptedAt: string | null;
  declinedByGranteeAt: string | null;
  granteeResponseNote: string | null;
  documents: { key: 'w9' | 'agreement' | 'media_release'; label: string; receivedAt: string | null }[];
  outstanding: number;
  scheduledCents: number;
}

export interface CoverageRow {
  application_id: string;
  project_title: string | null;
  organization_name: string | null;
  reviewers: number;
  conflicts: number;
  completed: number;
}

export interface Coverage {
  cycleId: string;
  target: number;
  rows: CoverageRow[];
  /** Applications with fewer live reviewers than the target. */
  under: number;
}

export interface OutstandingConflict {
  assignmentId: string;
  applicationId: string;
  projectTitle: string | null;
  organizationName: string | null;
  reviewerEmail: string;
  declaredAt: string;
  note: string | null;
}

export interface ReviewerTotal {
  assignmentId: string;
  reviewerUserId: string;
  reviewerEmail: string;
  completedAt: string | null;
  totalBp: number;
  scored: number;
  criteriaCount: number;
}

/** Admin only. A reviewer must never receive this shape. */
export interface ScoreSummary {
  applicationId: string;
  rubric: { id: string; name: string; version: number; maxTotalScoreBp: number } | null;
  reviewers: ReviewerTotal[];
  meanCompletedBp: number | null;
  byCriterion: {
    criterionId: string;
    label: string;
    maxScore: number;
    weightBp: number;
    scores: { assignmentId: string; score: number | null; comment: string | null }[];
  }[];
}

export interface QueueRow {
  id: string;
  project_title: string | null;
  status: string;
  requested_amount_cents: number | null;
  review_assignment_id: string;
  assigned_at: string;
  completed_at: string | null;
  conflict_declared_at: string | null;
  conflict_cleared_at: string | null;
}

export interface PendingRow {
  applicationId: string;
  status: string;
  organizationName: string;
  projectTitle: string | null;
  contactEmail: string | null;
  decidedAt: string;
  awardedAmountCents: number | null;
  announcementDate: string | null;
}

export interface CommunicationQueue {
  cycleId: string;
  cycleName: string;
  programName: string;
  awards: PendingRow[];
  declines: PendingRow[];
  awardsCommunicated: number;
  /** False while ANY award in the cycle is still untold. */
  declinesUnlocked: boolean;
}

export interface CycleReviewer {
  reviewerUserId: string;
  email: string;
  assigned: number;
  completed: number;
  conflicts: number;
}

export interface ScorecardPlan {
  ok: boolean;
  rubricId: string | null;
  rubricVersion: number | null;
  issues: { row: number | null; message: string }[];
  assignments: {
    assignmentId: string;
    organization: string;
    reviewerEmail: string;
    scored: number;
    cleared: number;
    unchanged: number;
  }[];
  totalScores: number;
}

export interface DashboardData {
  generatedAt: string;
  awardTotals: {
    fiscalYear: number | null;
    programId: string;
    programName: string;
    cycleId: string | null;
    cycleName: string | null;
    awards: number;
    committedCents: number;
    smallestCents: number | null;
    largestCents: number | null;
  }[];
  funnel: {
    programId: string;
    programName: string;
    cycleId: string;
    cycleName: string;
    closesAt: string;
    received: number;
    underReview: number;
    awarded: number;
    declined: number;
    withdrawn: number;
    /** Basis points, like money is cents. Divided only for display. */
    successRateBp: number | null;
  }[];
  compliance: {
    programId: string;
    programName: string;
    scheduled: number;
    open: number;
    submitted: number;
    revisionsRequested: number;
    accepted: number;
    waived: number;
    overdue: number;
    total: number;
    complianceRateBp: number | null;
  }[];
  metrics: {
    programId: string;
    programName: string;
    metricDefinitionId: string;
    label: string;
    metricType: string;
    unit: string | null;
    reports: number;
    total: number | null;
  }[];
  disbursement: {
    programId: string;
    programName: string;
    fiscalYear: number | null;
    committedCents: number;
    scheduledCents: number;
    paidCents: number;
  }[];
  budget: {
    programId: string;
    programName: string;
    fiscalYear: number | null;
    totalBudgetCents: number | null;
    committedCents: number;
    awards: number;
    overBudget: boolean;
  }[];
  /** What this dashboard cannot answer, carried in the payload. */
  notAvailable: string[];
}

export interface DeclineBatchResult {
  sent: number;
  failed: number;
  /** Still waiting after this round. The caller loops while this is above 0. */
  remaining: number;
  outcomes: {
    applicationId: string;
    organizationName: string;
    ok: boolean;
    reason: string | null;
  }[];
}

export interface PaymentRow {
  id: string;
  awardId: string;
  amountCents: number;
  scheduledDate: string;
  paidDate: string | null;
  status: string;
  method: string | null;
  referenceNumber: string | null;
  note: string | null;
}

export interface AwardLedger {
  awardId: string;
  organizationName: string;
  awardedAmountCents: number;
  scheduledCents: number;
  paidCents: number;
  /** Awarded minus scheduled. */
  unscheduledCents: number;
  payments: PaymentRow[];
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
  /** How many times this report has been chased, and when last. */
  reminderCount: number;
  reminderLastSentAt: string | null;
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
    metrics: { metricKey: string; label: string; display: string | null; metricType: string }[];
    attachments: { id: string; filename: string; sizeBytes: number }[];
  }[];
  /**
   * Every time this deadline moved, oldest first. Mirrors DueDateAmendment in
   * src/lib/reportAdmin.ts.
   *
   * Empty for almost every report, which is the point: when it is not,
   * "due 30 November" is not the whole truth, and whoever reads the report
   * needs the rest of it before judging the nonprofit for being late.
   */
  dueDateChanges: {
    id: string;
    amendedAt: string;
    amendedBy: string;
    oldValue: string | null;
    newValue: string | null;
    reason: string;
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
  /*
   * `system` points at no record: its id is an error code. Mirrors HealthKind
   * in src/lib/dataHealth.ts -- two copies of one union, which the UI's
   * exhaustive branch would not have caught, because an unknown kind simply
   * fell through to printing a truncated id.
   */
  kind: 'award' | 'organization' | 'application' | 'report_period' | 'attachment' | 'system';
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
  /*
   * A credential to read one uploaded file.
   *
   * POST because it mutates -- it stamps the attachment and writes an audit
   * row -- and because a GET would let a link prefetcher issue live download
   * credentials for every financial statement on a page nobody clicked.
   */
  dashboard: (signal?: AbortSignal) => get<DashboardData>('/api/dashboard', signal),
  payments: (awardId: string, signal?: AbortSignal) =>
    get<AwardLedger>(`/api/awards/${encodeURIComponent(awardId)}/payments`, signal),
  schedulePayment: (
    awardId: string,
    body: { amountCents: number; scheduledDate: string; note?: string | null },
  ) =>
    request<PaymentRow>(`/api/awards/${encodeURIComponent(awardId)}/payments`, {
      method: 'POST',
      body,
    }),
  recordPayment: (paymentId: string, body: { paidDate: string; referenceNumber: string }) =>
    request<PaymentRow>(`/api/payments/${encodeURIComponent(paymentId)}/record`, {
      method: 'POST',
      body,
    }),
  cancelPayment: (paymentId: string, reason: string) =>
    request<{ paymentId: string; status: string }>(
      `/api/payments/${encodeURIComponent(paymentId)}/cancel`,
      { method: 'POST', body: { reason } },
    ),
  createAward: (
    applicationId: string,
    body: {
      awardedAmountCents: number;
      announcementDate?: string | null;
      termStart?: string | null;
      termEnd?: string | null;
    },
  ) =>
    request<{ awardId: string; awardedAmountCents: number; status: string }>(
      `/api/applications/${encodeURIComponent(applicationId)}/award`,
      { method: 'POST', body },
    ),
  cycleReviewers: (cycleId: string, signal?: AbortSignal) =>
    get<{ cycleId: string; reviewers: CycleReviewer[] }>(
      `/api/cycles/${encodeURIComponent(cycleId)}/reviewers`,
      signal,
    ),
  previewScorecard: (cycleId: string, csv: string) =>
    request<ScorecardPlan>(`/api/cycles/${encodeURIComponent(cycleId)}/scorecard/preview`, {
      method: 'POST',
      body: { csv },
    }),
  importScorecard: (cycleId: string, csv: string) =>
    request<{ applied: number; assignments: number }>(
      `/api/cycles/${encodeURIComponent(cycleId)}/scorecard/import`,
      { method: 'POST', body: { csv } },
    ),
  communications: (cycleId: string, signal?: AbortSignal) =>
    get<CommunicationQueue>(
      `/api/cycles/${encodeURIComponent(cycleId)}/communications`,
      signal,
    ),
  notifyAward: (applicationId: string) =>
    request<{ applicationId: string; communicatedAt: string }>(
      `/api/applications/${encodeURIComponent(applicationId)}/notify-award`,
      { method: 'POST', body: {} },
    ),
  notifyDeclineBatch: (cycleId: string, body: string[]) =>
    request<DeclineBatchResult>(
      `/api/cycles/${encodeURIComponent(cycleId)}/notify-declines`,
      { method: 'POST', body: { body } },
    ),
  notifyDecline: (applicationId: string, body: string[]) =>
    request<{ applicationId: string; communicatedAt: string }>(
      `/api/applications/${encodeURIComponent(applicationId)}/notify-decline`,
      { method: 'POST', body: { body } },
    ),
  markCommunicated: (applicationId: string, note: string) =>
    request<{ applicationId: string; communicatedAt: string }>(
      `/api/applications/${encodeURIComponent(applicationId)}/communicated`,
      { method: 'POST', body: { note } },
    ),
  reviewQueue: (signal?: AbortSignal) =>
    get<{ assignments: QueueRow[] }>('/api/review/queue', signal),
  scoringSheet: (assignmentId: string, signal?: AbortSignal) =>
    get<ScoringSheet>(
      `/api/review/assignments/${encodeURIComponent(assignmentId)}/sheet`,
      signal,
    ),
  saveScores: (
    assignmentId: string,
    scores: { criterionId: string; score: number | null; comment: string | null }[],
  ) =>
    request<{ assignmentId: string; saved: number; totalSoFarBp: number }>(
      `/api/review/assignments/${encodeURIComponent(assignmentId)}/scores`,
      { method: 'PATCH', body: { scores } },
    ),
  completeReview: (assignmentId: string) =>
    request<{ assignmentId: string; completedAt: string; totalBp: number }>(
      `/api/review/assignments/${encodeURIComponent(assignmentId)}/complete`,
      { method: 'POST', body: {} },
    ),
  reopenReview: (assignmentId: string) =>
    request<{ assignmentId: string }>(
      `/api/review/assignments/${encodeURIComponent(assignmentId)}/reopen`,
      { method: 'POST', body: {} },
    ),
  amendments: (awardId: string, signal?: AbortSignal) =>
    get<{ amendments: AmendmentRow[] }>(
      `/api/awards/${encodeURIComponent(awardId)}/amendments`,
      signal,
    ),
  amendAward: (
    awardId: string,
    body: {
      awardedAmountCents?: number;
      termStart?: string | null;
      termEnd?: string | null;
      announcementDate?: string | null;
      reason: string;
      expectedUpdatedAt?: string;
    },
  ) =>
    request<{ awardId: string; changed: string[]; updatedAt: string }>(
      `/api/awards/${encodeURIComponent(awardId)}`,
      { method: 'PATCH', body },
    ),
  /*
   * Recording what a grant was for. A different endpoint from amendAward
   * above, and deliberately so: an amendment moves a term and demands a
   * written reason; this writes down the subject matter of a grant already
   * made. Omitted fields are left alone, an explicit null clears one.
   */
  describeAward: (
    awardId: string,
    body: {
      projectTitle?: string | null;
      purpose?: string | null;
      focusArea?: string | null;
      countiesServed?: string[] | null;
      expectedUpdatedAt?: string;
    },
  ) =>
    request<{ awardId: string; changed: string[]; updatedAt: string }>(
      `/api/awards/${encodeURIComponent(awardId)}/subject`,
      { method: 'PATCH', body },
    ),
  awardPaperwork: (awardId: string, signal?: AbortSignal) =>
    get<AwardPaperwork>(`/api/awards/${encodeURIComponent(awardId)}/paperwork`, signal),
  recordAwardDocument: (
    awardId: string,
    document: 'w9' | 'agreement' | 'media_release',
    receivedAt: string | null,
  ) =>
    request<{ awardId: string; document: string; receivedAt: string | null }>(
      `/api/awards/${encodeURIComponent(awardId)}/document`,
      { method: 'POST', body: { document, receivedAt } },
    ),
  reviewCoverage: (cycleId: string, signal?: AbortSignal) =>
    get<Coverage>(`/api/cycles/${encodeURIComponent(cycleId)}/review-coverage`, signal),
  cycleConflicts: (cycleId: string, signal?: AbortSignal) =>
    get<{ conflicts: OutstandingConflict[] }>(
      `/api/cycles/${encodeURIComponent(cycleId)}/conflicts`,
      signal,
    ),
  clearConflict: (assignmentId: string, resolution: string) =>
    request<{ ok: true }>(
      `/api/review/assignments/${encodeURIComponent(assignmentId)}/conflict/clear`,
      { method: 'POST', body: { resolution } },
    ),
  recuse: (assignmentId: string, reason: string) =>
    request<{ ok: true }>(
      `/api/review/assignments/${encodeURIComponent(assignmentId)}/recuse`,
      { method: 'POST', body: { reason } },
    ),
  scoreSummary: (applicationId: string, signal?: AbortSignal) =>
    get<ScoreSummary>(`/api/applications/${encodeURIComponent(applicationId)}/scores`, signal),
  decide: (applicationId: string, status: string, notes: string | null) =>
    request<{ applicationId: string; status: string; decidedAt: string; decidedBy: string }>(
      `/api/applications/${encodeURIComponent(applicationId)}/decision`,
      { method: 'POST', body: { status, notes } },
    ),
  rubrics: (programId: string, signal?: AbortSignal) =>
    get<{ rubrics: RubricRow[] }>(
      `/api/programs/${encodeURIComponent(programId)}/rubrics`,
      signal,
    ),
  rubric: (rubricId: string, signal?: AbortSignal) =>
    get<RubricDetail>(`/api/rubrics/${encodeURIComponent(rubricId)}`, signal),
  createRubric: (programId: string, name: string, rubricKey: string) =>
    request<{ rubricId: string; version: number }>(
      `/api/programs/${encodeURIComponent(programId)}/rubrics`,
      { method: 'POST', body: { name, rubricKey } },
    ),
  saveRubricCriteria: (rubricId: string, criteria: CriterionInput[]) =>
    request<{ rubricId: string; criteria: number; maxTotalScoreBp: number }>(
      `/api/rubrics/${encodeURIComponent(rubricId)}/criteria`,
      { method: 'PATCH', body: { criteria } },
    ),
  publishRubric: (rubricId: string) =>
    request<{ rubricId: string; version: number; maxTotalScoreBp: number; retiredRubricId: string | null }>(
      `/api/rubrics/${encodeURIComponent(rubricId)}/publish`,
      { method: 'POST', body: {} },
    ),
  newRubricVersion: (rubricId: string) =>
    request<{ rubricId: string; version: number }>(
      `/api/rubrics/${encodeURIComponent(rubricId)}/new-version`,
      { method: 'POST', body: {} },
    ),
  attachRubric: (cycleId: string, rubricId: string) =>
    request<{ cycleId: string; rubricId: string }>(
      `/api/cycles/${encodeURIComponent(cycleId)}/rubric`,
      { method: 'POST', body: { rubricId } },
    ),
  retention: (signal?: AbortSignal) => get<RetentionScreen>('/api/retention', signal),
  todo: (signal?: AbortSignal) => get<TodoScreen>('/api/todo', signal),
  award: (id: string, signal?: AbortSignal) =>
    get<AwardOverview>(`/api/awards/${encodeURIComponent(id)}`, signal),
  impact: (year: number | null, signal?: AbortSignal) =>
    get<Impact>(`/api/impact${year === null ? '' : `?year=${year}`}`, signal),
  awards: (query: string, signal?: AbortSignal) =>
    get<{ rows: AwardListRow[]; total: number }>(
      `/api/awards${query ? `?${query}` : ''}`,
      signal,
    ),
  organizations: (query: string, signal?: AbortSignal) =>
    get<{ rows: OrganizationListRow[]; total: number }>(
      `/api/organizations${query ? `?${query}` : ''}`,
      signal,
    ),
  organization: (id: string, signal?: AbortSignal) =>
    get<OrganizationOverview>(`/api/organizations/${encodeURIComponent(id)}`, signal),
  /*
   * The public-listing flag. The endpoint has existed since the public grants
   * page shipped and nothing has ever called it, so an award could be made
   * public only by editing the database.
   */
  setAwardPublic: (id: string, isPublic: boolean) =>
    request<{ awardId: string; isPublic: boolean }>(
      `/api/awards/${encodeURIComponent(id)}/public`,
      { method: 'POST', body: { isPublic } },
    ),
  generateAwardReportPeriods: (id: string) =>
    request<{ created: number; skipped: string[] }>(
      `/api/awards/${encodeURIComponent(id)}/report-periods`,
      { method: 'POST', body: {} },
    ),
  holdAttachment: (attachmentId: string, until: string, reason: string) =>
    request<{ attachmentId: string; holdUntil: string }>(
      `/api/attachments/${encodeURIComponent(attachmentId)}/retention-hold`,
      { method: 'POST', body: { until, reason } },
    ),
  purgeAttachment: (attachmentId: string, reason: string) =>
    request<{ attachmentId: string; purgedAt: string }>(
      `/api/attachments/${encodeURIComponent(attachmentId)}/purge`,
      { method: 'POST', body: { reason } },
    ),
  downloadUrl: (attachmentId: string) =>
    request<DownloadGrant>(
      `/api/attachments/${encodeURIComponent(attachmentId)}/download-url`,
      { method: 'POST', body: {} },
    ),
  requestUpdates: (
    programId: string,
    body: { awardedFrom: string; awardedTo: string; label: string; dueDate: string; dryRun: boolean },
  ) =>
    request<RequestUpdatesResult>(
      `/api/programs/${encodeURIComponent(programId)}/request-updates`,
      { method: 'POST', body },
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
  /*
   * Configuration writes.
   *
   * Every one of these routes already existed and nothing called them, so a
   * program, a stage or a cycle could only be created by applying a seed file
   * or by hand with curl -- which meant no real application round could be
   * started from the app at all.
   *
   * All admin-only on the server. The screen hides them from a reviewer as
   * well, so nobody is offered a control that answers FORBIDDEN.
   */
  createProgram: (body: {
    name: string;
    description?: string;
    fiscal_year?: number;
    compliance_policy?: 'block' | 'warn' | 'ignore';
    total_budget_cents?: number;
  }) => request<{ program: ProgramRow }>('/api/programs', { method: 'POST', body }),

  createCycle: (
    programId: string,
    body: {
      name: string;
      /** UTC instants. The form converts from Central before calling. */
      opens_at: string;
      closes_at: string;
      draft_grace_hours?: number;
    },
  ) =>
    request<{ cycle: CycleRow }>(`/api/programs/${encodeURIComponent(programId)}/cycles`, {
      method: 'POST',
      body,
    }),

  updateCycle: (
    id: string,
    body: Partial<{ name: string; opens_at: string; closes_at: string; draft_grace_hours: number }>,
  ) => request<{ cycle: CycleRow }>(`/api/cycles/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

  /**
   * Open or close a cycle.
   *
   * OPENING MAKES A PUBLIC FORM LIVE and starts a deadline. The server refuses
   * an illegal transition (a closed cycle cannot be closed again), so the UI
   * does not have to model the state machine -- only to make the press
   * deliberate.
   */
  setCycleStatus: (id: string, next: 'open' | 'closed') => {
    /*
     * THE STATUS AND THE ENDPOINT ARE DIFFERENT VOCABULARIES.
     *
     * Callers reason in statuses, because that is what the cycle row holds and
     * what the confirm dialog talks about. The routes are verbs: /open and
     * /close. Interpolating the status straight into the path worked for
     * 'open' by coincidence and produced /closed -- a 404 -- for every close
     * anyone ever attempted. Opening a cycle makes a public form live; closing
     * one is the only way to stop it. The failure was on the safety-critical
     * side of that pair.
     *
     * The two URLs are written out in full rather than built from a variable
     * verb. That is deliberate and worth keeping: a path whose verb segment is
     * interpolated cannot be checked against the server's route table without
     * running it, and test/clientServerRoutes.test.ts does exactly that check
     * statically. Spelling both out turns this seam into a build-time error.
     */
    const cycle = encodeURIComponent(id);
    const url =
      next === 'closed' ? `/api/cycles/${cycle}/close` : `/api/cycles/${cycle}/open`;
    return request<{ cycle: CycleRow }>(url, { method: 'POST', body: {} });
  },

  previewAwardImport: (csv: string) =>
    request<ImportPreview>('/api/awards/import/preview', { method: 'POST', body: { csv } }),
  runAwardImport: (csv: string) =>
    request<ImportRunResult>('/api/awards/import', { method: 'POST', body: { csv } }),
  generateReportPeriods: () =>
    request<BulkGenerateResult>('/api/report-periods/generate', { method: 'POST', body: {} }),
  /*
   * A GET, matching the server: the plan writes nothing. See
   * src/lib/reportReminders.ts for why it is a separate function there rather
   * than a flag on the run.
   */
  reminderPlan: (signal?: AbortSignal) =>
    get<ReminderPlan>('/api/report-reminders/plan', signal),
  /*
   * `expectLetters` is the count the panel was SHOWN. The server refuses the
   * run if the plan has changed since, and sends nothing. The panel must pass
   * what it displayed, never a freshly fetched number -- passing a fresh one
   * would defeat the entire check.
   */
  runRemindersNow: (expectLetters: number) =>
    request<ConfirmedReminderRun>('/api/report-reminders/run', {
      method: 'POST',
      body: { expectLetters },
    }),
  dataHealth: (signal?: AbortSignal) => get<HealthReport>('/api/data-health', signal),
  storage: (signal?: AbortSignal) => get<StorageUsage>('/api/storage', signal),
  searchAwards: (q: string, signal?: AbortSignal) =>
    get<{ awards: AwardChoice[] }>(`/api/awards/search?q=${encodeURIComponent(q)}`, signal),
  granteeClaims: (signal?: AbortSignal) =>
    get<{ claims: GranteeClaimRow[] }>('/api/grantee-claims', signal),
  approveGranteeClaim: (id: string, awardId: string, note: string | null) =>
    request<{ claimId: string; userId: string; awardId: string; periodsCreated: number }>(
      `/api/grantee-claims/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body: { awardId, note } },
    ),
  rejectGranteeClaim: (id: string, note: string) =>
    request<{ claimId: string }>(
      `/api/grantee-claims/${encodeURIComponent(id)}/reject`,
      { method: 'POST', body: { note } },
    ),
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
  /*
   * Moving a deadline. The reason is not optional and the server refuses a
   * past date -- a past due date is a born-overdue obligation, which is worse
   * by hand because somebody typed it.
   */
  moveReportDueDate: (id: string, dueDate: string, reason: string) =>
    request<{
      reportPeriodId: string;
      previousDueDate: string;
      dueDate: string;
      amendedAt: string;
    }>(`/api/reports/${encodeURIComponent(id)}/due-date`, {
      method: 'POST',
      body: { dueDate, reason },
    }),
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

/** What R2 holds, and what it costs. See src/lib/dataHealth.ts. */
/** One past grant, and what an update request would do about it. */
export interface UpdateRequestRow {
  awardId: string;
  organizationName: string;
  awardedAmountCents: number;
  awardedAt: string;
  skipped: string | null;
}

export interface RequestUpdatesResult {
  label: string;
  dueDate: string;
  /** Null when the program has no published report form yet. */
  formDefinitionId: string | null;
  willAsk: UpdateRequestRow[];
  skipped: UpdateRequestRow[];
  created: number;
  dryRun: boolean;
}

/**
 * What tonight's reminder run would do. Mirrors ReminderPlan in
 * src/lib/reportReminders.ts.
 */
export interface ReminderPlanOrg {
  organizationId: string;
  organizationName: string;
  /** Addresses that would be written to. Empty means nobody is reachable. */
  recipients: string[];
  reports: {
    reportPeriodId: string;
    label: string;
    programName: string;
    dueDate: string;
    /** Negative when the report is already late. */
    daysUntilDue: number;
    status: string;
  }[];
}

export interface ReminderPlan {
  now: string;
  outstanding: number;
  wouldMail: ReminderPlanOrg[];
  withNoContact: ReminderPlanOrg[];
  lettersWouldSend: number;
  /** False means nothing would actually arrive: no provider is configured. */
  transportConfigured: boolean;
}

export interface ConfirmedReminderRun {
  outstanding: number;
  granteesMailed: number;
  messagesRecorded: number;
  suppressed: number;
  failed: number;
  withNoContact: number;
  plan: ReminderPlan;
}

export interface StorageUsage {
  totalBytes: number;
  byParent: { parentType: string; files: number; bytes: number }[];
  /** Report bytes carrying no deletion date: what nothing will ever remove. */
  unretainedBytes: number;
  /** Photographs and video. The part that actually grows. */
  mediaBytes: number;
  mediaFiles: number;
  estimatedMonthlyUsd: number;
  overWatchThreshold: boolean;
}

/** A nonprofit asking to be connected to a grant. Granting is a human act. */
export interface GranteeClaimRow {
  id: string;
  organizationName: string;
  ein: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  contactJobTitle: string | null;
  grantYear: number | null;
  grantDescription: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  /** What the system suggested. Advisory; the reviewer chooses. */
  matchedOrganizationName: string | null;
  matchedAwardId: string | null;
  matchedAwardLabel: string | null;
  grantedAwardId: string | null;
  /**
   * What the access ACTUALLY went to, once a claim is approved. Null before
   * that. Deliberately separate from organizationName, which is whatever the
   * claimant typed: the two differ exactly when somebody should be looking.
   */
  grantedOrganizationName: string | null;
  grantedAwardLabel: string | null;
}

/** An award a reviewer can connect a claim to. See src/lib/granteeClaims.ts. */
export interface AwardChoice {
  id: string;
  organizationName: string;
  ein: string | null;
  programName: string;
  awardedAmountCents: number;
  awardedYear: string;
  status: string;
  /** Null when nobody holds it yet. A name here is a reason to look twice. */
  alreadyHeldBy: string | null;
}
