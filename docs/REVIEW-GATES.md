# Review gates

Standing process. A phase is not done when the tests pass; it is done when it
has been through the gates below and the findings are either fixed or written
down.

This exists because the person who wrote the code is the worst possible
reviewer of it, and I am always that person. Every gate here is an adversarial
pass by a reviewer that did not write the thing it is reading, with a brief
that tells it what to attack.

---

## When gates run

- At the end of every phase or checkpoint, before it is called complete.
- Before anything touches real applicant data.
- Before the public form goes live — all gates, not a subset.

Gates run **serially, not in parallel.** Two reviewers editing the same working
tree corrupt each other's reads; that happened once and cost a full re-run.
A reviewer that needs to run code gets its own git worktree.

---

## The gates

### G1 — Authorization and scoping

**Brief.** Find a way for one organization to see or change another's data.
Every query touching external-user data must be scoped by `organization_id`
from the session, never from a request parameter. A wrong id must return 404,
never 403. Check that reviewer scores, internal notes and decision rationale
are absent from applicant and grantee payloads — not hidden in the UI, absent
from the JSON. Check session handling: expiry, revocation, single-use tokens,
the staff/external boundary.

**Passes when.** Every finding is fixed, or is written down with the reason it
is accepted.

### G2 — Money and audit integrity

**Brief.** Find a place where money is not integer cents, or becomes a float or
a string on the way anywhere. Find a mutating write to an application status,
score, decision, award or payment that produces no audit row. Find a hard
delete. Find an audit row that can be edited or removed.

### G3 — Adversarial correctness

**Brief.** Read the diff assuming it is wrong. Concurrency, partial failure,
D1 having no interactive transactions, batch ordering, triggers that do not
fire on the path taken, timezone and DST, empty and malformed input, values
that are legal JSON but the wrong shape. State a concrete failing input for
every finding, not a category of concern.

### G4 — The nonprofit's perspective

**Brief.** You are an executive director filling this in at nine in the evening
after the day job, on a phone, with a deadline tomorrow. Where does this waste
your time, lose your work, or fail to tell you what went wrong? Where does it
ask for something you do not have to hand? Where would you give up?

Not a design review. A "would a real applicant get through this" review.

### G5 — Test honesty

**Brief.** Find tests that pass for the wrong reason: a test that would still
pass with the behaviour deleted, a fixture that throws before the assertion
matters, a count derived from the thing under test, an assertion on an internal
message where the user-facing one is what matters. Then find behaviour with no
test at all.

Mutation testing is the standard here: propose the mutation, run it, and report
whether a test caught it. A claim that something is covered, without a mutant
that fails, is not evidence.

### G6 — Claims audit

**Brief.** Read my commit messages, comments and reports for this phase against
what the code actually does. Every claim that is stronger than the evidence is
a finding. "Enforced" that is a truthiness check. "Tested" that is untested.
"All of them" that is some of them. "Cannot happen" that can.

This gate exists because I have made all four of those errors in this project
and corrected them only after being asked.

---

## Rules for running a gate

1. **The brief is adversarial.** "Review this" produces a summary; "find a way
   to break this" produces findings.
2. **Findings need a reproduction.** A concrete input and the wrong output.
   Anything else is a question, and goes on the open list rather than the
   findings list.
3. **The reviewer does not fix.** It reports; the fix and its test are a
   separate, deliberate step, so a bad fix does not arrive inside a review.
4. **Every finding gets one of three outcomes, in writing.** Fixed with a test.
   Accepted with a reason. Deferred with the condition that would raise it.
   Silence is not an outcome.
5. **Reviewers are wrong sometimes.** Verify a finding before acting on it. A
   confidently wrong reviewer that gets believed is worse than no reviewer.

---

## Standing limits, restated

No gate here is a security review by a qualified human, and none of them makes
one unnecessary. This system will hold EINs, audited financial statements and
operating budgets belonging to other organizations. See
`docs/BLOCKED-ON-YOU.md`.
