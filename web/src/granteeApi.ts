/**
 * The grantee portal's view of the API.
 *
 * Money crosses this boundary as INTEGER CENTS and is formatted at the display
 * edge with the same formatCents the Worker and the confirmation email use. A
 * portal that did its own division is a portal that eventually shows somebody
 * $187.50 of a $18,750 grant.
 */

import { request } from './http';
import type { FormDefinition } from '../../src/lib/forms';

export type ReportState =
  | 'open'
  | 'not_open_yet'
  | 'in_progress'
  | 'submitted'
  | 'changes_requested'
  | 'accepted'
  | 'waived'
  | 'no_form_yet';

export interface ReportSummary {
  id: string;
  label: string;
  type: string;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string;
  opensAt: string | null;
  state: ReportState;
  outstanding: boolean;
  submittedAt: string | null;
  /** Staff feedback, present only when changes were requested. */
  feedback: string | null;
  /** What was filed with the latest submission, so it can be read back. */
  attachments: { id: string; filename: string; sizeBytes: number }[];
}

export interface AwardSummary {
  id: string;
  program: string;
  /** Integer cents. Formatted at the display edge, never here. */
  amountCents: number;
  awardedAt: string;
  termStart: string | null;
  termEnd: string | null;
  status: string;
  reports: ReportSummary[];
}

/**
 * One of this organization's applications, as the applicant may see it.
 *
 * `status` is MASKED server-side: an application reads `under_review` until a
 * human has actually communicated the decision, however long ago an admin
 * recorded it. Nothing on this surface should re-derive an outcome from any
 * other field.
 */
export interface ApplicationSummary {
  id: string;
  status: string;
  projectTitle: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
  programName: string | null;
  cycleName: string | null;
}

export interface GranteeHomeResponse {
  organization: { name: string | null };
  awards: AwardSummary[];
  /** Every application this organization has, newest first. */
  applications: ApplicationSummary[];
}

export interface ReportResponse {
  report: {
    id: string;
    label: string;
    type: string;
    periodStart: string | null;
    periodEnd: string | null;
    dueDate: string;
    state: ReportState;
    canFile: boolean;
    feedback: string | null;
    savedAt: string | null;
  };
  award: {
    program: string | null;
    amountCents: number | null;
    termStart: string | null;
    termEnd: string | null;
  };
  answers: Record<string, unknown>;
  /** Absent when the report is closed: there is nothing to fill in. */
  form?: FormDefinition;
  uploadFields?: string[];
}

export interface FileReportResponse {
  reportSubmissionId: string;
  submittedAt: string;
  metricsRecorded: number;
}

const enc = encodeURIComponent;

export interface PendingAward {
  id: string;
  programName: string;
  awardedAmountCents: number;
  awardedAt: string;
  /** When they may talk about it publicly. Null when there is no embargo. */
  announcementDate: string | null;
  termStart: string | null;
  termEnd: string | null;
  projectTitle: string | null;
}

export const granteeApi = {
  home: (signal?: AbortSignal) =>
    request<GranteeHomeResponse>('/api/grantee/home', signal ? { signal } : {}),

  report: (reportPeriodId: string, signal?: AbortSignal) =>
    request<ReportResponse>(
      `/api/grantee/reports/${enc(reportPeriodId)}`,
      signal ? { signal } : {},
    ),

  file: (reportPeriodId: string, answers: Record<string, unknown>) =>
    request<FileReportResponse>(`/api/grantee/reports/${enc(reportPeriodId)}/submit`, {
      method: 'POST',
      body: { answers },
    }),

  pendingAwards: (signal?: AbortSignal) =>
    request<{ awards: PendingAward[] }>('/api/my/awards', signal ? { signal } : {}),

  /*
   * The attestation text is sent BACK to the server, not just checked here.
   * It lands on the audit row, so what the grantee actually agreed to survives
   * a later change to the wording on this page.
   */
  acceptAward: (awardId: string, attestationText: string) =>
    request<{ awardId: string; acceptedAt: string; reportPeriodsCreated: number }>(
      `/api/my/awards/${enc(awardId)}/accept`,
      { method: 'POST', body: { attestationText } },
    ),

  declineAward: (awardId: string, reason: string) =>
    request<{ awardId: string; declinedAt: string }>(
      `/api/my/awards/${enc(awardId)}/decline`,
      { method: 'POST', body: { reason } },
    ),
};
