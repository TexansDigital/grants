/**
 * The external front door.
 *
 * One call. A nonprofit types an address, we mail a link, and that is the
 * whole of it -- no password to choose, forget, reuse or leak, and nothing for
 * this code to store.
 *
 * The server answers the SAME acknowledgement whether or not the address is
 * known, so nothing here should ever try to report "no account found". Doing
 * so would turn this endpoint into a way to ask which nonprofits have applied
 * for a grant, one address at a time.
 */

import { request } from './http';

export interface RequestLinkResponse {
  /** The neutral acknowledgement. Identical for a known and unknown address. */
  message: string;
}

export const authApi = {
  requestLink: (email: string, turnstileToken: string | null) =>
    request<RequestLinkResponse>('/api/auth/request-link', {
      method: 'POST',
      body: { email, ...(turnstileToken ? { turnstileToken } : {}) },
    }),
};
