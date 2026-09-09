/**
 * The file upload control an applicant actually uses.
 *
 * Three things it is built around, in order of how much they matter:
 *
 *   1. IT NEVER BLOCKS THE FORM. Uploading happens beside the form, not in
 *      front of it. Somebody who attaches a 7 MB audited statement on a hotel
 *      connection can carry on writing their narrative while it goes.
 *   2. FILES ARE REPLACEABLE BEFORE SUBMIT. Attaching the wrong year's
 *      financials is the single most predictable mistake on a form like this.
 *      Removing one is one click and needs no explanation.
 *   3. IT SAYS WHAT HAPPENED. A failed upload names the file and says whether
 *      trying again is worth it, because "Upload failed" next to three
 *      attachments tells nobody which one.
 */

import { useCallback, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { FieldDef } from '../../src/lib/fieldTypes';
import { formatBytes, uploadFile, UploadError, type AttachmentRef } from './uploadFile';

interface InFlight {
  /** Local id, because two files can share a name. */
  key: string;
  filename: string;
  sizeBytes: number;
  fraction: number | null;
}

interface Props {
  field: FieldDef;
  applicationId: string;
  value: AttachmentRef[];
  onChange: (next: AttachmentRef[]) => void;
  onBlur: () => void;
  inputProps: Record<string, unknown>;
}

export function UploadField({
  field,
  applicationId,
  value,
  onChange,
  onBlur,
  inputProps,
}: Props): ReactElement {
  const maxFiles = field.validation?.max_files ?? 1;
  const [inFlight, setInFlight] = useState<InFlight[]>([]);
  const [failures, setFailures] = useState<{ filename: string; message: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // Read through a ref inside the async loop: `value` is captured at the start
  // and two files finishing together would each write the same stale list, so
  // the second attachment would silently replace the first.
  const latest = useRef(value);
  latest.current = value;

  const remaining = Math.max(0, maxFiles - value.length - inFlight.length);

  const start = useCallback(
    async (files: File[]) => {
      setFailures([]);
      const accepted = files.slice(0, remaining);
      if (files.length > accepted.length) {
        setFailures((f) => [
          ...f,
          {
            filename: '',
            message: `You can attach ${maxFiles} file${maxFiles === 1 ? '' : 's'} here. Remove one to add another.`,
          },
        ]);
      }

      await Promise.all(
        accepted.map(async (file) => {
          const key = `${file.name}:${file.size}:${Math.random()}`;
          setInFlight((f) => [
            ...f,
            { key, filename: file.name, sizeBytes: file.size, fraction: null },
          ]);
          try {
            const ref = await uploadFile(applicationId, field, file, (p) => {
              setInFlight((f) =>
                f.map((x) => (x.key === key ? { ...x, fraction: p.fraction } : x)),
              );
            });
            onChange([...latest.current, ref]);
          } catch (err) {
            const message =
              err instanceof UploadError
                ? err.message
                : 'Something went wrong with that upload. Please try again.';
            setFailures((f) => [...f, { filename: file.name, message }]);
          } finally {
            setInFlight((f) => f.filter((x) => x.key !== key));
          }
        }),
      );
      // Let the same file be chosen again after a failure or a removal.
      // Without this, picking the identical file fires no change event.
      if (inputRef.current) inputRef.current.value = '';
      onBlur();
    },
    [applicationId, field, maxFiles, onBlur, onChange, remaining],
  );

  const remove = useCallback(
    (attachmentId: string) => {
      // The attachment row on the server keeps existing, unclaimed. Submit only
      // ever attaches what the answer still references, so a removed file is
      // simply never claimed -- no delete, and nothing to get wrong.
      onChange(latest.current.filter((r) => r.attachment_id !== attachmentId));
      onBlur();
    },
    [onBlur, onChange],
  );

  return (
    <div className="upload">
      {value.length > 0 && (
        <ul className="upload-list">
          {value.map((ref) => (
            <li key={ref.attachment_id}>
              <span className="upload-name">{ref.filename}</span>
              <button
                type="button"
                className="linklike"
                onClick={() => remove(ref.attachment_id)}
              >
                Remove<span className="sr-only"> {ref.filename}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {inFlight.length > 0 && (
        <ul className="upload-list" aria-live="polite">
          {inFlight.map((f) => (
            <li key={f.key}>
              <span className="upload-name">{f.filename}</span>
              <span className="upload-progress">
                {f.fraction === null
                  ? 'Uploading…'
                  : `Uploading ${Math.round(f.fraction * 100)}%`}
              </span>
              {/*
                A real progress element, so assistive technology gets the value
                rather than a coloured div. Indeterminate when the browser will
                not tell us the total.
              */}
              <progress
                {...(f.fraction === null ? {} : { value: f.fraction, max: 1 })}
                aria-label={`Uploading ${f.filename}`}
              />
              <span className="upload-size">{formatBytes(f.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      )}

      <input
        {...inputProps}
        ref={inputRef}
        type="file"
        multiple={maxFiles > 1}
        disabled={remaining === 0}
        accept={(field.validation?.allowed_mime ?? []).join(',') || undefined}
        onChange={(e) => void start(Array.from(e.target.files ?? []))}
      />

      {remaining === 0 && value.length > 0 && (
        <p className="help">
          {maxFiles === 1
            ? 'Remove the file above to attach a different one.'
            : `That is all ${maxFiles} files. Remove one to attach another.`}
        </p>
      )}

      {failures.length > 0 && (
        <div className="upload-errors" role="alert">
          {failures.map((f, i) => (
            <p key={`${f.filename}-${i}`} className="error">
              {f.filename ? <strong>{f.filename}: </strong> : null}
              {f.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
