/**
 * One reviewer, one application, one rubric.
 *
 * THE ONE THING THIS SCREEN MUST NEVER DO is show a reviewer another
 * reviewer's scores. That is not enforced here -- it is enforced by the API,
 * which never selects them -- but this screen is where somebody would later be
 * tempted to add a "what did everyone else say" panel. The comparison lives on
 * the admin's decision screen and nowhere else.
 *
 * AUTOSAVE ON BLUR, like the application form, and for the same reason: a
 * reviewer reads a forty-field application over an hour, and an hour lost to a
 * closed laptop is an hour nobody spends twice.
 *
 * THE TOTAL IS SHOWN AS IT BUILDS, because a rubric whose weights do not do
 * what the reviewer expects should be visible while they are still scoring
 * rather than after the ranking.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { ScoringSheet as Sheet } from './api';

const WEIGHT_ONE_BP = 10000;

interface Props {
  assignmentId: string;
  onBack: () => void;
}

function formatScore(bp: number): string {
  return (bp / WEIGHT_ONE_BP).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function ScoringSheet({ assignmentId, onBack }: Props): ReactElement {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Local edits, so a slow save never fights the person typing. */
  const [draft, setDraft] = useState<Record<string, { score: string; comment: string }>>({});
  /*
   * SAVE STATE PER CRITERION, not only at the bottom of the page.
   *
   * Autosave's whole promise is "nothing is lost", and a reviewer can only
   * believe that if they can see it happen. The single "Saved at 14:02" line
   * lives under the total, which on a twelve-criterion rubric is several
   * screens below the field somebody just left -- so the confirmation for a
   * save was, in practice, invisible at the moment it mattered. The same is
   * true of a refusal: a score of 11 on a criterion out of 10 was reported in
   * a banner at the top of the page, nowhere near the box holding the 11.
   */
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const s = await api.scoringSheet(assignmentId, signal);
        setSheet(s);
        setDraft(
          Object.fromEntries(
            s.criteria.map((c) => [
              c.id,
              { score: c.score === null ? '' : String(c.score), comment: c.comment ?? '' },
            ]),
          ),
        );
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [assignmentId],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function saveOne(criterionId: string): Promise<void> {
    if (!sheet?.editable) return;
    const d = draft[criterionId];
    if (!d) return;
    const trimmed = d.score.trim();
    setFieldErrors([]);
    try {
      const result = await api.saveScores(assignmentId, [
        {
          criterionId,
          // EMPTY CLEARS. An empty box is "not scored yet", which is not the
          // same as a nought, and sending 0 for it would be entering a
          // judgement on the reviewer's behalf.
          score: trimmed === '' ? null : Number(trimmed),
          comment: d.comment.trim() || null,
        },
      ]);
      const at = new Date().toLocaleTimeString('en-US');
      setSaved(at);
      setSavedAt((prev) => ({ ...prev, [criterionId]: at }));
      setSaveErrors((prev) => {
        if (!(criterionId in prev)) return prev;
        const next = { ...prev };
        delete next[criterionId];
        return next;
      });
      setSheet((prev) =>
        prev
          ? {
              ...prev,
              totalSoFarBp: result.totalSoFarBp,
              criteria: prev.criteria.map((c) =>
                c.id === criterionId
                  ? { ...c, score: trimmed === '' ? null : Number(trimmed), comment: d.comment.trim() || null }
                  : c,
              ),
            }
          : prev,
      );
    } catch (e) {
      const message = e instanceof ApiError ? e.message : String(e);
      // Against the field, not in a banner at the top of the page. The reason
      // a save was refused is nearly always about the number in one box.
      setSaveErrors((prev) => ({ ...prev, [criterionId]: message }));
      setSavedAt((prev) => {
        if (!(criterionId in prev)) return prev;
        const next = { ...prev };
        delete next[criterionId];
        return next;
      });
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    try {
      await api.completeReview(assignmentId);
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldErrors(e.fields ?? []);
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function reopen(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.reopenReview(assignmentId);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const heading = (
    <div className="panel-head">
      <h2 tabIndex={-1} data-route-heading>
        Scoring
      </h2>
      <button type="button" className="btn secondary small" onClick={onBack}>
        Back to my queue
      </button>
    </div>
  );

  if (error && !sheet) {
    return (
      <section className="panel">
        {heading}
        <p className="banner danger" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!sheet) {
    return (
      <section className="panel">
        {heading}
        <p className="meta" aria-live="polite">
          Loading…
        </p>
      </section>
    );
  }

  const unscored = sheet.criteria.filter((c) => c.score === null).length;
  /** Declared and not yet resolved. A resolved disclosure does not block. */
  const blocked = sheet.conflictDeclaredAt !== null && sheet.conflictClearedAt === null;

  return (
    <>
      <section className="panel">
        {heading}
        <h3>{sheet.projectTitle ?? 'Untitled application'}</h3>
        <p className="meta">
          {sheet.organizationName} &middot; {sheet.rubric.name}, version {sheet.rubric.version}
          {' '}&middot; scored out of {formatScore(sheet.rubric.maxTotalScoreBp)}
        </p>

        {blocked && (
          <p className="banner danger" role="alert">
            You declared a conflict on this application, so it cannot be scored. An administrator
            will look at it and either record that it is not a conflict, recuse you, or reassign
            it. Nothing you enter here would count in the meantime.
          </p>
        )}
        {sheet.conflictDeclaredAt && sheet.conflictClearedAt && (
          // Kept on screen after it is resolved. The reviewer disclosed
          // something and is now being asked to score it anyway; being told
          // that was a decision somebody made, rather than finding the block
          // has quietly lifted, is the difference between a process and a
          // glitch.
          <p className="banner" role="status">
            You disclosed a possible conflict here and an administrator recorded that it is not
            one. You can score it.
          </p>
        )}
        {sheet.completedAt && !blocked && (
          <p className="banner" role="status">
            You submitted this review. It can still be reopened until the application is decided.
          </p>
        )}
        {!sheet.editable && !blocked && !sheet.completedAt && (
          <p className="banner" role="status">
            This application has been decided, so its scores are settled.
          </p>
        )}
        {error && (
          <p className="banner danger" role="alert">
            {error}
          </p>
        )}
        {fieldErrors.length > 0 && (
          <ul className="banner danger" role="alert">
            {fieldErrors.map((f) => (
              <li key={f.field}>{f.message}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        {sheet.criteria.map((c) => (
          <article key={c.id} className="review-section">
            <h3>{c.label}</h3>
            {c.description && <p className="meta">{c.description}</p>}
            <div className="score-row">
              <label className="stack">
                <span>Score, out of {c.max_score}</span>
                <input
                  id={`score-${c.id}`}
                  type="number"
                  min={0}
                  max={c.max_score}
                  step={1}
                  inputMode="numeric"
                  disabled={!sheet.editable}
                  value={draft[c.id]?.score ?? ''}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      [c.id]: { score: e.target.value, comment: prev[c.id]?.comment ?? '' },
                    }))
                  }
                  onBlur={() => void saveOne(c.id)}
                />
              </label>
              <span className="meta">
                {/* What this criterion contributes at its weight, so a
                    reviewer sees what a point here is worth. */}
                weight {formatScore(c.weight_bp)} &middot; counts for up to{' '}
                {formatScore(c.max_score * c.weight_bp)}
              </span>
            </div>
            {saveErrors[c.id] ? (
              <p className="error" role="alert">
                {saveErrors[c.id]}
              </p>
            ) : (
              savedAt[c.id] && (
                <p className="meta" aria-live="polite">
                  Saved at {savedAt[c.id]}.
                </p>
              )
            )}
            <label className="stack">
              <span>Comment</span>
              <textarea
                id={`comment-${c.id}`}
                rows={3}
                disabled={!sheet.editable}
                value={draft[c.id]?.comment ?? ''}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    [c.id]: { score: prev[c.id]?.score ?? '', comment: e.target.value },
                  }))
                }
                onBlur={() => void saveOne(c.id)}
              />
            </label>
          </article>
        ))}
      </section>

      <section className="panel">
        <p>
          <strong>
            {formatScore(sheet.totalSoFarBp)} of {formatScore(sheet.rubric.maxTotalScoreBp)}
          </strong>{' '}
          {unscored > 0 && (
            <span className="meta">
              &mdash; {unscored} criteri{unscored === 1 ? 'on' : 'a'} still to score
            </span>
          )}
        </p>
        {saved && (
          <p className="meta" aria-live="polite">
            Saved at {saved}.
          </p>
        )}
        <div className="actions">
          {sheet.completedAt ? (
            <button type="button" className="btn secondary" onClick={() => void reopen()} disabled={busy || !sheet.editable}>
              Reopen this review
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => void submit()} disabled={busy || !sheet.editable}>
              Submit review
            </button>
          )}
        </div>
      </section>
    </>
  );
}
