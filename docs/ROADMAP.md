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



## Fixed 29 September — every action on a staff screen wiped the page's state

Found by a person using it, after the suite and two browser harnesses were all
green.

An admin pressed "Build a report form from this program's metrics". The page
blinked and said nothing. They pressed it twice more. Three identical drafts sat
in the preview database, and the button had worked every time.

The control returned to idle on success and rendered nothing, which was its own
small fault. Underneath it was a much larger one. Every mutation calls
`onChanged`, which bumps `reloadKey`, which reruns the load effect, which called
`setLoading(true)` unconditionally — and `loading` replaces the **whole app**
with "Loading…". So any action anywhere unmounted the entire tree and rebuilt it
from nothing.

Nothing errored. What it cost was every piece of transient state on the page: a
message a control had just written, a row somebody had expanded, a field typed
into and not yet saved. Any component that tried to say what it had just done
was guaranteed to have that message destroyed by the re-read it triggered.

A refresh of the screen already on show is not a load. It now keeps what is
rendered until the new data arrives; moving to a different screen still blanks,
and the key is the whole route including ids, so opening a second application
does not flash the first.

The build control also says what it made — version, question count, and that
pressing again makes another draft.

Verified across every browser harness, because this is the router: staff,
accessibility, grantee and applicant paths all drive clean. The applicant
harness reports one console error, `ERR_TUNNEL_CONNECTION_FAILED` on
`challenges.cloudflare.com`, which is Turnstile being unreachable from the
container this ran in — confirmed by curl, unrelated to the change, and not
something this environment can prove either way.

## Changed 29 September — EIN and contact name are optional on an import

The Foundation's 2025 list is organization, contact email, category, amount and
impact. No EINs — those are on W-9s in a filing cabinet — and no contact names,
several of the addresses being shared mailboxes. The importer refused both, so
three years of grant history could not be recorded over a number nobody needs in
order to send somebody a link.

Both are optional now. A malformed EIN is still refused, because blank means "we
do not hold it" and `7412345` means somebody meant to type one and missed. A
blank contact EMAIL is still refused, because a grantee who cannot be reached
cannot report.

**The part that needed care.** Organizations are matched on EIN. Treat a blank
one as a key and every nonprofit without an EIN collapses into whichever came
first — thirteen grants to thirteen organizations import as thirteen grants to
ONE, and nothing looks broken until somebody reads a total. Both the in-memory
cache and `WHERE ein = ''` would have done it independently. An award with no
EIN now matches nothing and gets its own organization; the cost is a duplicate
to merge if that nonprofit later applies with one, which is a known outcome with
a tool for it.

The schema caught the other half on its own: `ein IS NULL OR nine digits` refuses
an empty string, correctly, because an empty EIN is not a value but the absence
of one. The parser was writing `ein ?? ''` to satisfy a non-null type from back
when a missing EIN was a parse error.

Mutated: treating a blank EIN as a matching key. The test reports three
organizations collapsed into one.

The 2025 sheet now has **one** column left to fill — `awarded_date` — and that
was verified by exporting it with only a date added and running it through
`parseAwardsCsv`: thirteen awards, 46,900,000 cents, EINs null, terms none.

## Built 29 September — asking a past grantee for an update

The Foundation wants their 2025 recipients to say what the money did. Every
route to a report period derived its due date from the award's TERM, which for
a grant made in 2025 produces an obligation born overdue: the compliance screen
shows every past grantee delinquent on day one, each is warned about outstanding
reports when they apply again, and an award whose term ended inside the 91-day
chase window gets its grantee emailed weekly about a report that was late before
anyone asked for it. Aimed at exactly the people being re-engaged.

`requestUpdates()` creates an `ad_hoc` period per award in a window of AWARD
DATES, `open` immediately, due on a date the Foundation sets. Guards: admin
only, a label, a real date, a **future** date, and a window that does not end
before it starts. Cancelled awards are skipped; an award already asked is
skipped, so the button is safe to press twice.

**Selected by award date, not fiscal year.** The importer parses `fiscal_year`
and drops it — it lives on programs and cannot tell two cycles of one program
apart — so `awards` has no such column. `awarded_at` is a fact on the row, and
it means nobody has to agree with this code about when their year starts. The
window comparison uses `substr(awarded_at, 1, 10)` so a grant awarded at 4pm on
the closing day is inside it.

