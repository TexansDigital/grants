/**
 * Putting one file into R2, from the browser.
 *
 * THE ONE RULE THAT LOOKS LIKE A DETAIL AND IS NOT.
 *
 * The Worker signs the URL with `signQuery`, which signs the host header and
 * nothing else. If the browser then sends a `Content-Type` header, R2 rejects
 * the PUT with a 403 that does not reproduce in curl -- because curl was never
 * adding the header in the first place. Debugging that from the outside is a
 * bad afternoon, and CLAUDE.md records it as learned the hard way.
 *
 * Both obvious ways of sending a file add the header for you. `fetch(url,
 * { body: file })` sets Content-Type from the Blob's type, and so does
 * `xhr.send(file)`. Neither can be talked out of it by deleting the header
 * afterwards. What DOES work is giving them a body whose type is the empty
 * string, because a typeless body produces no Content-Type at all:
 *
 *     file.slice(0, file.size, '')
 *
 * That is a view over the same bytes, not a copy, so an 8 MB financial
 * statement is not duplicated in memory to satisfy a header rule.
 *
 * XHR rather than fetch, because fetch still cannot report upload progress and
 * a nonprofit on a slow connection deserves a bar rather than a frozen page.
 */

import type { FieldDef } from '../../src/lib/fieldTypes';
import { validateUploadIntent } from '../../src/lib/fieldTypes';
import { applicantApi } from './applicantApi';
import { ApiError } from './http';

/** The answer shape a file_upload field stores. */
export interface AttachmentRef {
  attachment_id: string;
  filename: string;
}

/** Whatever is stored, as a list of refs. A malformed answer becomes empty. */
export function asRefs(value: unknown): AttachmentRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is AttachmentRef =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as AttachmentRef).attachment_id === 'string' &&
      typeof (r as AttachmentRef).filename === 'string',
  );
}

export interface UploadProgress {
  /** 0 to 1, or null when the browser will not say. */
  fraction: number | null;
  stage: 'checking' | 'authorizing' | 'uploading' | 'done';
}

export class UploadError extends Error {
  /** True when trying the same file again is pointless. */
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'UploadError';
    this.permanent = permanent;
  }
}

/**
 * PUT the bytes, reporting progress.
 *
 * Separated from the orchestration below so a test can drive the check and the
 * authorize steps without a real network, and so this function stays small
 * enough to read against the rule it exists to obey.
 */
/**
 * The slice of XMLHttpRequest this file uses.
 *
 * Declared structurally, and resolved off globalThis at call time, for two
 * reasons. The Worker tsconfig follows this module in through its tests and
 * type-checks it against the Workers lib, which has no DOM: referring to the
 * global `XMLHttpRequest` type there is an error, and adding the DOM lib to the
 * Worker config to silence it would let genuinely browser-only APIs compile
 * into Worker code unnoticed. Reading it late also lets a test substitute a
 * recording implementation, which is how the header rule below is actually
 * proven rather than asserted about our own arguments.
 */
interface UploadXhr {
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  status: number;
  upload: { onprogress: ((e: ProgressLike) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

interface ProgressLike {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

export function putToR2(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (fraction: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const Ctor = (globalThis as unknown as { XMLHttpRequest: new () => UploadXhr })
      .XMLHttpRequest;
    const xhr = new Ctor();
    xhr.open('PUT', url, true);

    // Whatever the server said to send, verbatim. It says to send nothing.
    // Spread rather than assumed-empty so that if the signing rules ever
    // change, this is not the place that has to change with them.
    for (const [k, value] of Object.entries(headers)) xhr.setRequestHeader(k, value);

    xhr.upload.onprogress = (e) => {
      onProgress(e.lengthComputable ? e.loaded / e.total : null);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      // 403 here is almost always the Content-Type rule, and saying so in the
      // log saves the next person the afternoon it cost the first time.
      reject(
        new UploadError(
          xhr.status === 403
            ? 'That upload was refused by storage. Please try again, or tell us if it keeps happening.'
            : 'The upload did not finish. Please try again.',
          false,
        ),
      );
    };
    xhr.onerror = () =>
      reject(new UploadError('The upload was interrupted. Please try again.', false));
    xhr.onabort = () => reject(new UploadError('Upload cancelled.', true));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    // The typeless view. See the note at the top of this file.
    xhr.send(file.slice(0, file.size, ''));
  });
}

/**
 * Check, authorize, upload.
 *
 * The client-side check uses the SAME function the Worker uses, so the two can
 * never disagree about what is allowed. It exists only to fail fast with a
 * clear message; the server re-validates, and the server is the one that
 * counts -- a presigned URL is a credential, and a client check is a courtesy.
 */
export async function uploadFile(
  applicationId: string,
  field: FieldDef,
  file: File,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<AttachmentRef> {
  onProgress({ fraction: null, stage: 'checking' });

  const intent = {
    fieldKey: field.field_key,
    filename: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  };

  const check = validateUploadIntent(field, intent);
  if (!check.ok) throw new UploadError(check.message, true);

  onProgress({ fraction: null, stage: 'authorizing' });

  let presigned;
  try {
    presigned = await applicantApi.presignUpload(applicationId, intent);
  } catch (err) {
    if (err instanceof ApiError) {
      // The server's message, not ours: it knows why it refused, and it has
      // already decided what an applicant may be told.
      throw new UploadError(err.message, err.status === 400 || err.status === 409);
    }
    throw new UploadError('Could not start the upload. Please try again.', false);
  }

  onProgress({ fraction: 0, stage: 'uploading' });
  await putToR2(
    presigned.uploadUrl,
    presigned.headers,
    file,
    (fraction) => onProgress({ fraction, stage: 'uploading' }),
    signal,
  );
  onProgress({ fraction: 1, stage: 'done' });

  // The filename is echoed from what was sent. The server sanitises its own
  // copy; this is what the applicant sees on their own screen until they
  // reload, at which point the server's version is what comes back.
  return { attachment_id: presigned.attachmentId, filename: file.name };
}

/** Human file size. Whole numbers below 10 MB read better than 8.4 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}
