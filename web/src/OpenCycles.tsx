/**
 * The front door: what is open, and what applying involves.
 *
 * Until this page existed a nonprofit could not find their way in at all --
 * the eligibility screen was an API with no page, so the only route to it was
 * an email from a program officer.
 *
 * WHAT IT SAYS ABOUT EFFORT IS FACTUAL. Not "about 45 minutes", which is a
 * number nobody measured and everybody quotes back, but what the form actually
 * asks: how many questions, how many of them are written answers, how many
 * documents to gather. Somebody deciding whether to spend an evening on this
 * can judge that for themselves.
 */

import type { ReactElement } from 'react';
import type { OpenCycle } from './publicApi';
import { daysUntil } from './reportWording';

interface Props {
  cycles: OpenCycle[];
  onStart: (cycle: OpenCycle) => void;
  /** Optional: omitted where a past-grantee route does not apply. */
  onPastGrantee?: () => void;
  /** Where somebody who already started an application goes to get back in. */
  onSignIn?: () => void;
  now?: Date;
}

/** The deadline, said the way somebody reads it rather than as a timestamp. */
export function deadlineLine(cycle: OpenCycle, now: Date = new Date()): string {
  const days = daysUntil(cycle.closesAt, now);
  if (days < 0) return `Closed ${cycle.closesAtDisplay}.`;
  if (days === 0) return `Closes today, ${cycle.closesAtDisplay}.`;
  if (days === 1) return `Closes tomorrow, ${cycle.closesAtDisplay}.`;
  if (days <= 21) return `Closes in ${days} days — ${cycle.closesAtDisplay}.`;
  return `Closes ${cycle.closesAtDisplay}.`;
}

/**
 * What the FIRST STEP asks, in a sentence.
 *
 * The counts describe the eligibility screen, which is the only form this page
 * can see -- and saying a bare "10 questions" read as the whole application,
 * which is thirty-odd fields and several documents. Somebody who budgeted ten
 * questions and met a narrative would rightly feel misled, so the sentence
 * names the step it is counting and says the application follows.
 */
export function effortLine(cycle: OpenCycle): string | null {
  const s = cycle.shape;
  if (!s || s.questions === 0) return null;

  const parts = [`${s.questions} question${s.questions === 1 ? '' : 's'}`];
  if (s.writtenAnswers > 0) {
    parts.push(`${s.writtenAnswers} written`);
  }
  if (s.documents > 0) {
    parts.push(`${s.documents} document${s.documents === 1 ? '' : 's'} to attach`);
  }

  const step = cycle.firstStageName
    ? `${cycle.firstStageName.toLowerCase()} check`
    : 'first step';
  return (
    `Starts with a short ${step} \u2014 ${parts.join(', ')}. ` +
    'The full application comes after that, and you can save it and come back.'
  );
}

export function OpenCycles({
  cycles,
  onStart,
  onPastGrantee,
  onSignIn,
  now = new Date(),
}: Props): ReactElement {
  return (
    <>
      <div className="section-head">
        <h2 tabIndex={-1} data-route-heading>
          Apply for a grant
        </h2>
        <p>
          Grant programs currently accepting applications from nonprofits serving Greater
          Houston.
        </p>
      </div>

      {cycles.length === 0 ? (
        <div className="card portal-empty">
          <h3>Nothing is open right now</h3>
          <p>
            There are no grant programs accepting applications at the moment. Programs open on
            an annual cycle, and this page is the place to check.
          </p>
        </div>
      ) : (
        cycles.map((c) => (
          <section className="card portal-award" key={c.id} aria-labelledby={`cycle-${c.id}`}>
            <div className="portal-award-head">
              <h3 id={`cycle-${c.id}`}>{c.programName}</h3>
              <span className="portal-chip" data-tone={deadlineTone(c, now)}>
                {c.name}
              </span>
            </div>

            {c.programDescription && <p>{c.programDescription}</p>}

            <p className="portal-due" data-tone={deadlineTone(c, now)}>
              {deadlineLine(c, now)}
            </p>

            {effortLine(c) && <p className="portal-meta">{effortLine(c)}</p>}

            {/*
              Said BEFORE they start, not in an email afterwards. A program
              that will refuse them over an unfiled report has to say so on the
              page where they decide whether to spend the evening.
            */}
            {c.requiresReportsFiled && (
              <p className="portal-feedback">
                <strong>Before you start:</strong> this program asks that reports on previous
                grants are filed first. If your organization holds a grant from us with a
                report still outstanding, please file it before applying.
              </p>
            )}

            <div className="actions">
              <button type="button" className="btn" onClick={() => onStart(c)}>
                Start an application
              </button>
              {/* What the step costs is already in the line above; repeating
                  the stage name beside the button read as "Begins with a short
                  eligibility." */}
              <span className="portal-meta">Nothing is submitted yet.</span>
            </div>
          </section>
        ))
      )}

      {/*
        THE OTHER DOOR, and it belongs here rather than tucked in a footer.
        A past grantee arriving at this page has nothing to apply for and no
        account to sign in to; before this, the page told them what was open
        and left them with nowhere to go. It shows even when nothing is open,
        because "nothing is open right now" is exactly when somebody who was
        funded two years ago is most likely to be reading.
      */}
      {onPastGrantee && (
        <section className="card portal-award" aria-labelledby="past-grantee">
          <div className="portal-award-head">
            <h3 id="past-grantee">Already funded by the Foundation?</h3>
          </div>
          <p>
            If we have supported your organization before, tell us what the grant made
            possible — including photos or a short video. We will check our records and send
            you a way to sign in.
          </p>
          <div className="portal-apply">
            <button type="button" className="btn secondary" onClick={onPastGrantee}>
              Tell us about a grant we gave you
            </button>
          </div>
        </section>
      )}

      {/*
        THE WAY BACK IN, for somebody who is not arriving for the first time.

        This page is the front door -- the root of the applicant hostname
        redirects here -- and until now it was a door that only opened outward.
        An applicant who saved a draft on Tuesday and came back on Thursday
        found the list of open programmes and no way to say "I have already
        started one of these". Their draft was safe the whole time and there
        was nothing on screen that said so.

        Quiet, and last, because it is the minority case. The majority are
        reading this page to find out whether they can apply at all.
      */}
      {onSignIn && (
        <p className="meta signin-return">
          Already started an application, or been sent a link?{' '}
          <button type="button" className="linklike" onClick={onSignIn}>
            Sign in
          </button>
          . We email you a link rather than asking for a password.
        </p>
      )}

      <PrivacyNotice />
    </>
  );
}

function deadlineTone(cycle: OpenCycle, now: Date): 'todo' | 'late' | 'resting' {
  const days = daysUntil(cycle.closesAt, now);
  if (days < 0) return 'late';
  return days <= 7 ? 'late' : 'todo';
}

/**
 * Standard practice when collecting EINs, financial statements and demographic
 * descriptions from third parties, and CLAUDE.md asks for it by name. It is on
 * the entry page as well as the form so that somebody reads it before typing
 * rather than after.
 */
export function PrivacyNotice(): ReactElement {
  return (
    <footer className="privacy">
      <h2>What we collect, and for how long</h2>
      <p>
        An application asks for information about your organization — including its EIN, budget
        and financial statements — along with the contact details of the person submitting it.
        It is used to assess your request and to administer any resulting grant. It is not sold
        and is not shared outside the review process.
      </p>
      <p>
        Uploaded documents are stored privately and are reachable only through short-lived
        links issued to signed-in staff. You sign in with a link emailed to you rather than a
        password, so there is no password for us to hold.
      </p>
    </footer>
  );
}