Audited as `report_period.update_requested`, deliberately not `.generated`:
generated means derived from a term, requested means a person chose to ask and
chose the date. "Who decided these were due in November" has an answer only if
the two are different words.

The panel dry-runs first and cannot be made not to: the first press counts,
names the organizations and shows what it would skip; only the second writes,
behind a confirm. A program with no published report form is a warning on the
plan, not a refusal — the obligation is real and dated either way, and making
the Foundation decide what to ask before they can decide who to ask is the
wrong order.

Three mutations run, each caught: allowing a past due date, creating the period
as `scheduled` rather than `open`, and dropping the already-asked skip. The
browser drive found a fourth thing no unit test could: the panel only exists
once a program is on screen, and the harness had none at that point.

## Fixed 23 September — files a grantee sends back were retained by nobody

Retention covered `parent_type = 'application'` and nothing else. Every file
attached to a grant report — including the 200 MB videos enabled the same day —
had no deletion path at all, and nobody had decided that.

The fix is deliberately not "the same rule with a different number". An
applicant's audited accounts are collected from three hundred organizations to
fund fifty, and once the decision is made holding them is exposure with no
purpose. A photograph of the thing a grant paid for is the opposite: it is the
deliverable, the reason for asking. A ninety-day clock on it would destroy
exactly what it was collected for.

So:

- **Media is never scheduled for deletion.** Not "kept a long time" — never
  scheduled. A photo or video leaves only when an admin purges that one file
  through `purgeAttachmentNow`, which already audits. The discriminator is the
  stored mime type, so a budget scanned to a PNG is treated as media and kept:
  the safe direction to be wrong in.
- **Report documents are opt-in.** `REPORT_RETENTION_DAYS` unset means nothing
  is scheduled and nothing is deleted. That is decision 3.8 in
  `BLOCKED-ON-YOU.md` and it is the Foundation's; building it with a default
  would be deciding it by whichever behaviour was written first, which is the
  failure CLAUDE.md names for exactly this fork.
- When a window IS set, it runs from the report's **acceptance**, and the
  warning path was widened with it — `filesDueWithin` and `filesPastDue` now
  cover the same set, so nothing can be destroyed that was never warned about.
- `retentionScreen`'s purged list used an INNER JOIN to applications, which
  would have dropped every report file from the one screen whose job is
  answering "what happened to the file we had from them". Now LEFT.

Two things the same pass turned up:

- `GET /api/storage` had existed for a day with **no screen rendering it**,
  which makes "flag it if R2 goes over $5 a month" impossible to honour. It is
  now a panel on Data Health. `unretainedBytes` also read the parent type,
  which stops being true the moment a window is configured; it now reads
  `purge_due_at IS NULL` and means what it says. Media is broken out
  separately, because it is the number that answers what this will cost.
- The storage panel first shipped as `article.check`, making it a health
  finding to anything reading the DOM, and sat above the blocking rows on a
  screen whose premise is blocking first. Caught by the harness in one run.

## Fixed 23 September — the photo a nonprofit could not attach

The report form's photos-and-video field built its `accept` attribute from mime
types alone. Chrome on Windows and on Android carries no mapping from
`image/heic` or `image/heif` to a file extension, so `accept="image/heic"` greys
out every HEIC photo on the device — which is every photo an iPhone has taken.
There is no error message. The file simply cannot be picked, and what a grantee
concludes is that their photos are not allowed.

The suite was green throughout. `validateUploadIntent` accepted HEIC perfectly
well, and `mimeForUpload` had been written specifically because browsers send
an empty type for these files. Nothing had ever looked at the attribute that
decides whether a file reaches either of them.

`acceptAttribute()` now lists the extensions beside the types, from the same
`EXTENSION_TYPES` map `mimeForUpload` reads, so the picker and the rule cannot
disagree. It weakens nothing: accept is a convenience, the Worker re-validates,
and a file admitted by extension resolves to the same type every other path
uses. Document fields are filtered now too — one having a validation block and
the other not was an accident, not a decision.

Two more things the drive turned up:

- The refusal read **"must be a image or video file"**, on the form that pays
  nonprofits. A unit test had pinned that exact string, which is how it
  survived. The article now agrees with the word after it.
- Chromium on Linux reports an empty type for a `.HEIC` file. Removing the
  extension fallback makes the upload fail in a real browser, so that path is
  load-bearing rather than defensive.

