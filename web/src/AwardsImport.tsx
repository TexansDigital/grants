/**
 * Loading a year of grants from a spreadsheet.
 *
 * TWO PRESSES, ALWAYS. The first reads the file and says exactly what would
 * happen; the second does it. There is no single button that imports, because
 * this creates organizations, sign-ins and financial records for real
 * nonprofits, and the plan is the only chance anybody gets to notice that a
 * column is shifted or that a grantee is about to be duplicated.
 *
 * The file never leaves the browser as a file. It is read to text here and
 * posted as JSON, so there is no upload path, no R2 object and nothing to
 * clean up if somebody picks the wrong file. The server re-parses and
 * re-plans from that text rather than trusting the plan it just returned.
 */

import { useCallback, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { ImportPreview, ImportRunResult } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  isAdmin: boolean;
}

/*
 * NO onImported CALLBACK, deliberately, and it used to have one.
 *
 * Telling the configuration screen to re-read set App's reload key, which
 * flips it to its loading state -- unmounting this panel and everything in it.
 * A successful import therefore BLANKED ITS OWN CONFIRMATION: the awards were
 * created and the admin was returned to an empty form with no result, no
 * counts and no way to tell whether anything had happened.
 *
 * There was nothing to re-read anyway. This creates awards, organizations and
 * sign-ins; the configuration screen shows programs, cycles and forms, none of
 * which an import touches. Found by driving it in a browser -- every unit test
 * passed, because the failure lives entirely in how the screen is mounted.
 */

type State =
  | { kind: 'idle' }
  | { kind: 'working'; what: 'checking' | 'importing' }
  | { kind: 'checked'; preview: ImportPreview }
  | { kind: 'done'; result: ImportRunResult }
  | { kind: 'error'; message: string };

export function AwardsImport({ isAdmin }: Props): ReactElement | null {
  // Not rendered at all for a reviewer. The routes are ADMIN_ONLY regardless;
  // this is so nobody is shown a control that answers FORBIDDEN.
  if (!isAdmin) return null;
  return <AwardsImportPanel />;
}

function AwardsImportPanel(): ReactElement {
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

  const readFile = useCallback(async (file: File) => {
    setFilename(file.name);
    setState({ kind: 'idle' });
    setCsv(await file.text());
  }, []);

  const fail = (e: unknown) =>
    setState({
      kind: 'error',
      message: e instanceof ApiError ? e.message : 'That did not work. Try again.',
    });

  const check = useCallback(async () => {
    setState({ kind: 'working', what: 'checking' });
    try {
      setState({ kind: 'checked', preview: await api.previewAwardImport(csv) });
    } catch (e) {
      fail(e);
    }
  }, [csv]);

  const runImport = useCallback(
    async (toCreate: number) => {
      const ok = window.confirm(
        `Import ${toCreate} grant${toCreate === 1 ? '' : 's'}? ` +
          'This creates the organizations and sign-ins listed above.',
      );
      if (!ok) return;
      setState({ kind: 'working', what: 'importing' });
      try {
        setState({ kind: 'done', result: await api.runAwardImport(csv) });
      } catch (e) {
        fail(e);
      }
    },
    [csv],
  );

  const preview = state.kind === 'checked' ? state.preview : null;
  const canImport = Boolean(preview?.parse.ok && preview?.plan?.ok && preview.plan.summary.toCreate > 0);

  return (
    <section className="panel" aria-labelledby="awards-import-heading">
      <div className="panel-head">
        <h2 id="awards-import-heading">Import grants from a spreadsheet</h2>
      </div>

      <p className="meta">
        The columns are in <code>docs/awards-import-template.csv</code>. Running the same file
        twice imports nothing the second time, so a partial file is safe to re-run once it is
        complete.
      </p>

      <div className="actions">
        <input
          ref={fileInput}
          id="awards-csv"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
          }}
        />
        <button
          type="button"
          className="btn secondary small"
          disabled={csv.trim() === '' || state.kind === 'working'}
          onClick={check}
        >
          {state.kind === 'working' && state.what === 'checking' ? 'Reading…' : 'Check this file'}
        </button>
        {filename && <span className="meta">{filename}</span>}
      </div>

      {state.kind === 'error' && (
        <p className="banner danger" role="alert">
          {state.message}
        </p>
      )}

      {state.kind === 'done' && (
        <div className="panel-decide" role="status">
          <p>
            Imported <strong>{state.result.awardsCreated}</strong> grant
            {state.result.awardsCreated === 1 ? '' : 's'}, creating{' '}
            {state.result.organizationsCreated} organization
            {state.result.organizationsCreated === 1 ? '' : 's'} and {state.result.usersCreated}{' '}
            sign-in{state.result.usersCreated === 1 ? '' : 's'}.
            {state.result.skipped > 0 && ` ${state.result.skipped} were already here.`}
          </p>
          <p className="meta">
            Next: Reporting → <strong>Create missing report obligations</strong>. Until that runs,
            these grants have no report due and no grantee will ever be asked.
          </p>
        </div>
      )}

      {preview && <Preview preview={preview} canImport={canImport} onImport={runImport} working={state.kind === 'working'} />}
    </section>
  );
}

