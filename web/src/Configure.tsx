/**
 * Creating a program and its cycles.
 *
 * WHY THIS EXISTS. Every route these forms call already existed, admin-only,
 * and nothing in the app called any of them. A program, a stage or a cycle
 * could be created only by applying a seed file or by hand with curl — so a
 * real application round could not be started from the product at all, and the
 * nine-tenths of the platform that depends on an open cycle was unreachable.
 *
 * TIMES ARE CENTRAL, STATED RATHER THAN INFERRED. `<input type="datetime-local">`
 * hands back a naive string with no zone and the browser reads it in the
 * browser's own. A deadline set in Houston and the same deadline set by a
 * consultant in London would be five or six hours apart with nothing on screen
 * saying so, and the applications rejected as late would be real. Every value
 * here is converted through `wallTimeToUtcIso` in the Foundation's zone, and
 * the abbreviation is shown back before anybody saves.
 *
 * OPENING A CYCLE IS THE MOST CONSEQUENTIAL BUTTON IN THE STAFF APP. It makes a
 * public form live and starts a deadline, so it reads the dates back in words
 * and asks. Closing is confirmed too: it stops submissions for everyone
 * mid-flight.
 */

import { useCallback, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { ApiError, api } from './api';
import type { CycleRow } from './api';
import { DISPLAY_ZONE, wallTimeToUtcIso, zoneAbbreviation } from '../../src/lib/zonedTime';

type Busy = { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string };

const failure = (e: unknown): Busy => ({
  kind: 'error',
  message: e instanceof ApiError ? e.message : 'That did not work. Try again.',
});

// ---------------------------------------------------------------------------

export function NewProgram({ onChanged }: { onChanged: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [fiscalYear, setFiscalYear] = useState('');
  const [policy, setPolicy] = useState<'block' | 'warn' | 'ignore'>('warn');
  const [busy, setBusy] = useState<Busy>({ kind: 'idle' });

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (name.trim() === '') return;
      setBusy({ kind: 'working' });
      try {
        await api.createProgram({
          name: name.trim(),
          compliance_policy: policy,
          ...(fiscalYear.trim() === '' ? {} : { fiscal_year: Number(fiscalYear) }),
        });
        setName('');
        setFiscalYear('');
        setBusy({ kind: 'idle' });
        setOpen(false);
        onChanged();
      } catch (err) {
        setBusy(failure(err));
      }
    },
    [name, fiscalYear, policy, onChanged],
  );

  if (!open) {
    return (
      <div className="actions">
        <button type="button" className="btn secondary small" onClick={() => setOpen(true)}>
          New program
        </button>
      </div>
    );
  }

  return (
    <section className="panel" aria-labelledby="new-program-heading">
      <div className="panel-head">
        <h2 id="new-program-heading">New program</h2>
      </div>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="stack">
            <span>Program name</span>
            <input
              id="program-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <label className="stack">
            <span>Fiscal year</span>
            <input
              id="program-fiscal-year"
              type="number"
              inputMode="numeric"
              min={2000}
              max={2200}
              value={fiscalYear}
              onChange={(e) => setFiscalYear(e.target.value)}
            />
          </label>
          <label className="stack">
            <span>An overdue report from an applicant should</span>
            <select
              id="program-compliance"
              value={policy}
              onChange={(e) => setPolicy(e.target.value as typeof policy)}
            >
              <option value="warn">warn them, and let them apply</option>
              <option value="block">block the application</option>
              <option value="ignore">be ignored</option>
            </select>
          </label>
        </div>

        <p className="meta">
          The slug is made from the name, and is what a spreadsheet import refers to. Stages and
          forms are added after the program exists.
        </p>

        {busy.kind === 'error' && (
          <p className="banner danger" role="alert">
            {busy.message}
          </p>
        )}

        <div className="actions">
          <button type="submit" className="btn" disabled={busy.kind === 'working' || name.trim() === ''}>
            {busy.kind === 'working' ? 'Creating…' : 'Create program'}
          </button>
          <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function NewCycle({
  programId,
  programName,
  onChanged,
}: {
  programId: string;
  programName: string;
  onChanged: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [graceHours, setGraceHours] = useState('0');
  const [busy, setBusy] = useState<Busy>({ kind: 'idle' });

  const opensIso = opensAt ? wallTimeToUtcIso(opensAt) : null;
  const closesIso = closesAt ? wallTimeToUtcIso(closesAt) : null;
  // Caught here rather than by the server, because "closes before it opens" is
  // a typo with an obvious fix and a round trip to say so is wasted.
  const backwards = Boolean(opensIso && closesIso && closesIso <= opensIso);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!opensIso || !closesIso || backwards) return;
      setBusy({ kind: 'working' });
      try {
        await api.createCycle(programId, {
          name: name.trim(),
          opens_at: opensIso,
          closes_at: closesIso,
          draft_grace_hours: Number(graceHours) || 0,
        });
        setName('');
        setOpensAt('');
        setClosesAt('');
        setBusy({ kind: 'idle' });
        setOpen(false);
        onChanged();
      } catch (err) {
        setBusy(failure(err));
      }
    },
    [programId, name, opensIso, closesIso, backwards, graceHours, onChanged],
  );

  if (!open) {
    return (
      <div className="actions">
        <button type="button" className="btn secondary small" onClick={() => setOpen(true)}>
          New cycle<span className="sr-only"> for {programName}</span>
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel-decide">
      <h4>New cycle for {programName}</h4>

      <div className="form-grid">
        <label className="stack">
          <span>Cycle name</span>
          <input
            id={`cycle-name-${programId}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            placeholder="FY2027 Spring"
          />
        </label>
        <label className="stack">
          <span>Opens</span>
          <input
            id={`cycle-opens-${programId}`}
            type="datetime-local"
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
            required
          />
        </label>
        <label className="stack">
          <span>Closes</span>
          <input
            id={`cycle-closes-${programId}`}
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            required
          />
        </label>
        <label className="stack">
          <span>Draft grace, in hours</span>
          <input
            id={`cycle-grace-${programId}`}
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            value={graceHours}
            onChange={(e) => setGraceHours(e.target.value)}
          />
        </label>
      </div>

      {/*
        The times read back in the Foundation's zone, before saving. Central is
        stated rather than taken from this browser, so a consultant working from
        another timezone sets the same deadline a Houston admin would.
      */}
      <p className="meta" data-testid="cycle-zone-echo">
        Times are <strong>{DISPLAY_ZONE.split('/')[1]!.replace('_', ' ')}</strong>, whatever zone
        this computer is in.
        {opensIso && ` Opens ${opensAt.replace('T', ' ')} ${zoneAbbreviation(opensIso)}.`}
        {closesIso && ` Closes ${closesAt.replace('T', ' ')} ${zoneAbbreviation(closesIso)}.`}
      </p>

      <p className="meta">
        Draft grace lets an application started before the deadline be submitted after it. Zero is
        a hard cutoff.
      </p>

      {backwards && (
        <p className="error" role="alert">
          The cycle closes before it opens.
        </p>
      )}
      {busy.kind === 'error' && (
        <p className="banner danger" role="alert">
          {busy.message}
        </p>
      )}

      <div className="actions">
        <button
          type="submit"
          className="btn"
          disabled={busy.kind === 'working' || !opensIso || !closesIso || backwards || name.trim() === ''}
        >
          {busy.kind === 'working' ? 'Creating…' : 'Create cycle'}
        </button>
        <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="meta">A new cycle is a draft. Nothing is public until it is opened.</p>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function CycleStatusButton({
  cycle,
  onChanged,
}: {
  cycle: CycleRow;
  onChanged: () => void;
}): ReactElement | null {
  const [busy, setBusy] = useState<Busy>({ kind: 'idle' });

  // The server owns the state machine and refuses an illegal transition. This
  // only decides what to offer, so nobody is shown a button that answers 409.
  const next: 'open' | 'closed' | null =
    cycle.status === 'open' ? 'closed' : cycle.status === 'draft' || cycle.status === 'closed' ? 'open' : null;
  if (next === null) return null;

  const act = async () => {
    const message =
      next === 'open'
        ? `Open ${cycle.name}?\n\nThe application form becomes public immediately, and closes ` +
          `${cycle.closes_at_display}.`
        : `Close ${cycle.name}?\n\nNobody will be able to submit after this, including applicants ` +
          `part-way through a draft.`;
    if (!window.confirm(message)) return;
    setBusy({ kind: 'working' });
    try {
      await api.setCycleStatus(cycle.id, next);
      setBusy({ kind: 'idle' });
      onChanged();
    } catch (err) {
      setBusy(failure(err));
    }
  };

  return (
    <>
      <button type="button" className="btn small secondary" disabled={busy.kind === 'working'} onClick={act}>
        {next === 'open' ? 'Open' : 'Close'}
        <span className="sr-only"> {cycle.name}</span>
      </button>
      {busy.kind === 'error' && (
        <span className="meta strong" data-overdue="true" role="alert">
          {busy.message}
        </span>
      )}
    </>
  );
}