Driven by `npm run e2e:media`, which builds its form from `planReportForm`
rather than hand-written SQL — `e2e-grantee.mjs` has drifted from the real
scaffolder twice, and `scripts/buildReportFormSql.ts` exists so a third copy
never has to.

## Open decision, found 23 September — is the itemized budget prose or a document?

Three sources disagree, and one of them is the deployed form.

- **CLAUDE.md's reference field list** puts "itemized spending budget" under
  **Uploads**, alongside the financial statements and the operating budget.
- **Preview's deployed application form** agrees: three upload fields, with
  "Itemized spending budget for this request" among them.
- **The seed** (`src/seed/inspireChange.ts`) makes it a `long_text` capped at
  500 words, and has only two uploads.
- **The Formstack importer** maps the old header "Please provide an itemized
  spending budget of how the grant funds will b…" to `itemized_budget` as a
  TEXT answer — because that is what Formstack asked.

So preview and the constitution say document; the seed and the importer say
prose. This is the 32-versus-34 field drift noticed on 22 September, and this
is what it was.

**Why this is not mine to fix.** Changing the seed's field type would break
the Formstack import of the current fiscal year: historical answers are
paragraphs of text, and they cannot be written into a file-upload field.
Leaving it alone means a freshly seeded program asks a nonprofit to retype a
spreadsheet into a 500-word box.

**The decision:** which does the Foundation want to ask for going forward, and
what happens to the historical text answers if it becomes a document? A
plausible answer is both — keep the text field for imported history, add the
upload for new applications — but that is a choice about the form, not a
defect to repair.

## Fixed 23 September — a single-stage program submitted an empty application

CLAUDE.md lists three program shapes and "Single application" is one of them.
The entry screen only handled the second.

`/apply/start` renders the lowest-`sort_order` stage with a published form.
For a one-stage program that is the full application, and `submitEligibility`
marked it **submitted** — from a screen whose uploads are disabled, because no
application row exists yet to attach them to, and with required-ness relaxed
for the same reason. A nonprofit would answer thirty-four questions, press
submit, and have an application on file with none of its three required
documents and no way back to add them.

The status flip is now conditional on a later stage with a published form
actually existing. On a single-stage program the row stays a **draft** holding
every answer they gave, `submitted_at` and the submission IP stay null —
stamping them would put a submission on file that never happened — the audit
row reads `application.created` rather than `application.submitted`, and the
acknowledgement says the answers are saved and the documents are what is left,
rather than "you are eligible to apply".

Nothing is lost: `answerStatements` has already written every answer, so the
form opens prefilled and only the uploads remain.

**Still open, and a judgement call rather than a defect:** a single-stage
program shows its whole form before an account exists. That is against
CLAUDE.md's step 3 ("account creation by magic link on first save") but it is
not incorrect, and trimming the entry screen to identity fields only is the
Foundation's call about how much to ask up front.

## Found by the authorization census, 22 September — open

**Two functions in `src/lib/scope.ts` have no production caller.**
`getApplicationForExternal` and `getApplicationForStaff` are thoroughly
tested in `test/scope.test.ts` and reached by nothing that serves a request.
The live equivalents are `readDraft` (applicant) and
`getApplicationDetailForStaff` (staff), both of which scope correctly and
name their columns explicitly — so this is not a hole. It is worse in one
specific way: a reader auditing `scope.ts` sees careful, well-tested
scoping and moves on, without noticing the routes go somewhere else.

Discovered by mutation: breaking the `organization_id` predicate in
`getApplicationForExternal` did not fail a single test in the new route
census, because nothing the census can reach calls it.

Decision needed: delete both, or wire `getApplicationForExternal` into a
read-only single-application endpoint the portal could use. Not done
unilaterally — deleting tested authorization code is the user's call.


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
- ~~**No file has ever been uploaded to a real R2 bucket.**~~ **CONFIRMED
  22 September, 20:31 CDT.** A submitted application on preview carries three
  attachments, and one was read back out of `steward-preview-files` with
  `wrangler r2 object get`: 218,056 bytes, matching `size_bytes` exactly, and
  `file(1)` identifies it as a PDF 1.4. Presigned PUT from a browser, against
  a real bucket with real credentials, stored, and readable. Every test before
  this intercepted the PUT against a hostname that does not exist, so what was
  proven was what the browser SENDS; this is the first time R2 accepted one.

