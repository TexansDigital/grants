# Steward roadmap

Revised after adversarial review. This is a proposed **revision** to the phase
plan in CLAUDE.md, not a restatement of it. Where it differs, the reason is
stated. Nothing here has been built.

## Where we actually are

**Last updated 21 September 2026.** This section is rewritten whenever it stops
being true; the rest of the file is the original plan and its reasoning, kept
because the reasoning still holds even where the status has moved on.

**Built and reachable: 1,427 tests, migrations 0001-0019.** Seven browser
harnesses drive real Chromium against the built bundle.

**An applicant can complete an application end to end.** Eligibility screen,
magic-link sign-in, draft creation, server-backed autosave, direct-to-R2
uploads, review, submit, confirmation email with a full read-back. Turnstile is
live on the public form, scoped to `apply.houstontexansfoundation.org`, and
fails closed.

**Staff can** sign in through Access, manage programs, stages and cycles, open
and close a cycle, browse and filter the pipeline, search narratives full-text,
read one application in full with its organization's history, **open its
uploaded files**, assign reviewers and see coverage, and remove junk
organizations with an undo.

**Reviewers can** see their own queue, score against the cycle's rubric with
autosave, declare a conflict, and submit or reopen a review. **Admins can**
build and publish a versioned rubric, read every reviewer's scores side by
side, record a decision, create the award record from it, send award and
decline letters with the acceptances-first rule enforced, export and re-import
an offline scorecard for a consultant, and read a dashboard whose CSV is the
export executives receive.

**An applicant is never told by the portal.** An awarded or declined
application reads as still under review to the applicant until somebody
communicates the decision — by letter from Steward, or by phone, recorded.

**Also built:** awards and the payment ledger, grantee reporting with
per-program metrics, the compliance desk, data health, organization merge,
the Formstack/awards importer, the nightly D1 export to R2, and a retention
policy that destroys applicants' financial documents 90 days after their
application is decided.

**Not built:** the public grantee page, the Eloqua opt-in sync, a payment
ledger (so "committed versus disbursed" cannot be computed and the dashboard
says so), a generated PDF (the CSV plus the browser's print-to-PDF is what
exists), and bulk sending of decision letters — each one goes individually,
which at 250 declines is a long afternoon.

**Never yet exercised for real,** and this is the honest gap between "works"
and "works in production":
- **No real applicant has touched any of it.** CLAUDE.md's Phase 2
  verification is three friendly organizations submitting on their own devices
  with no help. That has not happened and nothing substitutes for it.
- **No file has ever been destroyed by the retention job on a real schedule.**
  The code is tested; the first real purge is a human verification step.
- **The nightly export has never been restored.** A backup you have never
  restored is a hypothesis. The manifest exists to make the test possible;
  performing it is a human step that has not happened.
- **No human security review.** See `docs/BLOCKED-ON-YOU.md`.

**Still owed by the Foundation:** the impact metrics CSV, decline wording (the
machinery does not need it; the first real send does), the security review, the
backup restore test, and answers to CLAUDE.md's open decisions #1, #2, #5 and
#7. Decision #4 is answered — see DECISIONS §37.

## The schema already commits to things that do not exist

This matters for sequencing:

- `cycles.rubric_id` is a dangling `TEXT` with no FK (`0002:102`).
- `attachments.parent_type` already admits `'award'`, `'report_submission'` and
  `'rubric'` (`0004:207`).
- `getApplicationForStaff` **fails closed for every reviewer today**, because
  `review_assignments` does not exist (`src/lib/scope.ts:229`). A reviewer
  session currently 404s on every application in the system.

## Changes to the phase plan

**1. Split Phase 2.** CLAUDE.md says it is the highest-risk phase and must not
be compressed. It contains a new identity system, a new storage path, a new
email dependency and the first public endpoint. Four things, not one.

