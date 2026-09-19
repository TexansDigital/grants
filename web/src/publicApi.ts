/**
 * The public API — the only calls a browser makes before anybody signs in.
 *
 * Separate from applicantApi because a 401 is not a thing that can happen
 * here. There is no session to lapse; these endpoints are open, and the only
 * failure they have is a cycle that shut between the page loading and somebody
 * pressing a button.
 */

import { request } from './http';
import type { FormDefinition } from '../../src/lib/forms';

export interface FormShape {
  questions: number;
  writtenAnswers: number;
  documents: number;
}

export interface OpenCycle {
  id: string;
  name: string;
  programName: string;
  programDescription: string | null;
  closesAt: string;
  /** Already in Central, carrying the zone name. The browser does not guess. */
  closesAtDisplay: string;
  opensAtDisplay: string;
  guidelinesVersion: string | null;
  firstStageName: string | null;
  formDefinitionId: string;
  shape: FormShape | null;
  /** The program refuses a new application while a grant report is outstanding. */
  requiresReportsFiled: boolean;
}

export interface EligibilityResponse {
  message: string;
  email: string;
}

const enc = encodeURIComponent;

export const publicApi = {
  cycles: (signal?: AbortSignal) =>
    request<{ cycles: OpenCycle[]; turnstileSiteKey: string | null }>(
      '/api/public/cycles',
      signal ? { signal } : {},
    ),

  form: (formDefinitionId: string, signal?: AbortSignal) =>
    request<{ form: FormDefinition }>(
      `/api/public/forms/${enc(formDefinitionId)}`,
      signal ? { signal } : {},
    ),

  submitEligibility: (
    cycleId: string,
    answers: Record<string, unknown>,
    turnstileToken: string | null,
  ) =>
    request<EligibilityResponse>('/api/public/eligibility', {
      method: 'POST',
      body: { cycleId, answers, ...(turnstileToken ? { turnstileToken } : {}) },
    }),
};
