/**
 * The organization's applications, and the way to start another.
 *
 * WHY THIS EXISTS. Two dead ends met on one page.
 *
 * AN APPLICATION HAD NOWHERE TO LIVE. `listApplicationsForExternal` was
 * written in Phase 1, correctly scoped and masked, and nothing ever called it.
 * So somebody who submitted and closed the tab had no page that said so: the
 * read-back lived at a URL they would have had to keep, and signing in again
 * landed them on "there are no grants on this account yet". Did it go through
 * is the commonest question an applicant has, and the product had no answer.
 *
 * AND THERE WAS NO WAY BACK OUT. The portal shell carries no navigation -- by
 * design, when the portal was only a grantee's reporting page and there was
 * genuinely nowhere else to go. There are three external destinations now, and
 * a signed-in nonprofit could not reach the one that matters: a program
 * officer reporting on last year's grant, or a declined applicant reapplying,
 * had to be sent a link or type a path.
 *
 * THE STATUS SHOWN IS THE SERVER'S. It is masked before it leaves the Worker,
 * because an application becomes 'declined' the instant an admin records the
 * decision -- days before a human finishes the letter. Nothing here re-derives
 * an outcome from a date or a title, and the wording below never implies one
 * the server has not sent.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type { ApplicationSummary } from './granteeApi';
import type { OpenCycle } from './publicApi';
import { formatDay } from './reportWording';

interface Props {
  applications: ApplicationSummary[];
  /** Open cycles, so "apply again" is a button rather than a path to type. */
  openCycles: OpenCycle[];
  onStartApplication: () => void;
  onOpenApplication: (id: string) => void;
  /**
   * Continue to the next stage of an open cycle. Resolves to the new
   * application's id; the server decides WHICH stage that is.
   */
  onContinue: (cycleId: string) => Promise<string>;
}

/**
 * What each state is called, to the person who is in it.
 *
 * `under_review` covers a decision that has been made and not yet delivered,
 * and the wording has to be true in both cases: "with us" is, "not decided
 * yet" would not be.
 */
const STATE: Record<string, { chip: string; tone: 'todo' | 'late' | 'resting'; line: string }> = {
  draft: {
    chip: 'Not sent',
    tone: 'todo',
    line: 'Started but not submitted. You can carry on where you left off.',
  },
  submitted: {
    chip: 'Received',
    tone: 'resting',
    line: 'We have it. You do not need to do anything else for now.',
  },
  under_review: {
    chip: 'With us',
    tone: 'resting',
    line: 'Being considered. We will write to you either way.',
  },
  awarded: { chip: 'Awarded', tone: 'resting', line: 'Funded. Your grant is above.' },
  declined: {
    chip: 'Not funded',
    tone: 'resting',
    line: 'Not funded this time. You are welcome to apply again in a future cycle.',
  },
  withdrawn: { chip: 'Withdrawn', tone: 'resting', line: 'Withdrawn at your request.' },
};

/**
 * A step that is finished but is not the end of the road.
 *
 * WHAT THIS FIXES. A program with an eligibility screen files two applications
 * for one grant request. A submitted eligibility screen was rendering as
 * "Grant application — Received. We have it. You do not need to do anything
 * else for now." It is not the grant application, and they do need to do
 * something else: the thirty-four-question form has not been started.
 *
 * `isFinalStage` comes from the server, which knows whether a later stage
 * exists AND has a published form. A stage configured but not built is not a
 * step anybody can take.
 */
function isUnfinishedStep(a: ApplicationSummary): boolean {
  // cycleId is required, not incidental: continuing means starting the next
  // stage OF THAT CYCLE, and a row that cannot name its cycle cannot be
  // continued. Offering a button that would start something else is worse
  // than offering none.
  return (
    !a.isFinalStage &&
    // Already taken. Without this the portal kept offering to start a stage
    // that was started, and the endpoint behind the button answers 409 -- an
    // invitation to an error. Caught by driving the page twice.
    !a.nextStageStarted &&
    a.status !== 'draft' &&
    a.status !== 'withdrawn' &&
    a.cycleId !== null
  );
}

