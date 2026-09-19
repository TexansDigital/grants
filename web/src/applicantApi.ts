/**
 * The applicant's view of the API.
 *
 * Separate from `api.ts` because the two audiences differ in what a 401 means.
 * Staff sit behind Cloudflare Access, so a lapsed session is fixed by reloading
 * and letting Access re-authenticate. An applicant holds an app-native session
 * from a magic link, and a lapsed one means going back to the sign-in page --
 * reloading would just show them the same 401 again.
 */

import { request } from './http';
import type { FormDefinition } from '../../src/lib/forms';

export interface DraftResponse {
  application: { id: string; status: string; updated_at: string };
  form: FormDefinition;
  answers: Record<string, unknown>;
}

export interface SaveResponse {
  savedAt: string;
  /** Type problems worth surfacing mid-draft. Required-ness is a submit concern. */
  errors: { field: string; message: string }[];
}

export interface SubmitResponse {
  applicationId: string;
  submittedAt: string;
  confirmationCode: string;
  /**
   * Already formatted, in the program's display timezone, carrying the zone
   * name. The browser does not know which zone the Foundation announces in,
   * and formatting it here would disagree with the confirmation email.
   */
  submittedAtDisplay: string;
}

export interface PresignResponse {
  attachmentId: string;
  uploadUrl: string;
  expiresAt: string;
  /**
   * Headers to send with the PUT. The server returns an empty object and it is
   * spread verbatim: see the R2 rules in src/lib/uploads.ts. Adding anything
   * here produces a 403 that does not reproduce in curl.
   */
  headers: Record<string, string>;
}

const enc = encodeURIComponent;

export const draftPathFor = (applicationId: string) =>
  `/api/applications/${enc(applicationId)}/draft`;
export const uploadPathFor = (applicationId: string) =>
  `/api/applications/${enc(applicationId)}/uploads`;
export const reportDraftPathFor = (reportPeriodId: string) =>
  `/api/grantee/reports/${enc(reportPeriodId)}/draft`;
export const reportUploadPathFor = (reportPeriodId: string) =>
  `/api/grantee/reports/${enc(reportPeriodId)}/uploads`;

export const applicantApi = {
  draft: (applicationId: string, signal?: AbortSignal) =>
    request<DraftResponse>(
      `/api/applications/${enc(applicationId)}/draft`,
      signal ? { signal } : {},
    ),

  /**
   * Autosave, addressed by ENDPOINT rather than by application id.
   *
   * An applicant's draft and a grantee's report draft are the same exchange --
   * post the answers, get back a saved-at and any type errors -- against two
   * different paths. Taking the path is what lets one autosave engine, one
   * indicator and one set of tests serve both, instead of a second copy that
   * drifts.
   */
  saveDraftAt: (path: string, answers: Record<string, unknown>, signal?: AbortSignal) =>
    request<SaveResponse>(path, {
      method: 'PATCH',
      body: { answers },
      ...(signal ? { signal } : {}),
    }),

  submit: (
    applicationId: string,
    answers: Record<string, unknown>,
    guidelinesVersion?: string,
  ) =>
    request<SubmitResponse>(`/api/applications/${enc(applicationId)}/submit`, {
      method: 'POST',
      body: { answers, ...(guidelinesVersion ? { guidelinesVersion } : {}) },
    }),

  /** Authorize one upload. Same exchange on both surfaces; only the path differs. */
  presignUploadAt: (
    path: string,
    intent: { fieldKey: string; filename: string; mimeType: string; sizeBytes: number },
  ) =>
    request<PresignResponse>(path, { method: 'POST', body: intent }),
};
