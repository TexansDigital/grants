/**
 * One rendered field, for every field type the engine supports.
 *
 * Rules this file follows without exception:
 *
 *  - Every control has a real <label> bound by id, or sits in a <fieldset> with
 *    a <legend>. No placeholder-as-label.
 *  - Help text and the error message are wired into aria-describedby, so a
 *    screen reader announces the reason a field is rejected, not just that it
 *    is invalid.
 *  - Error text is a sentence a person can act on. Colour never carries the
 *    meaning on its own: the word "Error:" is rendered too.
 *  - Inputs are 16px minimum. Below that iOS Safari zooms on focus and the
 *    applicant loses their place on the page.
 *
 * The validation MESSAGES are not written here. They come from coerceAnswer in
 * src/lib/fieldTypes.ts -- the same function the Worker runs on submit -- so
 * the browser can never accept something the server will reject.
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import { UploadField } from './UploadField';
import { asRefs } from './uploadFile';
import type { FieldDef } from '../../src/lib/fieldTypes';
import { formatCents, parseCurrencyToCents } from '../../src/lib/money';

export interface FieldProps {
  field: FieldDef;
  value: unknown;
  error: string | null;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  /**
   * The application uploads belong to. Absent in the staff preview, where
   * there is no application to attach anything to and the control says so.
   */
  applicationId?: string;
}

/**
 * Sub-fields of an address block.
 *
 * The class names are namespaced. They were not, and `.state` collided with the
 * full-page `.state` message container in form.css: on a narrow screen the
 * State column picked up a card border, a 2rem padding and a 4rem margin, which
 * looked like a rendering bug in the middle of the address. Global CSS, one
 * stylesheet, generic class name -- exactly the collision that is invisible
 * until someone opens the form on a phone.
 */
