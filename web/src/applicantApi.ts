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

export interface StartedApplication {
  application: { id: string; status: string; stage_key: string };
}

export const applicantApi = {
  /**
   * Start, or continue to, the next stage of an application.
   *
   * THE SERVER DECIDES WHICH STAGE. This does not say "the full application"
   * and must not: the endpoint walks the program's stages, finds the first one
   * this organization has not started, and checks the gate on the one before
   * it. A client that worked out the answer itself would be a second copy of
   * that rule, and the two would disagree the first time a program used three
   * stages.
   *
   * It answers 409 when every stage is already started and 403 when the
   * previous step is not finished. Both carry a message written for an
   * applicant, so the caller shows it rather than inventing one.
   */
  startApplication: (cycleId: string) =>
    // `body` is the OBJECT, not a string: request() serializes it and sets the
    // content-type. Passing a string here double-encodes it into a JSON string
    // and the Worker reads no cycleId at all.
    request<StartedApplication>('/api/applications', { method: 'POST', body: { cycleId } }),

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

  /**
   * Authorize one read of a file this organization uploaded.
   *
   * SAME CALL ON BOTH SURFACES, because it is scoped by the session's
   * organization rather than by which page asked. An applicant checking a
   * draft attachment and a grantee re-reading what they filed with a report
   * are the same exchange.
   *
   * The URL that comes back is a CREDENTIAL with a few minutes on it. Hand it
   * straight to the browser and do not keep it: anything that holds it -- a
   * log, a state store that survives navigation, a retry buffer -- is holding
   * a live handle on somebody's audited accounts.
   */
  downloadUrl: (attachmentId: string) =>
    request<{ attachmentId: string; filename: string; url: string; expiresAt: string }>(
      `/api/portal/attachments/${enc(attachmentId)}/download-url`,
      { method: 'POST' },
    ),

  /** Authorize one upload. Same exchange on both surfaces; only the path differs. */
  presignUploadAt: (
    path: string,
    intent: { fieldKey: string; filename: string; mimeType: string; sizeBytes: number },
  ) =>
    request<PresignResponse>(path, { method: 'POST', body: intent }),
};