function Preview({
  preview,
  canImport,
  onImport,
  working,
}: {
  preview: ImportPreview;
  canImport: boolean;
  onImport: (toCreate: number) => void;
  working: boolean;
}): ReactElement {
  const { parse, plan } = preview;

  return (
    <div className="panel-decide">
      {/*
        Problems first. A plan is only worth reading once you know whether the
        file will run at all, and nothing imports while any row is unreadable.
      */}
      {parse.issues.length > 0 && (
        <div role="alert">
          <h3>
            {parse.issues.length} problem{parse.issues.length === 1 ? '' : 's'} to fix first
          </h3>
          <p className="meta">
            Nothing is imported while any row is unreadable. Row numbers are the ones your
            spreadsheet shows.
          </p>
          <ul className="tally">
            {parse.issues.slice(0, 25).map((issue, i) => (
              <li key={`${issue.rowNumber}-${issue.column}-${i}`}>
                <span className="meta strong" data-overdue="true">
                  Row {issue.rowNumber}
                  {issue.column ? `, ${issue.column}` : ''}: {issue.message}
                </span>
              </li>
            ))}
          </ul>
          {parse.issues.length > 25 && (
            <p className="more">Showing 25 of {parse.issues.length}.</p>
          )}
        </div>
      )}

      {parse.unknownColumns.length > 0 && (
        <p className="banner">
          Ignored column{parse.unknownColumns.length === 1 ? '' : 's'}:{' '}
          <strong>{parse.unknownColumns.join(', ')}</strong>. Nothing in them is imported.
        </p>
      )}

      {plan === null ? (
        <p className="meta">No rows could be read from that file.</p>
      ) : (
        <>
          <p>
            <strong>{plan.summary.toCreate}</strong> grant
            {plan.summary.toCreate === 1 ? '' : 's'} would be created, totalling{' '}
            <strong>{formatCents(plan.summary.totalCents)}</strong>, alongside{' '}
            {plan.summary.organizationsToCreate} new organization
            {plan.summary.organizationsToCreate === 1 ? '' : 's'} and {plan.summary.usersToCreate}{' '}
            new sign-in{plan.summary.usersToCreate === 1 ? '' : 's'}.
            {plan.summary.toSkip > 0 &&
              ` ${plan.summary.toSkip} already imported and would be left alone.`}
          </p>

          <div className="table-scroll">
            <table>
              <caption className="sr-only">What each row in the file would do</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Organization</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col">What happens</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={r.reference}>
                    <th scope="row">{r.reference}</th>
                    <td>
                      {r.organization}
                      {r.createsOrganization && <span className="meta"> · new</span>}
                    </td>
                    <td className="num">{formatCents(r.amountCents)}</td>
                    <td>
                      {r.kind === 'create' ? (
                        <>
                          Import
                          {r.createsUser && <span className="meta"> · creates a sign-in</span>}
                        </>
                      ) : (
                        <span
                          className="meta strong"
                          data-overdue={r.kind === 'blocked' ? 'true' : undefined}
                        >
                          {r.reason}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {canImport && (
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={working}
            onClick={() => onImport(plan?.summary.toCreate ?? 0)}
          >
            Import {plan?.summary.toCreate} grant{plan?.summary.toCreate === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </div>
  );
}
