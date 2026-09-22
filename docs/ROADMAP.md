# Steward roadmap

Revised after adversarial review. This is a proposed **revision** to the phase
plan in CLAUDE.md, not a restatement of it. Where it differs, the reason is
stated.

**"Nothing here has been built" was true when this line was written and has
not been true for months.** Most of it is built; "Where we actually are" below
is the part kept current, and the rest of the file is the original plan and
its reasoning, preserved because the reasoning still holds even where the
status has moved on. Struck-through items are done or reversed, with what
replaced them.

## Where we actually are

**Last updated 21 September 2026.** This section is rewritten whenever it stops
being true; the rest of the file is the original plan and its reasoning, kept
because the reasoning still holds even where the status has moved on.

**Built and reachable: 1,539 tests, migrations 0001-0024.** Ten browser
harnesses drive real Chromium against the built bundle: three against a real
local Worker, seven against the built bundle with a stubbed API.

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
side, record a decision, create the award record from it, amend it afterwards
with a reason and a permanent history, record receipt of the W-9, the signed
agreement and the media release, send award and decline letters with the
acceptances-first rule enforced, export and re-import an offline scorecard for
a consultant, work a coverage screen that shows which applications are short
of reviewers, resolve a declared conflict without recusing anybody, and read a
dashboard whose CSV is the export executives receive.

**Applicants and grantees can read their own uploads back.** Every file a
nonprofit sends -- audited accounts on an application, a budget filed with a
report -- can be opened again from the page it was attached on, through a
five-minute signed URL scoped to the session's organization.

**An applicant is never told by the portal.** An awarded or declined
application reads as still under review to the applicant until somebody
communicates the decision — by letter from Steward, or by phone, recorded.

**Also built:** awards and the payment ledger, grantee reporting with
per-program metrics, the compliance desk, data health, organization merge,
the Formstack/awards importer, the nightly D1 export to R2, and a retention
policy that destroys applicants' financial documents 90 days after their
application is decided.

**Grantees are now told their reports are due.** A nightly job on the existing
cron mails a ladder of reminders through Resend -- two weeks out, three days
out, the day itself, then weekly while overdue, and it stops after three
months. One letter per grantee listing every report they owe, carrying no
sign-in token, and the compliance desk shows how many times each report has
been chased. This is deliberately NOT Eloqua: that is still the right home for
it, and it needs six things from a marketing admin that do not exist yet. Until
they do, a portal nobody is sent to is a portal nobody files in.