**Still owed by the Foundation:** the impact metrics CSV, decline wording (the
machinery does not need it; the first real send does), the security review,
a restore drill against the PREVIEW bucket's nightly export (the drill has been
run end to end, but against an export taken locally), and answers to CLAUDE.md's open decisions #1, #2, #5 and
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

## Remove RESEND_API_KEY from the default environment after cutover

The deployed default Worker (`steward`, bound to `steward-preview`) has a live
Resend key and sends real email to real addresses. That was needed to test
deliverability against the real DNS, and it is fine while the only people
being mailed are us.

It removes a stated safety property: `docs/SECRETS.md` claimed a preview run
could not mail a real applicant. It can. An e2e harness driven against the
deployed default Worker mails whatever address it is handed.

Once production is live, unset the key on the default environment
(`npx wrangler secret delete RESEND_API_KEY --env ""`) so the testing surface
is once again incapable of reaching a real person, and email testing happens
deliberately against production or a staging environment that holds only
fixtures.

## The import's "Next" hint points at a path that refuses awards without terms

After a successful award import the panel says: "Next: Reporting → Create
missing report obligations. Until that runs, these grants have no report due
and no grantee will ever be asked."

True for awards with term dates. False for awards without them, and the 2025
backfill had none: planReportPeriods returns ok:false with "This award has no
term dates, so report due dates cannot be worked out", so that path would have
refused all thirteen and the reason would have arrived thirteen times.

The route that works for them is "Ask past grantees for an update", which takes
a due date from the admin instead of deriving one from a term. The parser
already knows which case it is -- it counts term-less awards and says so in the
report -- so the hint can name the right next step rather than one of two.

Same shape as the import summary that counted thirteen organizations as one: a
line of text beside a button, correct when written, wrong for the data in front
of the person reading it.

## golive should check bucket CORS, because nothing else can

The production uploads bucket had no CORS rules, so every presigned PUT failed
preflight. Nothing caught it: it is not in wrangler.toml, no deploy carries it,
no test can reach a real bucket, and the only symptom is "upload was
interrupted" in the grantee's browser with the reason in a console.

golive already checks the half of this that lives in the Worker -- "the CSP
admits uploads to R2" -- and was green while uploads were impossible, because
the other half lives on the bucket. `wrangler r2 bucket cors list <bucket>` is
one call and would have said so.

Worth pairing with the CSP check rather than adding separately: both halves
have to agree for an upload to happen at all, and either alone passing is the
shape of the fault that shipped.

## A failed upload leaves an attachment row with no parent and no object

The CORS failure on 2026-10-04 left three rows in `attachments` with
`parent_id` NULL, 7.5 MB of recorded size between them, pointing at R2 keys
whose objects do not exist -- the preflight was refused, so no PUT was ever
sent. The row is written when the Worker authorizes the upload; nothing undoes
it when the browser's PUT never happens or fails.

Two costs. Storage figures count bytes that were never stored, so
dataHealth and the storage screen overstate. And a file list for that
organization would show attachments nobody can open.

Worth fixing in whichever direction is honest: either do not write the row
until the object is confirmed, or sweep rows that have had no parent and no
confirmed object for some hours. The second is probably right, because the
row is what the confirm step updates.

## Nothing checks reported spend against the award

The test report recorded funds_spent_cents of 2,500,000 against an award of
10,000 -- $25,000 spent on a $100 grant. It was accepted without comment.

On a test that is funny. On a real grant it is a mistyped figure that flows
into committed-versus-disbursed and the executive export, and surfaces as a
board report that looks wrong months later with no trail back to the typo.

A hard block is wrong: a grantee can legitimately spend more than the grant on
a project the grant part-funded, and refusing their honest number teaches them
to enter a false one. A warning at entry -- "that is more than the grant; is
that right?" -- and a flag on the admin review is the proportionate shape.

## A mistyped address returns raw JSON, not a page

A path the Worker has no route for answers with the API's error envelope:

    {"error":{"code":"NOT_FOUND","message":"That page could not be found.", ...}}

Correct for /api/*, wrong for a browser. On apply.<domain> that is what a
nonprofit sees if they mistype the address printed on a grant application, and
it reads as a broken site rather than a wrong turn.

The fix is to branch on what the client asked for: an Accept header naming
HTML, or a path outside /api/, gets the app shell with a 404 status and a
"that page does not exist" screen with a way back. The envelope stays for
everything else, because an API client parsing HTML is the worse failure.

Not done now because it changes what every unmatched path returns, and the
thirteen reports are open. It is a small change made at the wrong moment.