const ADDRESS_PARTS: { key: string; label: string; className: string; autoComplete: string }[] = [
  { key: 'address_1', label: 'Street address', className: 'addr-line', autoComplete: 'address-line1' },
  { key: 'address_2', label: 'Suite, floor (optional)', className: 'addr-line', autoComplete: 'address-line2' },
  { key: 'city', label: 'City', className: 'addr-city', autoComplete: 'address-level2' },
  { key: 'state', label: 'State', className: 'addr-state', autoComplete: 'address-level1' },
  { key: 'postal_code', label: 'ZIP code', className: 'addr-zip', autoComplete: 'postal-code' },
];

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function words(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/** Wide field types need the full column rather than the prose measure. */
function isWide(field: FieldDef): boolean {
  return (
    field.field_type === 'address_block' ||
    field.field_type === 'multi_select' ||
    field.field_type === 'file_upload'
  );
}

export function Field({
  field,
  value,
  error,
  onChange,
  onBlur,
  applicationId,
}: FieldProps): ReactElement {
  const uid = useId();
  const inputId = `f${uid}`;
  const helpId = field.help_text ? `h${uid}` : null;
  const errorId = error ? `e${uid}` : null;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  const invalid = error !== null;

  const common = {
    id: inputId,
    name: field.field_key,
    'aria-describedby': describedBy,
    'aria-invalid': invalid || undefined,
    'aria-required': field.is_required || undefined,
    onBlur,
  };

  // Choice groups and address blocks are fieldsets: the group needs the label,
  // not each individual control.
  const grouped =
    field.field_type === 'multi_select' ||
    field.field_type === 'address_block';

  const labelNode = grouped ? (
    <legend className="legend">
      {field.label}
      {!field.is_required && <span className="optional">optional</span>}
    </legend>
  ) : (
    <label htmlFor={inputId}>
      {field.label}
      {!field.is_required && <span className="optional">optional</span>}
    </label>
  );

  // Help text is authored per program and can run long: Inspire Change lists
  // what each area of focus covers, which is six paragraphs. Rendering all of
  // it inline pushes the control most of a screen below its own label, so
  // anything past the first paragraph collapses into a disclosure. The split is
  // on a blank line, which makes it the form author's decision rather than a
  // character count guessing where the summary ends.
  //
  // Only the first paragraph is wired to aria-describedby. Content inside a
  // closed <details> is hidden from assistive technology, so describing the
  // control with it would promise a description that is not there.
  const [helpLead, ...helpRest] = (field.help_text ?? '').split(/\n\s*\n/);
  const helpDetail = helpRest.join('\n\n').trim();
  const help = field.help_text ? (
    <>
      <p className="help" id={helpId ?? undefined}>
        {helpLead}
      </p>
      {helpDetail ? (
        <details className="help-more">
          <summary>More detail</summary>
          <p className="help">{helpDetail}</p>
        </details>
      ) : null}
    </>
  ) : null;

  const errorNode = error ? (
    <p className="error" id={errorId ?? undefined}>
      <span>{error}</span>
    </p>
  ) : null;

  const body = renderControl(field, value, onChange, common, error, applicationId);

  // An attestation reads as a sentence; the checkbox carries its own label and
  // a second one above it would be read out twice.
  if (field.field_type === 'checkbox_attestation' || field.field_type === 'consent_checkbox') {
    return (
      <div className="field" id={`field-${field.field_key}`} data-wide="true">
        {help}
        {body}
        {errorNode}
      </div>
    );
  }

  if (grouped) {
    return (
      <div className="field" id={`field-${field.field_key}`} data-wide={isWide(field) ? 'true' : undefined}>
        <fieldset
          className={field.field_type === 'address_block' ? 'address' : 'choices columns'}
          // Carries the description for the whole group, so it is announced
          // once on entering the group rather than once per control.
          aria-describedby={describedBy}
        >
          {labelNode}
          {help}
          {body}
        </fieldset>
        {errorNode}
      </div>
    );
  }

  return (
    <div className="field" id={`field-${field.field_key}`} data-wide={isWide(field) ? 'true' : undefined}>
      {labelNode}
      {help}
      {body}
      {errorNode}
    </div>
  );
}

type ControlProps = Record<string, unknown>;

function renderControl(
  field: FieldDef,
  value: unknown,
  onChange: (v: unknown) => void,
  common: ControlProps,
  error: string | null,
  applicationId: string | undefined,
): ReactElement {
  const v = field.validation ?? {};

  switch (field.field_type) {
    case 'long_text': {
      const text = str(value);
      const overWords = v.max_words !== undefined && words(text) > v.max_words;
      const overChars = v.max_length !== undefined && text.length > v.max_length;
      return (
        <>
          <textarea
            {...common}
            value={text}
            rows={8}
            onChange={(e) => onChange(e.target.value)}
          />
          {/* A live counter, because "500 words or fewer" is unanswerable
              otherwise. It counts up, never blocks typing: truncating someone
              mid-sentence loses their words. */}
          {(v.max_words !== undefined || v.max_length !== undefined) && (
            <span className="counter" data-over={overWords || overChars ? 'true' : undefined} aria-live="off">
              {v.max_words !== undefined
                ? `${words(text).toLocaleString('en-US')} of ${v.max_words.toLocaleString('en-US')} words`
                : `${text.length.toLocaleString('en-US')} of ${(v.max_length ?? 0).toLocaleString('en-US')} characters`}
            </span>
          )}
        </>
      );
    }

    case 'short_text':
    case 'other_specify':
      return (
        <input
          {...common}
          type="text"
          value={str(value)}
          // NO maxLength. The browser silently stops accepting characters,
          // with no message, before the validator ever gets to explain -- so a
          // long organization name just stops typing. Length is enforced by
          // validation, which says what is wrong.
          maxLength={undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'email':
      return (
        <input
          {...common}
          type="email"
          autoComplete="email"
          spellCheck={false}
          value={str(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'phone':
      return (
        <input
          {...common}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="713-555-0123"
          value={str(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'url':
      return (
        <input
          {...common}
          type="url"
          inputMode="url"
          spellCheck={false}
          placeholder="example.org"
          value={str(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'select':
      return (
        <select {...common} value={str(value)} onChange={(e) => onChange(e.target.value)}>
          {/* An explicit empty option so the field starts genuinely unanswered
              rather than silently defaulting to whatever is first. */}
          <option value="">Select…</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );

    case 'multi_select': {
      const selected = new Set(Array.isArray(value) ? (value as unknown[]).map(String) : []);
      return (
        <>
          {field.options.map((o) => (
            <label className="choice" key={o.value}>
              <input
                type="checkbox"
                name={field.field_key}
                value={o.value}
                checked={selected.has(o.value)}
                // NOT aria-describedby here. Eighteen county checkboxes each
                // carrying the same description made a screen reader repeat
                // "Programs serving counties outside this list are not
                // eligible" eighteen times. The description belongs to the
                // group, and the group is the <fieldset> this renders inside.
                onBlur={common.onBlur as () => void}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(o.value);
                  else next.delete(o.value);
                  onChange([...next]);
                }}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </>
      );
    }

    case 'checkbox_attestation':
    case 'consent_checkbox': {
      const checked = value === true || value === 1 || value === '1' || value === 'true';
      return (
        <label className={`choice attest${error ? ' invalid' : ''}`}>
          <input
            {...common}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>
            {field.label}
            {!field.is_required && <span className="optional">optional</span>}
          </span>
        </label>
      );
    }

    case 'currency': {
      const text = str(value);
      // Show the applicant what the system read. Money is integer cents
      // everywhere behind this input; this is the only place it becomes a
      // string, and it is parsed by the same function the Worker uses.
      let preview: string | null = null;
      if (text.trim() !== '') {
        try {
          preview = formatCents(parseCurrencyToCents(text), { withCents: true });
        } catch {
          preview = null;
        }
      }
      return (
        <>
          <div className="affix" data-invalid={error ? 'true' : undefined}>
            <span className="sigil" aria-hidden="true">
              $
            </span>
            <input
              {...common}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="25,000"
              value={text}
              onChange={(e) => onChange(e.target.value)}
            />
          </div>
          {preview && !error && (
            <span className="counter" aria-live="polite">
              Reads as {preview}
            </span>
          )}
        </>
      );
    }

    case 'integer':
      return (
        <input
          {...common}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={str(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'address_block': {
      const addr = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      return (
        <>
          {ADDRESS_PARTS.map((part) => (
            <div className={part.className} key={part.key}>
              <label htmlFor={`${common.id as string}-${part.key}`}>{part.label}</label>
              <input
                id={`${common.id as string}-${part.key}`}
                name={`${field.field_key}.${part.key}`}
                type="text"
                autoComplete={part.autoComplete}
                aria-invalid={(common['aria-invalid'] as boolean | undefined) || undefined}
                maxLength={part.key === 'state' ? 2 : undefined}
                value={str(addr[part.key])}
                onBlur={common.onBlur as () => void}
                onChange={(e) => onChange({ ...addr, [part.key]: e.target.value })}
              />
            </div>
          ))}
        </>
      );
    }

    case 'file_upload':
      if (applicationId) {
        return (
          <UploadField
            field={field}
            applicationId={applicationId}
            value={asRefs(value)}
            onChange={onChange}
            onBlur={common.onBlur as () => void}
            inputProps={common}
          />
        );
      }
      /*
       * Preview. A REAL, disabled input -- not a <div>.
       *
       * This was a <div>, and the <label htmlFor> above it pointed at it. A
       * <div> is not a labelable element, so the accessibility tree contained
       * no control at all for this field: a screen reader user was told three
       * questions needed their attention and given nothing to answer. A real
       * input binds the label, appears in the tree, and announces as disabled.
       */
      return (
        <div className="upload">
          <input
            {...common}
            type="file"
            disabled
            multiple={(v.max_files ?? 1) > 1}
            accept={(v.allowed_mime ?? []).join(',') || undefined}
          />
          <p className="help">
            Uploads are not available in this preview — there is no application to attach
            them to. An applicant uploads here, straight to secure storage.
          </p>
        </div>
      );

    default:
      return <p className="help">Unsupported field type.</p>;
  }
}