**Not built:** the Eloqua opt-in sync, a server-generated PDF -- the browser's
own print-to-PDF is what exists, and the print stylesheet is now its design
rather than an afterthought -- EIN verification against the IRS file
(`src/lib/ein.ts` has the result type and nothing behind it, pending decision
#3 below), and award documents as FILES rather than dates -- receipt is
recorded, the document itself still arrives by email. Declines now send in
rounds rather than one at a time.

The public grantee page IS built, contrary to "Not proposed" at the foot of
this file: a read-only list gated on an admin marking an award public, the
grantee having been told, and the embargo date having passed. The payment
ledger is built too, so "committed versus disbursed" is a number rather than
an apology.

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

- ~~**The Turnstile widget has never rendered.**~~ **CONFIRMED 22 September.**
  The Worker's CSP had blocked its script and its challenge iframe outright, so
  bot protection on the public endpoints had never once run. Fixed, deployed,
  and seen returning Success on `apply.` in a real browser.
- **No file has ever been uploaded to a real R2 bucket.** Keys and CORS were
  set on 22 September; every presigned PUT before that was against a stub. Two
  faults on this exact path have already been found by opening a console rather
  than by any test. See `BLOCKED-ON-YOU.md` §1.4b.

**Still owed by the Foundation:** the impact metrics CSV, decline wording (the
machinery does not need it; the first real send does), the security review, the
backup restore test, and answers to CLAUDE.md's open decisions #1, #2, #5 and
#7. Decision #4 is answered — see DECISIONS §37.

## The schema already commits to things that do not exist

This matters for sequencing:

*(Written before Phase 1. Kept because the pattern it names kept recurring --
a schema that commits to something no code can reach -- and each instance was
found only by reading the migration rather than by any test.)*

- ~~`cycles.rubric_id` is a dangling `TEXT` with no FK.~~ Fixed in 0006.
- ~~`attachments.parent_type` already admits `'award'`, `'report_submission'`
  and `'rubric'`.~~ Both external-readable types are now reachable.
- ~~`getApplicationForStaff` fails closed for every reviewer.~~ Fixed in 0006.

**Later instances of the same pattern, all now closed:**

- 0012's three award-document columns could not be written by anything for two
  phases, while the data health check measured them.
- 0012 refused to let an awarded amount be updated, pointing at an amendments
  table Phase 4 never built -- so a wrong amount could not be corrected at all.
  Fixed in 0024.
- 0020's `award.accepted` audit action and `status = 'active'` had no writer.
- `reviewCoverage` and the conflict declaration both existed with no screen.

**Still open, and the same shape:** `award_amendments` now exists, but nothing
generates a REVISED payment schedule after an amount is cut -- the ledger says
in words that the schedule overruns the award and leaves the rebuild to a
person. That is deliberate for now and is recorded here so it is not mistaken
for finished.

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
5. **Embedding `apply` and the reporting portal in the CMS.** Requested 22
   September, for a Pocket CMS site. Not decided, and it cannot be until two
   facts are known: what registrable domain the CMS site is served from, and
   whether it sits behind Cloudflare.

   Two things in this system refuse an embed today, both deliberately:

   - `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response.
     Clickjacking protection on a surface that submits money requests and
     uploads financial statements.
   - `__Host-steward_session` is `SameSite=Lax`. In a CROSS-SITE iframe the
     browser does not send it, so the page loads and nobody can be signed in.

   The second one is where the domain question decides everything. An iframe
   of `apply.houstontexansfoundation.org` inside a page on
   `houstontexansfoundation.org` is same-SITE, the Lax cookie is sent, and
   only `frame-ancestors` has to change. An iframe inside a page on any other
   registrable domain is third-party: Safari blocks the cookie outright and
   Chrome is removing it, so sign-in would fail for a large share of
   nonprofits and would fail differently per browser, which is the worst
   possible way for it to fail.

   **RESOLVED 22 September, and the answer is not an embed at all.** The CMS
   site is `houstontexans.com` and Steward is on
   `houstontexansfoundation.org` -- different registrable domains, so any
   iframe is third-party and the session cookie is a third-party cookie.
   Safari blocks those outright and Chrome is removing them. Sign-in would
   fail for a large share of nonprofits, differently per browser, which is the
   worst way for anything to fail.

   So: NATIVE POCKET BLOCKS in the Deep Steel Thunder design system, reading
   Steward's public data and linking out. No iframe, no header change, no
   cookie change. It looks native because it IS their design system, and it is
   their existing workflow rather than a new pattern.

   The data goes through `texansdigital.workers.dev` rather than being fetched
   from Steward directly: their Worker calls Steward server-side, where CORS
   does not apply, and serves the page under the CORS lock and five-minute
   cache they already use. **Steward changes nothing at all.**

   Lives in a Foundation or `/community` section. Three blocks are worth
   having: open cycles with real deadlines, a reporting signpost for grantees,
   and the funded-grants list from `/api/public/grants`.

   Worth saying separately from the security: a forty-field form filled over
   an hour is a poor thing to put in an iframe even where cookies work. Nested
   scrolling, an autosave indicator that can sit off-screen, file pickers that
   behave badly in frames on iOS, and a back button that does not do what the
   reader expects. Linking out is the better experience here, not merely the
   only one that works.

6. **Applicant login: magic link plus what.** The link is a prior decision and
   stands. The open question is the fallback, because corporate scanners follow
   links in mail and burn a single-use token before the applicant clicks. A code
   alongside the link, or a link that survives a HEAD or prefetch.

**Not yet blocking, but cheap now and expensive later:**

7. Retention policy for uploaded financials (open decision #3) — sets the R2
   lifecycle rules and key layout, so it wants answering before item 8.
8. ~~Concurrency on awards: optimistic locking, or last-write-wins in
   writing.~~ RESOLVED — optimistic locking, built in 0024.
9. Grace rule for drafts started before close (open decision #6) — blocks 14.
10. ~~Whether declined applicants keep portal access (open decision #4).~~
    RESOLVED — they keep it, and the portal now offers them a way to reapply.

## Not proposed

- No production deploy in any item here, pending decision 1.
- No public endpoint before item 13.
- Offline scoring stays a fallback, never the default path.
- ~~The public grantee page (Module 8) is deliberately dropped for now.~~
  **Reversed.** It was built: every field on it was already recorded for
  another reason, so it cost no extra data entry, and it partly serves the
  external reporting that is manual today.