**2. Pull the operational prerequisites forward out of Phase 7.** CLAUDE.md puts
them in Phase 7 and separately says the export must exist before the public form
goes live. Those conflict. Phase 2 is when this system starts holding other
organizations' audited financial statements.

**3. Buy the domain now.** Not in the original plan at all, and it is a hard
blocker: the first public applicant route on an Access-fronted hostname is
either blocked by Access or forces a path-scoped policy rewrite. DNS is lead
time, not effort.

**4. Split the schema work rather than writing it all now.** See below.

## Verdict on writing migrations 0006–0008 in one pass: no

**For:** migrations are cheap to write and impossible to edit once applied, so
one coherent design pass beats six. The schema has already committed to these
shapes anyway.

**Against, and decisive:** eleven tables carry genuine design decisions —
multi-year awards vs `parent_award_id` chains, amendment granularity, payment
vocabularies, whether report periods are generated or authored, whether metric
values are typed columns or JSON. **Four of those decisions are on CLAUDE.md's
own open list and are unanswered** (#2 e-sign, #3 retention, #5 NFL reporting
format, #7 continuity). Freezing guesses into an append-only chain before any UI
has taught us anything spends the most expensive currency in the project on
phases we know least about.

**Split:**
- **0006 now** — rubrics, rubric_criteria, review_assignments, review_scores,
  and the FK on `cycles.rubric_id`. It has a live consumer today: the reviewer
  path is dead until it exists.
- **0008 immediately before awards work.**
- **0009 immediately before reporting work.**

(0007 was taken by `email_messages`, which the send path needed first. The
numbers are ordering, not reservations.)

## Order

| # | Work | Depends on | Note |
|---|---|---|---|
| **1** | Migration 0006: rubrics, criteria, review assignments, scores; FK on `cycles.rubric_id` | — | Unblocks the reviewer path, which fails closed today |
| **2** | Router refactor to a route table; first staff **write** routes (program / cycle / stage CRUD, cycle open-close) | — | Nothing mutating exists. Both the review flow and the public cutoff need this |
| **3** | ~~Resend integration: send helper, failure logging, template harness~~ | — | **DONE.** Migration 0007 (`email_messages`), `lib/email.ts`, `lib/emailTemplates.ts`. Not done: the token behind the sign-in link (item 5), retry/backoff, bounce webhooks |
| **4** | **Domain**: ~~purchase~~ → ~~Worker on custom domain~~ → ~~Access on the staff hostname~~ → `workers_dev = false` → Resend DNS | — | Mostly DONE. Remaining: flip workers_dev once verified, and the Resend records |
| **5** | 2a — applicant identity **including organization resolution**: magic link (single-use, hashed, 15-min, rate-limited), email→organization matching, EIN capture, returning-organization prefill | 3 | `users` requires a non-null `organization_id` for applicants, so signup *must* resolve an org. Prefill and EIN matching move here from 2d |
| **6** | Staff read surface: pipeline list, filters, application detail, FTS search route, applicant-history panel | 1, 2 | The undone half of Phase 1. Parallel with 5 |
| ~~**7**~~ | ~~Draft create: application row, per-cycle limit, stage gate, **public published-only** form endpoint | 2, 5 | **DONE.** `POST /api/applications`, per-cycle limit and stage gate enforced by triggers |
| ~~**8**~~ | ~~2c — uploads: presigned PUT via aws4fetch, bucket CORS, R2 lifecycle | 7 | **DONE** except a real bucket. Presigned PUT via aws4fetch, no Content-Type, verified against a real Chromium. Bucket CORS and R2 lifecycle still outstanding |
| ~~**9**~~ | ~~Autosave + whole-form validate + submit + confirmation read-back email~~ | 7, 8, 3 | **DONE.** Server drafts, submit route, confirmation email with read-back. Compliance hook still a no-op; Eloqua opt-in sync still not built |
| **10** | Rubric upload and parse, assignment, conflict-of-interest declaration at assignment | 1, 6 | |
| **11** | Scoring, weighted totals, normalization view, offline export/import, decision recording | 10 | |
| **12** | Cron D1→R2 export; SPF, DKIM, DMARC | 4 | Fills the stub at `src/index.ts:223` |
| **13** | Conduct the human security review; accessibility pass with real assistive technology | 8, 9, 4 | Gate, not a task. I cannot perform either |
| **14** | 2d — public cycle page, Turnstile, privacy notice, hard cutoff, grace rule | 8, 9, 12, 13 | The first public endpoint. Nothing public ships before 13 |
| **15** | Migration 0008: awards, amendments, payments | 11 | |
| **16** | Phase 4 — awards, payments, decision communication (embargo, acceptances before declines, human review before send), optimistic locking on awards | 15, 3, 11 | |
| **17** | Migration 0009: report periods, submissions, metrics | 16 | |
| **18** | Phase 5 — grantee reporting; **enable** the compliance gate built at 9 | 17, 16 | |
| **19** | Phase 6 — dashboard and exports | 16, 18 | |
| **20** | Phase 7 residual — Eloqua opt-in sync, Formstack import, organization merge tool, data health | 9, 16 | Do not let this evaporate. `organizations` deliberately has no unique index on EIN because duplicates are expected and an admin merges them; without the tool they accumulate from the day 9 ships |

## Decisions needed

**RESOLVED 2026-09-08** (see `docs/DECISIONS.md` §12, §13):
- Friendly-organization test data goes in a third database, `steward-staging`.
- Eligibility becomes its own gating stage, re-seeded before anyone uses the form.
- First build: migration 0006, the router refactor with the first write routes,
  and the Resend integration.

**Blocking, in order of urgency:**

1. ~~Where the friendly-organization test data lives.~~ RESOLVED — see above. CLAUDE.md verifies Phase
   2 by having three real organizations submit real applications. Today
   `database_id == preview_database_id` — one database — and `seed:preview`,
   `admin:apply` and `migrate:preview` all run against it with `--remote`. Real
   EINs and audited financials in the database people run destructive scripts
   against inverts the spirit of non-negotiable #2. Options: a third D1
   (`steward-staging`), or a deliberate production cutover before that test.
2. ~~The domain, and how Access is re-scoped once public paths share the
   hostname.~~ RESOLVED — houstontexansfoundation.org is registered; staff on
   `grants.`, applicants on `apply.`, Access covers the staff hostname
   entirely and never touches the applicant one. See DECISIONS.md §14, §15.
3. **The IRS Business Master File / Pub 78 data source** — which file, where it
   lives, refresh cadence, who refreshes it. `src/lib/ein.ts` defines the result
   type and has nothing behind it. Blocks the EIN check in item 5.
4. ~~Eligibility: section or stage.~~ RESOLVED — separate gating stage. Original note: It is currently section 1 of a
   single-stage form (`src/seed/inspireChange.ts:52`). CLAUDE.md wants a
   fail-fast screen that never collects a full application from an ineligible
   organization. Published form definitions are immutable, so changing this
   later means a new version while applicants may be mid-draft.
5. **Applicant login: magic link plus what.** The link is a prior decision and
   stands. The open question is the fallback, because corporate scanners follow
   links in mail and burn a single-use token before the applicant clicks. A code
   alongside the link, or a link that survives a HEAD or prefetch.

**Not yet blocking, but cheap now and expensive later:**

6. Retention policy for uploaded financials (open decision #3) — sets the R2
   lifecycle rules and key layout, so it wants answering before item 8.
7. Concurrency on awards: optimistic locking, or last-write-wins in writing.
8. Grace rule for drafts started before close (open decision #6) — blocks 14.
9. Whether declined applicants keep portal access (open decision #4) — shapes 5.

## Not proposed

- No production deploy in any item here, pending decision 1.
- No public endpoint before item 13.
- Offline scoring stays a fallback, never the default path.
- The public grantee page (Module 8) is deliberately dropped for now.