export function PortalApplications({
  applications,
  openCycles,
  onStartApplication,
  onOpenApplication,
  onContinue,
}: Props): ReactElement | null {
  const drafts = applications.filter((a) => a.status === 'draft');
  const sent = applications.filter((a) => a.status !== 'draft');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * The next step, if there is one. A cycle is offered as "continue" rather
   * than "apply again" when this organization has finished an earlier stage
   * of it and not yet started the next.
   *
   * The button calls the server either way; this only decides the wording.
   * Working out entitlement here would be a second copy of a rule that lives
   * in createApplication, and the two would disagree the first time a program
   * used three stages.
   */
  const unfinished = sent.find(isUnfinishedStep);

  async function go(cycleId: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      onOpenApplication(await onContinue(cycleId));
    } catch (e) {
      setProblem(
        e instanceof Error && e.message ? e.message : 'That could not be started. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  // Nothing to say and nowhere to go: render nothing rather than an empty
  // heading. The portal's own empty state already speaks.
  if (applications.length === 0 && openCycles.length === 0) return null;

  return (
    <section className="card portal-award" aria-labelledby="applications-heading">
      <div className="portal-award-head">
        <h3 id="applications-heading">
          {applications.length === 0 ? 'Apply for a grant' : 'Your applications'}
        </h3>
      </div>

      {applications.length > 0 && (
        <ul className="portal-list">
          {[...drafts, ...sent].map((a) => {
            const state = STATE[a.status] ?? {
              chip: a.status,
              tone: 'resting' as const,
              line: '',
            };
            return (
              <li key={a.id}>
                <div className="portal-report-row">
                  <div>
                    <p className="portal-report-title">
                      {a.projectTitle ??
                        (a.isFinalStage
                          ? (a.programName ?? 'Grant application')
                          : `${a.stageName ?? 'First step'}${a.programName ? ` — ${a.programName}` : ''}`)}
                      <span className="portal-chip" data-tone={state.tone}>
                        {state.chip}
                      </span>
                    </p>
                    <p className="portal-meta">
                      {[a.programName, a.cycleName].filter(Boolean).join(' · ')}
                      {a.submittedAt && ` · Sent ${formatDay(a.submittedAt)}`}
                    </p>
                    {!a.isFinalStage && !a.nextStageStarted && a.status === 'submitted' ? (
                      <p className="portal-due">
                        {a.stageName ?? 'That step'} is done. The full application is the next
                        step, and it has not been started yet.
                      </p>
                    ) : (
                      state.line && <p className="portal-due">{state.line}</p>
                    )}
                  </div>
                  {/*
                    A DRAFT IS THE ONLY ONE WITH A BUTTON. A submitted
                    application opens to a read-only copy, which is worth
                    having, but putting the same weight on it as on an
                    unfinished form would send somebody to the wrong one when
                    both are on screen.
                  */}
                  <button
                    type="button"
                    className={a.status === 'draft' ? 'btn' : 'btn secondary'}
                    onClick={() => onOpenApplication(a.id)}
                  >
                    {a.status === 'draft' ? 'Carry on' : 'View'}
                    <span className="sr-only">
                      {' '}
                      {a.projectTitle ?? a.programName ?? 'this application'}
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {problem && (
        <p className="banner danger" role="alert">
          {problem}
        </p>
      )}

      {openCycles.length > 0 && (
        <div className="portal-apply">
          {/*
            TWO DIFFERENT OFFERS, and conflating them is what left an applicant
            stranded. "Apply for another grant" sent them back to the open-cycles
            page and round the eligibility screen they had already passed; there
            was no route to the form they were waiting to fill in. When a step is
            outstanding the button starts it, through the endpoint that decides
            which step that is.
          */}
          <p className="portal-meta">
            {unfinished && openCycles.some((c) => c.id === unfinished.cycleId)
              ? 'You can carry on with the full application now.'
              : openCycles.length === 1
                ? `${openCycles[0]!.programName} is accepting applications.`
                : `${openCycles.length} programs are accepting applications.`}
          </p>
          {/*
            THE UNFINISHED APPLICATION'S OWN CYCLE, not the first open one.
            A browser drive caught this: with another cycle open, the button
            started that programme's eligibility screen instead of the
            application the person was waiting to fill in. It is also gated on
            that cycle still being open -- a step whose deadline passed is not
            something to offer.
          */}
          {unfinished && openCycles.some((c) => c.id === unfinished.cycleId) ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void go(unfinished.cycleId!)}
            >
              {busy ? 'Opening…' : 'Continue your application'}
            </button>
          ) : (
            <button type="button" className="btn secondary" onClick={onStartApplication}>
              {applications.length === 0 ? 'See open grant programs' : 'Apply for another grant'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
