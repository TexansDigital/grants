# Decisions made during Phase 0

These were made to keep the build moving. Each is cheap to reverse now and
expensive to reverse after Phase 2 holds real applications.

## 1. A published form definition is immutable

Editing a published form mints a new version. Enforced by triggers in migration
`0003`, not by convention.

**Why.** An edited label on a 2026 form silently changes the meaning of a 2024
application. These are financial records read years later, sometimes by people
reconstructing why a grant was awarded.

**Cost if wrong.** An admin who wants to fix a typo mid-cycle has to publish a
new version, and applications already in flight stay pinned to the old one.
That is more friction than editing in place.

**To reverse.** Drop the `*_after_publish` triggers and allow in-place edits.
Do it before real applications exist, not after.

## 2. The Inspire Change seed is structurally complete, not copy-faithful

Every field in the reference list exists with the right type, validation, and
`maps_to` target. Exact labels, help text, and option wording still need to
come from the Formstack export.

**Why.** The brief describes the fields in prose, not as exact strings. Guessing
at applicant-facing copy and shipping it as if it were confirmed would be a
false green light.

**To close.** Content entry against existing rows. Not a schema change.

## 3. A multi-stage program creates one application row per stage

An LOI and its invited full application are two rows linked by
`prior_application_id`.

**Why.** Each stage's submitted state stays frozen and auditable. Prefilling the
full application from the LOI becomes an explicit copy with an audit row rather
than an in-place overwrite of an already-submitted record.

**Cost if wrong.** "Show me this organization's journey" is a chain walk rather
than a single row read.

## 4. Search is an aggregate document, populated at submit

One FTS5 row per application, not an external-content index over
`application_answers`.

**Why.** Two reasons, in migration `0005`. The useful unit of search is the
application, not the answer fragment. And autosave writes every few seconds, so
trigger-driven index maintenance would rebuild continuously for drafts nobody
searches.

**Consequence.** Drafts are not searchable. Staff search submitted work, so this
is correct rather than merely acceptable.

## 5. `value_int` and `value_real` are separate columns

The data model in the brief specified a single `value_number`.

**Why.** A column named `value_number` takes REAL affinity in SQLite. That is
precisely how a grant amount silently becomes a float. Currency and integer
field types write to `value_int` only, and a `typeof()` CHECK makes a float
physically unable to land there.

## 6. Audit and error logging are Phase 0 deliverables

The phase list left them implicit until later.

**Why.** Phase 0 introduces no mutating endpoints, so the definition of done
would be unfalsifiable for the first phase. Landing the tables, the helpers, and
the org-scoping helper now means Phase 1 cannot be built without going through
them.

## 7. One person represents exactly one organization

**Decided by the owner.** A user carries a single `organization_id` and email is
globally unique among live users.

**Scope of the constraint.** It binds APPLICANTS and GRANTEES only. Outside
review consultants are `reviewer` role with a null `organization_id`, so a
consultant reviews across every program from one account. That was the case I
had originally flagged, and it turns out not to be affected.

**What it means operationally.** A shared executive director serving two
nonprofits needs two email addresses. A person moving from one nonprofit to
another needs a new account rather than a reassignment. A grant consultant
cannot apply on behalf of two clients from one login.

**To reverse.** A `user_organizations` join table and a change to how
`sessionOrgId` derives scope. Cheap while the scoping tests are the only
consumers; expensive once Phase 2 holds real applications.

## 8. Rubrics are parsed server-side, from CSV and XLSX

**Decided by the owner:** both formats. My earlier recommendation was CSV-only,
on the assumption that XLSX meant a SheetJS-scale dependency (~350 KB gzipped)
in a Worker bundle against a $10/month run-cost target. Measured, that
assumption was wrong and the recommendation with it.

**Parser: `read-excel-file`,** used via its `web-worker` entry.
- Bundles to **17 KB gzipped** (53 KB minified) — 0.17% of the Workers size
  limit, negligible cold-start cost.
- Verified to parse inside workerd, not merely to import.
- No known advisories.
- Returns numbers as numbers, so a weight cannot silently arrive as `"30"`.

**Why not SheetJS.** npm's `xlsx` is frozen at 0.18.5 with two HIGH advisories:
prototype pollution (CVE-2023-30533) and a ReDoS. The fixes ship only in
0.19.3+, published from SheetJS's own CDN rather than npm, so there is no
registry upgrade path. Parsing admin-uploaded files with a known-vulnerable
parser is not a trade worth making for a once-a-cycle action.

**Test fixtures build a minimal .xlsx by hand** (`test/xlsxFixture.ts`, ~60
lines over `fflate`) rather than pulling in a spreadsheet-authoring dependency.
It also documents exactly what file shape the parser must accept.

## 9. Toolchain: wrangler 4, but deliberately NOT the newest test pool

Upgraded: `wrangler` 3.114 to **4.129.1**, `@cloudflare/vitest-pool-workers`
0.8.19 to **0.12.21**, `@cloudflare/workers-types` 4 to **5**, `vitest` 3.0.9 to
**3.2.7**.

**Why 0.12.x and not 0.22.x.** The pool's release lines split cleanly:

| pool | vitest | miniflare |
|---|---|---|
| 0.12.x | 2.0.x - 3.2.x | 4.x stable |
| 0.14.x - 0.18.x | ^4.1.0 | 4.x stable |
| 0.20.x+ | ^4.1.0 | **5.x alpha** |

0.12.21 is the last line that reaches wrangler 4 without also forcing a vitest
major. Everything from 0.20 up ships an **alpha** miniflare, and an alpha
runtime under the test suite of a system that records other people's grant
money is not a trade worth making to clear dev-tree advisories.

**Verified after the upgrade:** 167 tests pass, both tsconfigs typecheck, all
five migrations apply locally under v4, `wrangler.toml` parses, and
`--env production` still fails at config-parse time on the placeholder values.

**`@cloudflare/workers-types` v5 dropped the dated entrypoints**
(`.../2023-07-01`), so `tsconfig.json` now references the package root. Note the
consequence: the type surface is no longer pinned to a compatibility date, so
TypeScript will now accept APIs newer than `compatibility_date = 2025-01-15`.
Generating types from the config with `wrangler types` would restore that
coupling and is worth doing when Phase 1 adds bindings.

**Honest correction on advisories.** I said these would mostly clear with the
wrangler 4 upgrade. They did not. What actually changed:

- The **critical** (vitest UI arbitrary file read) is **fixed** by vitest 3.2.7.
- The **deploy-path wrangler is clean**: the advisory range is 4.16.0-4.113.0
  and we run 4.129.1. The `wrangler` entry npm still reports is the pool's
  *nested* 4.72.0.
- Seven remain (6 high, 1 low): esbuild, miniflare, sharp, undici, ws, and that
  nested wrangler. **All are dev-only** -- `npm audit --omit=dev` is clean, so
  none of it reaches the Worker. They run on developer machines and CI against
  local fixtures.
- npm's only offered fix is pool 0.22, i.e. vitest 4 plus miniflare 5 alpha.
  Revisit when a stable miniflare 5 ships.

## 10. Seeding is a checked-in SQL artifact, not an HTTP endpoint

The obvious way to seed a remote database is a `/seed` route on the deployed
Worker. That would put an unauthenticated WRITE endpoint on the public internet
and ship seeding code inside the production bundle.

Instead `npm run seed:build` emits `seeds/<slug>.sql`, applied by a human with
an explicit command (`npm run seed:preview`). Zero seed code reaches the Worker,
and the artifact can be reviewed as a diff before it touches anything.

**The inserts are not written twice.** A hand-written second copy of every
INSERT would drift from `seedProgram` the first time a column changed. The
emitter RECORDS what the real seeder produces, through a D1-shaped fake that
captures statements instead of executing them. The recorder deliberately
implements no read methods, so if the seeder ever starts reading mid-insert it
fails loudly rather than emitting a silently incomplete artifact.

**Ids are deterministic** (`src/seed/deterministicIds.ts`), derived from the
program slug. This is a safety property, not a convenience: nothing is
hard-deleted and `audit_log` is append-only, so a seed run twice with random ids
would leave a **permanent** duplicate program that cannot be removed. With
derived ids the second run collides on the primary key and aborts. There is a
test that runs the seed twice and asserts exactly one program survives.

**The artifact is byte-stable.** `auditStatement` accepts an optional id and
timestamp so a generated seed does not churn on every regeneration; runtime
callers omit them and get a random id and the wall clock. Without this, ~40 of
92 statements changed per run and the diff was unreviewable.

**The seed contains the PROGRAM ONLY** -- no organizations, contacts or users.
Planting fixture admin rows into a database that Cloudflare Access will later
authenticate against is the wrong default, even with unroutable example.org
addresses. Test fixtures stay in the test suite.

## Still open, and now blocking sooner than the brief implies

- **Grace rule for late drafts (open decision #6).** Implemented as a per-cycle
  `draft_grace_hours`, defaulted to 0 (hard cutoff). Someone has to choose the
  real value before Phase 2 opens a cycle.
- **Declined applicants keeping portal access (open decision #4).** Has a schema
  implication for `users.is_active`. Wanted before Phase 2, not during it.

## 12. Friendly-organization test data goes in a THIRD database, not preview

Decided 2026-09-08, by the owner, after the roadmap review surfaced the
conflict.

CLAUDE.md verifies Phase 2 by having three real organizations submit real
applications on their own devices. Today `database_id == preview_database_id`
in `wrangler.toml` -- one database -- and `seed:preview`, `admin:apply` and
`migrate:preview` all run against it with `--remote`. Putting real EINs and
audited financial statements in the database that destructive scripts are
routinely pointed at inverts the spirit of non-negotiable #2, even though that
rule names production.

So: a third D1, `steward-staging`. Preview stays the throwaway that seed and
admin scripts hammer. Staging holds the friendly-organization submissions and
never has a destructive script pointed at it. Production stays untouched and
its bindings stay placeholders.

Consequences:
- `wrangler.toml` gains an `[env.staging]` block with its own D1, R2 and KV.
- `scripts/checkConfig.ts` must be extended to assert that staging's ids are
  distinct from both preview and production, so a copy-paste cannot quietly
  point the friendly-org test at the throwaway database or the real one.
- No seed or admin script gets a `:staging` variant without a deliberate
  decision to add one.

## 13. Eligibility becomes its own gating stage, not a section

Decided 2026-09-08, by the owner.

The seeded Inspire Change form currently carries eligibility as section 1 of a
single-stage form (`src/seed/inspireChange.ts:52`). CLAUDE.md's submission flow
step 2 wants a screen that fails fast and never collects a full application
from an ineligible organization, which the section form does not do -- an
ineligible org can fill in 34 fields and be rejected at submit.

It becomes a separate `program_stages` entry with `gate_on_prior_decision`, so
the full application is gated on passing eligibility.

Settled now rather than later because published form definitions are immutable
by trigger (`0003_form_engine.sql:121`). Changing it after the form has been
served to real applicants means minting a new version while people may be
mid-draft against the old one. The re-seed is cheap today and expensive the day
after the cycle opens.

This exercises the multi-stage path the form engine was built for, which until
now only the second-program test covered.

## 14. The domain is houstontexansfoundation.org, app on a subdomain

Purchased 2026-09-08 through Cloudflare Registrar, so DNS is in the same
account as the Worker and nothing has to be delegated.

**The app lives at `grants.houstontexansfoundation.org`, not the apex.** The
apex stays free for the public "who we funded" page (Module 8), which is a
different audience, a different threat model, and a different Access posture --
one is behind staff authentication and the other is deliberately public. Giving
them separate origins now costs nothing; separating them later means changing a
URL that nonprofits have already bookmarked.

**Mail sends from a `send.` subdomain, never the apex and never
houstontexans.com.** Two reasons. The corporate domain is Microsoft 365 whose
DNS this project does not control, and adding an SPF include there is an IT
ticket with a real chance of breaking corporate mail. And confining sending to
a subdomain means a future spam complaint damages the reputation of a hostname
that only ever carries login links, not the domain the web application is on.

**The route is declared in wrangler.toml, not clicked in the dashboard.** A
public hostname that exists only as a dashboard setting is a hostname nobody
reviews. `scripts/checkConfig.ts` now asserts that `routes` is top-level (below
a `[table]` header TOML would assign it to that table and wrangler would ignore
it -- the same failure that once left Preview URLs enabled), that the pattern is
a plain hostname, and that a custom domain is never shipped while
ACCESS_TEAM_DOMAIN or ACCESS_AUD is empty.

`workers_dev` stays TRUE until the custom domain is confirmed working and the
Access application covers it. Turning it off first leaves no way in if the new
hostname misbehaves. checkConfig prints a note while both are live, because
that state is correct during a cutover and wrong permanently.

## 15. Staff and applicants get SEPARATE hostnames, not path-scoped Access

Decided 2026-09-08, by the owner, ahead of the public application flow.

  grants.houstontexansfoundation.org   staff. Cloudflare Access covers the
                                       entire hostname, no exceptions.
  apply.houstontexansfoundation.org    applicants and grantees. Access never
                                       touches it; the Worker authenticates
                                       these users itself by magic link.

The alternative was one hostname with Access scoped to `/api/*` and the staff
shell, leaving applicant paths open. Rejected because the failure modes are not
symmetrical. A path pattern that is too NARROW exposes a staff route to the
public internet and nothing complains; a path pattern that is too WIDE locks
applicants out, which at least announces itself. Betting the confidentiality of
other organizations' financial statements on a correctly written path glob is a
bet with no upside.

"Access protects this entire hostname, no exceptions" is also a rule any person
can verify at a glance, without reading a policy. That matters more than one
saved DNS record.

Consequences, none of them due yet:

- One Worker serves both hostnames. The route table will need a host
  constraint, and a staff route reached on apply. must 404 rather than fall
  through to the Access check -- otherwise the separation is a convention
  rather than a control. There is no host field on Route today; it goes in with
  the first applicant route, not before, because an untested constraint that
  nothing exercises is worse than an absent one.
- The applicant hostname is NOT created until something serves it. A live
  public hostname with nothing behind it is a surface with no purpose.
- CSP, cookies and CORS stay simple: same-origin on each hostname separately,
  and the two never need to talk to each other.

## 16. Reviewers do not see internal notes or decision rationale

Decided 2026-09-08, by the owner. CLAUDE.md forbids these in applicant and
grantee payloads and is silent about reviewers; this settles it.

`internal_notes` and `decision_notes` are ABSENT from every reviewer payload --
the pipeline, the detail view and the history panel -- not hidden in the UI.
Enforced by `REVIEWER_APPLICATION_COLUMNS` in scope.ts, an allowlist, so a
migration that adds an internal column cannot start leaking it by default.

The reasoning: staff commentary and prior decision rationale reaching a reviewer
before they score anchors the score on someone else's opinion, which is exactly
what a rubric exists to prevent. It matters most for the outside consultants
CLAUDE.md anticipates, who should form a view from the application and the
rubric, not from "the budget looks thin".

The cost is real and accepted: a reviewer cannot see that staff have flagged an
unresolved compliance issue. If that turns out to matter, the answer is a
structured, reviewer-visible flag on the application -- not opening the free-text
notes field.

## 17. The applicant-history panel shows detail only inside the reviewer's scope

Decided 2026-09-08, by the owner, after an adversarial review demonstrated the
leak.

`organizationHistoryForStaff` gated on "does this reviewer have any live
assignment to this organization" and then returned every application that
organization had ever filed, in full, across every program and cycle -- project
title and exact requested amount included. A reviewer assigned one small
application could read another programme's unfunded $400,000 ask by name. The
docstring claimed it was "scoped the same way everything else is". It was not.

Now: rows inside the reviewer's own scope come back whole; rows outside it come
back as a status, a date and a cycle name, with no id and no title and no
amount. The row is CONSTRUCTED by naming what may be shown rather than by
deleting what may not, so a column added to `applications` later cannot leak
through it by default. Admins are unaffected.

The panel's purpose survives, because the purpose is institutional memory:
"this organization has applied four times, was funded once, last applied in
2024" is what a reviewer should have in front of them. A title and an amount
are not that.

## 18. Real past applications go to STAGING, never to preview

Decided 2026-09-08, by the owner, when the sample data turned out to be real
past applicants rather than invented fixtures.

This is decision #12 becoming load-bearing. Preview is the database that
`seed:preview` and `admin:apply` are pointed at with `--remote`; importing real
EINs, real budgets and real narratives there would put third-party financial
information in the environment destructive scripts routinely run against.

`[env.staging]` now exists in wrangler.toml with placeholder ids that fail
loudly. `scripts/checkConfig.ts` asserts staging never reuses a preview id --
a copy-paste is exactly how the real data would end up in the wrong database,
and the check is what keeps this decision true rather than aspirational.

Nothing real is imported until the staging resources exist and the importer has
been run against invented rows first.

## 19. Declined applicants keep portal access

Decided 2026-09-08, by the owner. Closes open decision #4.

A declined organization keeps its login, can see its submitted application
read-only, and reapplies next cycle with organization fields prefilled.
`users.is_active` stays 1 after a decline; a decision is not a deactivation.

Reduces applicant burden, which is the strongest signal in current grantmaking
practice, and it is also the humane reading: an organization told no in March
should not have to retype its EIN, address, mission and budget in September.

Consequences for Phase 2a: the identity model has no "access ends at decision"
state to build, and the prefill path must read the most recent submitted
application for the organization regardless of its outcome. Reviewer scores,
internal notes and decision rationale remain absent from everything a declined
applicant can see -- non-negotiable #5 does not soften because the answer was no.

## §20 — A stranded email re-drives itself after ten minutes

**Decided 2026-09-09. Directed.**

A send whose provider call never completes leaves an `email_messages` row at
`queued`. Because that row owns its idempotency key, every later call
de-duplicates against it and sends nothing, so a single crash suppresses that
message permanently. For a one-per-entity message — a submission confirmation
keyed `application_received:<application_id>` — the applicant simply never
receives it, and no amount of retrying by a human helps.

Two options were put up:

1. **Time-boxed re-drive.** Treat a `queued` row older than a window as
   stranded and take it over. Self-healing; a small double-send risk if the
   provider actually accepted the first call.
2. **Admin re-drive only.** No double-send risk, but somebody stays locked out
   until a human notices — and nothing currently surfaces stuck rows.

**Chosen: 1.** A duplicate email is a nuisance; a grantee who cannot receive a
link and therefore cannot file a report is a real failure, and one nobody is
watching for.

**Why ten minutes, specifically.** The window is bounded on both sides rather
than chosen for feel:

- **Lower bound:** the provider call aborts after 10 seconds, so a row queued
  for ten minutes cannot still be in flight. There is no race with a live
  request.
- **Upper bound:** the re-drive sends Resend the *same* idempotency key, and
  Resend de-duplicates on that key for 24 hours. Re-driving well inside that
  window means that if the provider did accept the first call before we
  crashed, it drops the second rather than delivering twice.

The provider is what makes this safe. The window is what keeps us inside it.
If the transactional provider is ever changed, this window must be re-checked
against the new provider's idempotency semantics — a provider without them
turns option 1 into a genuine double-send.

**Deliberately narrow.** Only `queued` re-drives. A `failed` row is a settled
outcome with a diagnosis, and retrying it silently would re-attempt something
no human has looked at. A `sent` row is delivered. The recipient/template
identity check runs *before* the re-drive, so a stranded row cannot be hijacked
into delivering to somebody else, and an unparseable timestamp is treated as
not re-drivable — a corrupt row is not a licence to send.

**Still not built:** nothing surfaces rows that fail to re-drive repeatedly.
That belongs with the data-health view (roadmap item 20).

## §21 — Promotion requirements belong to the form, not the program

**Decided 2026-09-09. Forced by §13.**

`programs.required_maps_to_json` lists the `maps_to` targets a form must
collect before it may be published. That was correct while every program had
one stage. It stops being correct the moment a program has two, because the
gate is enforced **per form definition** — at seed pre-flight
(`seedProgram.ts`) and again at publish.

Implementing §13 without changing this would have required the Inspire Change
eligibility screen to collect a requested amount and a list of counties served
before it was allowed to exist. That is the thirty-four-field wall §13 exists
to remove, rebuilt on the screen designed to remove it.

Migration 0009 adds a nullable `form_definitions.required_maps_to_json`, and
`StageSpec` gains an optional `requiredMapsTo`. **NULL inherits the program's
list**, so nothing changes for a single-stage program and no existing row moves.

Inspire Change now sets `['organization_name', 'ein', 'primary_contact_email']`
on the eligibility form and leaves the application form inheriting the full
universal set.

**Why the application form still collects the identity fields**, having already
asked for them at eligibility: promotion writes to the `applications` row at
submit, and each stage has its own row. If the full application did not collect
EIN and legal name, its row would carry neither, and cross-program reporting
would be reading the eligibility row for identity and the application row for
everything else. The applicant confirms prefilled values rather than retyping
them, which is CLAUDE.md's submission-flow step 4 anyway.

**This is not Inspire Change bending the platform.** CLAUDE.md names "LOI then
invited full application" as a supported shape, and an LOI genuinely cannot
collect a reliable requested amount. The single program-wide list was a latent
bug that the first two-stage program was always going to hit.

**Cost paid in the test suite.** `secondProgram.test.ts` asserted that Inspire
Change had one stage and no gate, as the contrast proving stage structure is
data. Both halves are now false. The assertions were rewritten to the property
they were reaching for rather than deleted: two programs express the same shape
— an open first stage gating a second — under completely different stage
vocabularies, with no code that knows either.

## §22 — Magic-link tokens go in D1, sessions stay in KV

**Decided 2026-09-09. Approved by the owner, against CLAUDE.md's "sessions and
tokens: Cloudflare KV".**

**Tokens moved.** A magic link must be single-use. KV is eventually
consistent, so a read-then-delete has a window in which two clicks both find
the token present and both succeed — and both users get a working session with
nothing looking wrong. D1 is strongly consistent, so consuming a token is one
conditional `UPDATE` whose row count settles it. Migration 0010.

**Sessions stayed.** Sessions have no single-use requirement. KV's real
weakness for them is that deletes are eventually consistent, so "sign out"
would not reliably end a session at the moment it is pressed — which is exactly
when it matters, on a shared computer in a nonprofit office.

That is solved without moving them: every session record carries its issue
time, and every lookup compares it against a new `users.sessions_valid_from`.
Signing out sets that column to now, which invalidates every session issued
before now, immediately, with no dependence on KV propagation. "Sign out
everywhere" and an admin revoking access become the same operation.

**Sessions cache nothing.** The KV record holds a user id and two timestamps —
no role, no organization. Every lookup re-reads the user row, so a deactivated
or re-scoped account loses access on its next request rather than when its
session happens to expire.

**Superseding is not consuming.** `consumed_at` is evidence a person signed in.
Requesting a fresh link marks the old one `superseded_at` instead, so an unused
link that was replaced never reads as a session somebody opened. A link is used
or replaced, never both, enforced by CHECK.

**Known redundancy, stated rather than hidden.** `resolveSession` refuses staff
roles, and that check cannot be observed failing: every staff role has a null
`organization_id` by CHECK, and the next guard rejects those anyway. Deleting
the call fails no test and cannot be made to. It is kept as defence in depth
for the day that CHECK is relaxed, and the predicate is tested directly.

## §23 — Drafts live on the server from the moment they exist

**Decided 2026-09-09. Delegated to Claude by the owner.**

The renderer kept answers in `localStorage`, keyed by form id. The indicator
was honest — "Saved **in this browser**" — but nobody reads it that way. They
read the word *Saved*.

An executive director starting on a phone at 9pm and continuing on a laptop the
next morning lost everything. So did anyone who opened the link a second time
inside Gmail's embedded browser rather than in Safari, and anyone whose iOS
Safari evicted site storage after a week away. For a form asking for roughly
three thousand words, that is the difference between an application and an
abandoned one — and it was the top finding of the nonprofit-perspective review.

**A draft is a row from creation.** `POST /api/applications` creates it,
`GET /api/applications/:id/draft` returns the definition and the answers so
far, `PATCH` autosaves.

**Concurrent edits are last-write-wins PER FIELD, not per form.** Answers are
upserted one field at a time, so two devices editing different sections merge
cleanly; two editing the same field, the later write wins. CLAUDE.md is
explicit that there is no real-time collaboration here, and optimistic locking
on a draft would mean showing a nonprofit a merge-conflict dialog — worse than
the problem it solves.

**What satisfies a stage gate.** `program_stages.gate_on_prior_decision` does
not define what counts as a decision. An eligibility screen has no reviewer, so
**passing it is the decision**: a prior-stage application in `submitted`,
`under_review` or `awarded` opens the stage behind it. `declined` and
`withdrawn` are deliberately absent, and a still-`draft` prior stage does not
count either.

A program needing genuine invite-only semantics — an LOI a human reads, then
invites — needs more than this and will get it when review exists. Recorded
because the alternative is discovering later that "gated" quietly meant
"anyone who submitted".

**Not built here:** prefill. Decision 19 says a declined applicant reapplies
with organization fields already filled in, and CLAUDE.md's submission-flow
step 4 wants the same for any returning organization. The data is in the
`organizations` row; wiring it into a new draft is the next piece.


## §24 — The confirmation time is formatted on the server, not in the browser

The submit response carries `submittedAtDisplay`, already formatted in the
program's display timezone with the zone name attached. The browser renders that
string rather than formatting the ISO timestamp itself.

**Why.** It was formatting it itself, and produced "September 9, 2026 at
10:32 PM" — with nothing saying which 10:32, in whatever zone the applicant's
laptop happens to be set to. The confirmation email, meanwhile, said Central,
because it goes through `formatInZone` with the program's timezone. One
submission, two different times, and an applicant in another zone with no way
to tell which one the Foundation means. Cycle deadlines are announced in
Central; a submission time that is not is a trap.

Verified rather than assumed: with the browser set to `Europe/London` the
screen reads "Submitted September 9, 2026 at 5:43 PM CDT".

**Cost if wrong.** One more field on one response, and a browser that cannot
re-render the time if it wants a different format later. Neither matters here.

**The trap this sits next to.** Formatting in the response handler puts it
*outside* the try/catch that protects a committed submit. The application is
already written by the time the response is built, so a throw there — an
invalid `DISPLAY_TIMEZONE` is enough — turns a successful submission into a
500, and an applicant who submits twice. It is inside a catch, falling back to
the ISO string and logging. This was introduced and caught by a test that
already existed for the same hazard on the confirmation email.

## §25 — A removed attachment is never deleted, only unclaimed

Removing a file from a form before submitting drops the reference from the
answer. The `attachments` row stays, with `parent_id` still null.

**Why.** Submit only ever claims what the answer still points at, so an
unclaimed row is inert. That makes "remove" a pure edit to an answer — no
delete path, no R2 lifecycle call, nothing to get wrong at the moment somebody
is trying to fix a mistake. It also matches the platform rule that nothing is
hard-deleted; these are financial records, and a file an applicant attached and
then removed is evidence of what happened, not litter.

**Cost.** Orphaned objects accumulate in R2 — one per file an applicant
attached and thought better of. At 100 to 400 applications a year that is tens
of megabytes, not a problem to solve today.

**To close later.** An R2 lifecycle rule expiring unclaimed objects, which
wants the retention decision (`docs/BLOCKED-ON-YOU.md` §3.3) answered first. A
sweep that deletes rows would be the wrong shape.

## §26 — Autosave is a state machine with no framework in it

`web/src/draftSync.ts` holds the coalescing, the single-flight rule, the retry
policy and every decision about what the applicant is told. `useDraftSync.ts`
is a thin React adapter over it.

**Why.** The failure mode of autosave is not "it did not save", it is "it said
Saved and did not", and somebody closes the laptop. That logic deserves direct
tests with an injected clock, not tests through a component and a fake DOM.
Sixteen tests and thirteen mutants live against the plain class.

**What this deliberately does not claim.** Extracting the logic did not make
the wiring safe, and the two bugs that actually shipped were both in the
adapter: a `useMemo` instance disposed by StrictMode's remount, so every
keystroke went into a dead object while the indicator read "Not saved yet"; and
a handle rebuilt on every render, which made the autosave effect re-run, save,
re-render, and loop until React killed the page. Neither was visible to any
unit test. Both were found by driving it in a browser, which is why that step
is not optional.

## §27 — Applicant uploads stay on R2; the Drive path is proven and parked

Files continue to go to R2 by presigned PUT. The Google Drive work is finished,
verified, and not deployed.

**Why, as a chain of facts rather than a preference.** The Foundation asked for
uploads to live in an organization-owned Drive folder. The case for that was
governance: retention labels, DLP, tenant audit log, malware scanning. Two of
those premises then failed.

There is no Google Vault, which removed retention — the largest prize, and the
only one that would have answered `BLOCKED-ON-YOU` §3.3 without code. Then
Shared Drive creation turned out to be blocked at the tenant: "You don't have
permission to create shared drives" is an admin-console setting on the
organizational unit, not something the account can route around.

That leaves malware scanning and humans being able to browse the folder. Both
real. Neither worth the two things still on offer: files owned by a service
account (which Google refuses outright) or files owned by one employee, which
is the ownership problem this platform already avoids everywhere else.

**What Phase A proved, and what is kept.** A browser CAN upload straight to
Drive. Preflight 200, `allow-origin` echoed, `allow-methods: PUT`, 334,282
bytes sent direct, real HTTP response back, file body never through the Worker.
The narrow `drive.file` scope was sufficient. `spike/` holds the working
service-account JWT signing, the resumable-session mint and the CORS probe.

One trap is recorded there because it nearly ended the investigation: the
upload endpoint answers `vary: origin`, and a session opened with no `Origin`
header produces a URI bound to no browser origin. The browser then fails with
`TypeError: Failed to fetch` and no response — indistinguishable, from the
page, from Google forbidding browser uploads outright. One header. The
server-side preflight probe exists so that failure can never again be mistaken
for a verdict.

**What reopens this.** A Shared Drive, with
`steward-uploads@steward-grants.iam.gserviceaccount.com` as a Content manager.
The upload URL already carries `supportsAllDrives=true`, so the change is a
folder id, the migration adding `storage_provider`, and wiring `presignForField`
to the session mint instead of the aws4fetch signer.

**What this decision does NOT claim.** It does not say R2 is the better place
for other organizations' audited financial statements. It says the Drive move
cannot be completed today, that nothing else is waiting on it, and that the
retention job was always going to be mine to write. The outside security review
recommendation is unaffected either way: this is about where bytes rest, not
who may ask for them.

**Cost of the delay.** If the Shared Drive arrives after the first real cycle,
moving live files is a migration rather than a config change. Worth doing
before Phase 2's friendly-organization test if IT turns it around in time.

---

## §28 — Cloudflare Access is scoped to a HOSTNAME, never to the Worker

**Decided 20 September 2026, after finding the wrong thing live.**

`docs/ACCESS-SETUP.md` told you to create the Access application against the
**Worker**, on the "Self-hosted and private → Workers" tab, with the reasoning
that no custom domain was needed to get started. That was true and harmless
while `grants.` was the only hostname on the Worker.

The day `apply.houstontexansfoundation.org` was added as a second custom domain
on the same Worker, **Access silently began covering it too.** Nothing failed.
Nothing logged. No deploy warned. The Worker's own code was correct throughout —
it verifies the Access assertion and would have refused anyway — but Access sits
at the edge, in front of the Worker, so a nonprofit opening the application form
got a Cloudflare Access login page instead.

That is not a cosmetic problem. **Access free tier is 50 seats, a seat is
consumed by any authentication event, and user 51 is blocked rather than
billed.** Every applicant would have burned a seat, and the fifty-first
nonprofit would have been locked out of their own grant application with no
error anybody could act on.

**The decision.** The Access application's destination is
`grants.houstontexansfoundation.org`, a hostname. It is never the Worker. If a
third hostname is ever added to this Worker, it is unprotected by default, which
is the correct direction for a mistake to point.

**How it was found, and the only way it could have been.** One HTTP request:

```
curl -sSI https://apply.houstontexansfoundation.org/ | head -5
```

A `location:` header pointing at `texansdigital.cloudflareaccess.com` is the
failure. This cannot be reasoned about from the repository — `wrangler.toml`
says nothing about Access — and it cannot be seen in a deploy log. Re-run it
after adding any hostname.

**What else changed because of this.** The split no longer depends on a
dashboard setting at all. `surfaceOf()` in `src/lib/router.ts` derives which
hostname may serve each route, defaulting a non-public route to `staff`, and the
dispatcher 404s a staff route arriving on the applicant hostname before it
authenticates anything. Tests in `test/surface.test.ts` and
`test/authRoutes.test.ts`; seven mutants, all killed.

---

## §29 — The applicant hostname receives mail by forwarding, and sends none

**Decided 20 September 2026.**

`houstontexansfoundation.org` had **no MX record at all**, which meant
`grants@houstontexansfoundation.org` — the reply-to on every letter this system
sends a nonprofit — could not receive anything. A grantee hitting reply on a
decline letter was writing into a void, with no bounce to tell either party.

**The decision.** Cloudflare Email Routing, forwarding only. Two named addresses
— `grants@` and `dmarc@` — both forwarding to a monitored mailbox. No catch-all:
this domain goes on a public grant application, and a catch-all turns every
guessed address into somebody's inbox.

**Nobody sends from this domain's mailboxes.** Asked and answered explicitly.
That rules out a Workspace or 365 seat, and it means a reply to a nonprofit
arrives from a `@houstontexans.com` address. Accepted deliberately: the
alternative is a paid seat or an SMTP send-as identity, and neither is worth it
until somebody is actually assigned to answer grantee mail.

**Why it mattered beyond replies.** DMARC's `rua` address must be able to
receive. With a mailbox on the same domain as the policy, no cross-domain
authorization record is needed; pointing `rua` at `@houstontexans.com` would
have required a TXT record on a domain another team controls, and until it
existed the reports would have been discarded silently.

**Current posture:** SPF (Email Routing's, the only one on the root), DKIM via
Resend's `resend._domainkey`, DMARC at `p=none` reporting to
`dmarc@houstontexansfoundation.org`. Tighten past `p=none` only after weeks of
real sends confirm alignment — publishing `p=reject` early means the first thing
rejected is your own decline letters.

---

## §30 — The root path is served by the Worker, not the asset router

**Decided 20 September 2026, while fixing §28's sibling bug.**

Cloudflare's asset router answers anything matching a file in `./public` before
the Worker runs, and `/` matches `index.html`. So the `{ path: '/' }` entry in
the route table was **dead code**: the client router maps `/` to the staff
pipeline and cannot see which hostname served it, so on `apply.` a nonprofit got
the staff shell, which called `/api/session`, correctly received 401, and
offered a "Reload and sign in" button that returned them to the staff shell.

An infinite loop, at the address about to be printed on a grant application,
reachable by typing the hostname and nothing else.

**The decision.** `run_worker_first = ["/"]` in `wrangler.toml`. Exactly one
path. Everything else — the hashed JS and CSS especially — still bypasses the
Worker, which is what keeps this inside the run-cost target.

**The generalisation worth remembering.** A route in the table is not evidence
that the route runs. Between the request and the handler sit the asset router,
Access, and the edge, and each of them can answer first. The test suite cannot
see any of them.

---

## §31 — The page's CSP names the upload bucket, and only that bucket

**Decided 20 September 2026, after finding uploads could never have worked.**

`Content-Security-Policy` carried `connect-src 'self'` and nothing else. A file
upload goes **direct from the browser to R2** — the Worker only authorizes it,
because streaming a 15 MB file through the Worker hits the edge request-body
limit before the handler runs — so the presigned PUT is a cross-origin request
from the page. The policy refused it.

**The failure was completely silent.** The browser refuses such a request
*before making it*: no request reaches R2, so there is no 403; the Worker was
never involved, so there is nothing in any log; the only trace is a console
line on a page nobody is watching. Every applicant and every grantee upload
would have failed this way, and three uploads are required to submit an Inspire
Change application.

**Nothing in this repository could see it.** The unit tests never asserted on
the policy. `scripts/e2e-applicant.mjs` drives **Vite's dev server**, which
serves no CSP at all — so its upload assertions passed for years against a page
with no policy on it. The fault existed only in headers the Worker writes, and
only the Worker's own responses carry them.

**The decision.** The policy is built, not constant. The HTML shell — and only
the shell, because a CSP governs only the document it arrives with — carries
`connect-src 'self' https://<bucket>.<account>.r2.cloudflarestorage.com`, built
from the same helper the presigner uses so the two cannot drift.

**The exact origin, never a wildcard.** `https://*.r2.cloudflarestorage.com`
would work and would admit every R2 bucket on every Cloudflare account. That is
a much larger permission than "this application may write to its own bucket",
and the tight form costs nothing because the origin is already configuration.
When uploads are unconfigured the policy allows nothing extra, rather than
naming a half-built origin that looks deliberate.

**What is now tested.** `test/csp.test.ts` asserts the signer's origin and the
policy's origin are the same string, that no wildcard appears, and that
widening this directive widened no other. `test/routes.test.ts` used to assert
the shell and an API response carried byte-identical policies — which would
force this fault straight back — and now asserts they differ in exactly one
directive. Five mutants, all killed.

**Still not proven, and cannot be from here.** The PUT is intercepted in the
browser harness, so what is verified is the request's *shape* — a PUT, carrying
no `Content-Type`, which is the rule R2 punishes with a 403 that does not
reproduce in curl. Whether R2 accepts it needs real credentials and a real
bucket. That test has a human in it.

---

## §32 — Inspire Change review is not blind

**Decided 21 September 2026, by the Foundation.**

`0015_review_blinding.sql` added `cycles.blind_review` to record a tension
`CLAUDE.md` contains rather than to resolve it: an applicant-history panel at
the point of review ("this org has applied three times, was funded once for
$25,000, filed both reports on time") and anonymised narrative review cannot
both be true of the same review.

**Inspire Change takes the history.** Reviewers see who they are reading about,
and the institutional memory that currently lives in one person's head is on the
screen in front of them.

**The column stays**, defaulting to 0, which is now both the default and the
decision rather than a placeholder. A future program may choose otherwise —
that is why it is per cycle — and `form_fields.conceal_in_review` stays for the
same reason: marking which questions identify an applicant costs nothing now
and cannot be retrofitted once reviewers have scored.

**What this closes.** Nothing needs to hide a field, withhold the history panel,
or ask an admin which mode a cycle is in. The scoring screen shows the
application and its history together, which is the simpler thing to build and
the one the Foundation asked for.

**What would reopen it.** A program where the review pool includes people with
standing relationships to the applicant pool, and where the history is the thing
most likely to bias them rather than the thing most likely to inform them.

## §33 — Turnstile is live on the public form, scoped to one hostname

**Date:** 2026-09-21
**Status:** In force

A Managed Turnstile widget now sits on the public surface. Site key in
`wrangler.toml`, secret in Wrangler secrets, verification failing closed in
the default and production environments when the secret is absent.

**Managed, not Invisible.** Invisible mode decides silently and gives a
blocked visitor no way to prove otherwise. The people on the other side of
this form are nonprofits filling in a forty-field application, sometimes at
eleven at night on the day a cycle closes. A visible challenge they can
complete is worth more than the small amount of friction it costs.

**Scoped to `apply.houstontexansfoundation.org` alone.** Turnstile refuses
every token originating from a hostname the widget does not list. That makes
the hostname list a load-bearing piece of configuration: putting a public page
on a second hostname without adding it to the widget takes the form down
rather than leaving it open. `grants.` is not listed and does not need to be,
because Cloudflare Access sits in front of it and no applicant reaches it.

**The secret was rotated before first use.** The original appeared in a
screenshot during setup. Rotating in the dashboard replaces the secret and
leaves the site key untouched, so it cost nothing; a secret that has been
photographed is not a secret, whatever the odds of it going further.

**Verified in a browser, not by a test.** The widget rendering and a sign-in
link arriving were confirmed by loading the live sign-in page and submitting
an address. Nothing in the test suite can establish this: the suite exercises
`verifyTurnstile` against fixtures, and the failure modes that matter here --
a hostname mismatch, a secret belonging to a different widget -- live entirely
in Cloudflare's configuration. Every future change to the widget config needs
the same browser check.

## §34 — Uploaded financial documents are destroyed 90 days after the decision

**Date:** 2026-09-21
**Status:** In force

Applicants' uploaded financial statements, operating budgets and itemized
spending budgets are destroyed from R2 on a schedule. The `attachments` row
survives with a `purged_at` stamp; the bytes do not.

**Why not the scheme that was proposed.** The original idea was to email the
documents to the key admins and remind them daily to delete their copies.
Emailing multiplies the copies the policy exists to reduce -- outbox, both
mailboxes, the mail provider, its backups, every phone those accounts are
signed into, every forward. Steward can destroy its own copy on day 90. It can
never destroy those. A daily reminder to delete is a request, not a control,
and it is filtered within a week. So the files never leave R2 and the notice
carries a link.

**Reconciled with "nothing is hard-deleted".** That rule is about records. The
record here is what was uploaded, by whom, when, and when it was destroyed, and
all of it survives, append-only, with an audit row. What is destroyed is the
liability. Deleting the row would lose the trail; keeping the bytes keeps the
exposure. The schema refuses to clear or restamp `purged_at`.

**The clock starts at the decision, not the upload.** A cycle runs for months.
A clock from upload would destroy a budget in the middle of the review that
needs it, and would punish whoever applied first.

**A live award suspends it entirely.** An application that produced a pending
or active award has no deletion date at all. The itemized budget is what the
award was made against and what the grantee's spending is checked against;
destroying it would mean holding a grantee to a document the Foundation threw
away.

**The date is recomputed nightly, not stamped once.** Decisions get reversed,
awards get created weeks later, terms get extended. An admin's hold is a
separate column for exactly this reason: written into `purge_due_at` it would
be silently undone by the next night's run, and the file would be destroyed on
the original date with an audit row saying it had been held.

**The notices say "asked for", never "downloaded".** A file drops off the
nightly digest once a download URL has been issued for it. Downloads go from
the browser straight to R2, so this system does not know whether the bytes were
fetched. Somebody deciding whether it is safe to let another organization's
audited accounts be destroyed must not be told "you have a copy" by a system
that cannot know that. The column is named `download_url_first_issued_at` for
the same reason.

**Schedule.** One notice when a file enters the 30-day horizon, then one every
day through the last seven, and nothing in between -- twenty identical daily
emails in the middle is how the last one gets filtered. A digest with nothing
outstanding is not sent at all. One message per admin per day, guaranteed by the
`email_messages` unique index rather than by an assumption about the cron.

**Ninety days is the Foundation's number and lives in `wrangler.toml`.** An
unparseable or sub-one value falls back to the built-in default rather than
being obeyed, because a typo there would destroy documents on the day of the
decision. Per-program retention is the eventual home, alongside compliance
policy; one number for every program is where this has got to.

**Known gaps.** Grantee report attachments are not covered -- they are part of
the award record and are a different question. Applicants and grantees still
cannot re-read their own uploads. Nobody has yet watched a real file be
destroyed on a real schedule; the first purge on preview data is a human
verification step that has not happened.

## §35 — Rubrics are built in the app, not uploaded and parsed

**Date:** 2026-09-21
**Status:** In force

A scoring rubric is composed by an admin on a builder screen, saved as a draft,
and frozen when published. Uploading a spreadsheet and having a model turn it
into criteria was considered and rejected.

**Why not the upload.** It works once and is unaccountable afterwards. Nobody
can say what the weights were in a cycle that has already been decided. A
re-upload silently rewrites a rubric applications were scored against. A merged
cell or a stray row produces criteria nobody intended, and the first sign of it
is a ranking. Uploaded scorecards are still supported as the offline fallback
for a consultant, per CLAUDE.md, and that remains the exception rather than the
path.

**Weights are basis points, and the field takes a decimal.** 10000 is a weight
of 1.0. A weighted total is `SUM(score × weight_bp)` and the ceiling is
`SUM(max_score × weight_bp)`; both are exact integers, and dividing by 10000 is
a display concern. Same discipline as cents, for the same reason: three
criteria weighted a third each in floats gives two identical applications
different totals and ranks one above the other. The input reads "3" and the
wire carries 30000 — the conversion happens once, at the edge, and rounds
rather than truncates, because 0.15 in binary floating point is 0.1499999… and
truncating would store a weight one basis point below what was typed.

**Publishing freezes it; the way forward is a new version.** Editing a
published rubric would rewrite the criteria a closed cycle was already scored
against, and the scores would quietly start meaning something else. The
database enforces this with triggers from 0006; the application says it in
words an admin can act on, because the trigger's message would reach them as an
internal error.

**Versions are per rubric key, not per program**, and criterion keys are
carried across versions. That is what makes "how did we score community need
over three years" a question with an answer.

**A rubric cannot be swapped once scoring has started.** 0006 refuses a score
against a criterion outside the cycle's rubric, so a mid-cycle swap leaves every
score already entered in the table and unreachable — a silent loss of the
reviewers' work. Refusing the swap is the cheaper failure.

**Reads are admin-only, not staff-wide.** A reviewer meets the rubric through
the scoring screen, against the one application in front of them, rather than
as a document to study and optimise against.

**Two faults were found by opening the page, not by the suite.** Neither new
route was in the list that loads session data, so both screens hung on
"Loading…" forever with every unit test green; and the save confirmation was
cleared by the re-read that followed it, so saving appeared to do nothing. Both
are recorded in `scripts/e2e-rubric.mjs`, which now drives the arithmetic a
person actually sees.

**Staff deep links now exist, and did not.** Only the public shells were
listed in the Worker, so every staff screen worked by in-app navigation and
404'd if the address was typed, bookmarked, or followed from an email — which
meant the retention notice's link to `/retention` would have landed on a 404 on
the night it said to act. `/pipeline`, `/configuration`, `/data-health`,
`/retention`, `/applications/:id` and `/programs/:id/rubrics` are now served,
all marked `surface: 'staff'` so `apply.` still refuses them. The shell is
public; nothing in it is — each screen's first act is a call behind Cloudflare
Access, so a stranger gets an empty frame and a 401.

**Known gap.** No scoring screen consumes a rubric yet; that is the third phase
and is not built.

## §36 — Scoring, and the decision that follows it

**Date:** 2026-09-21
**Status:** In force

Reviewers score in the app against the cycle's published rubric; admins read
the scores side by side and record the outcome. This completes Phase 3 except
for the offline export/import fallback.

**A reviewer never sees another reviewer's scores, and the enforcement is that
they are never fetched.** No reviewer-reachable query selects another
assignment's rows — not a filter in the UI, not a column dropped at
serialization. The scoping is a bind in the query that loads the assignment,
so an assignment belonging to anyone else is a 404 before any work happens. The
side-by-side comparison has its own admin-only endpoint and refuses a non-admin
in the library as well as at the route.

**Null is not zero.** An empty score box clears a score; zero is a judgement
that the application does nothing on that criterion. Collapsing them would let
an unfinished review pass the completeness check and carry scores nobody gave
into a weighted total. The UI sends `null` for an emptied box, the API
soft-deletes the row, and a test at each layer holds it.

**Every criterion must be scored before a review can be submitted.** A review
with two of three criteria blank produces a total lower than the reviewer meant
and is compared directly against colleagues who filled all three. It looks like
a judgement; it is an omission.

**Only submitted reviews count toward the average.** A half-finished sheet is
low because it is half finished. The screen says how many are outstanding
rather than letting the number be quietly partial.

**A declared conflict stops scoring.** CLAUDE.md puts disclosure at assignment
rather than at scoring because a conflict discovered while scoring has already
contaminated the score; the same reasoning applies afterwards. The admin's move
is to recuse or reassign, both recorded. **Gap:** there is no way to resolve a
declaration the Foundation judges immaterial without recusing and reassigning.

**A reviewer can reopen their own submitted review until the application is
decided.** The alternative — finding an admin at 9pm, or a review nobody can
correct — puts the wrong number into the decision.

**Recording a decision creates no award and sends nothing.** Not every declared
intent survives acceptance, and CLAUDE.md puts W-9 and the media release at
acceptance rather than application, which cannot be true if an award springs
into existence at the decision. Decline emails are never automatic, and the
surest way to keep that true is for this path to have no way to send one. A
test asserts that no message row appears.

**A decline cannot be recorded without a reason.** 250 of them go out in a week
and one gets screenshotted; whoever writes that letter needs to know why months
later. The rationale is written to the append-only audit log as well as to the
row, because the row can in principle be edited.

**One decision per application.** A second is either a double-click or one
person overwriting a colleague's call, and both deserve to be told. Changing a
settled decision is a deliberate act that does not exist yet.

**No score normalisation, deliberately.** Adjusting for a systematically harsh
scorer means showing a decision-maker a number no reviewer gave. At this volume
the per-reviewer weighted totals make a harsh scorer visible without inventing
figures. This confirms §32's finding rather than revisiting it.

**Fourteen mutants, all killed.** Including: reviewer scoping dropped, recused
reviewers still scoring, another reviewer's scores joined into the sheet, null
treated as zero, the completeness check removed, conflicts no longer blocking,
unfinished sheets in the average, the summary reachable by a reviewer, a
reviewer deciding, a decline needing no reason, and `INSERT OR REPLACE` in
place of the update-then-insert pair.

**One fault found by opening the page, again.** An incomplete history fixture
threw inside the applicant-history panel, the error boundary replaced the whole
page, and three reviewer assertions — all of the form "this count is zero" —
passed against it. The harness now proves the page rendered before asserting
what is absent from it. This is the same vacuous-assertion trap as §35's
`not.toBeNull()` on a missing row.

**Known gaps.** The offline export/import fallback for consultants is not
built. There is no bulk view ranking a whole cycle by score — the comparison is
per application. Nothing yet writes an award from an awarded decision.

## §37 — Declined applicants keep portal access, and the portal does not break the news

**Date:** 2026-09-21
**Status:** In force. Closes CLAUDE.md open decision #4.

**The Foundation's answer:** declined applicants keep portal access, and there
should be nothing for them there. Both halves are now true, and the second one
was not.

**What was already correct.** A submitted application is read-only — `saveDraft`
refuses anything that is not a draft — so a declined applicant can sign in, read
what they sent, and do nothing else. The decision rationale has never been in an
applicant payload.

**What was wrong, and is the reason this section exists.**
`applications.status` became `declined` the instant an admin recorded the
decision, and the applicant's own portal read that column. A nonprofit signing
in on Tuesday would have learned it was declined from a status badge, days
before the letter a human was still writing — defeating the human-release gate
on the decline email entirely, and defeating "acceptances send before declines"
along with it.

**The fix is a mask, not a hidden field.** `applicantVisibleStatus` shows
`under_review` for an awarded or declined application until
`decision_communicated_at` is stamped. The communication columns are internal,
so the payload does not carry a `decision_communicated_at: null` beside a masked
status — which would hand back exactly what the mask withholds. `withdrawn` is
never masked: the applicant told us.

**Staff are not masked.** The same function is not applied to the staff read.
Masking there would hide a recorded decision from the people who recorded it,
including on the screen where they go to send the letter.

## §38 — Decision letters: the words are the Foundation's, the order is enforced

**Date:** 2026-09-21
**Status:** In force

**There is no standard decline wording in this system, deliberately.** 250
declines go out in a week and one gets screenshotted and forwarded. The
Foundation has not settled what they should say, and a default that shipped
would be this system putting words in its mouth to 250 nonprofits. The template
is a shell — brand, greeting, footer, escaping — and the paragraphs are supplied
at send time. An empty body is refused, and a test asserts the rendered letter
contains no consolation language nobody wrote.

**Neither letter can be sent by a machine.** Both templates are
`requiresHumanRelease`, so `sendEmail` throws without a named releaser. That is
on the template rather than in the caller, so it holds for every path rather
than for the one that remembered.

**Acceptances go first, and the gate is "all", not "some".** A decline is
refused while *any* award in the cycle is still untold. Fifty awards go out on
Monday; forty-nine send and one bounces; if the gate asked "have any gone out"
the declines would start landing while one grantee still had no idea. The first
version of that test had one award, so "some" and "all" were the same sentence
and a mutant swapping them survived. The manual-recording path is gated on the
same question, because recording a manual decline has the same effect on the
portal as sending one.

**The award letter carries the embargo as its own block.** `announcement_date`
is a separate fact from `decided_at` because grantees told on Tuesday post on
Tuesday. A letter that buries the date in a footer has not said it, so it is
asserted in both the HTML and the plain-text body — plain text being what a
phone shows first.

**An award letter cannot go before the award record exists.** It carries an
amount. This is also what keeps "a decision is not an award" true in practice.

**Communication is stamped, not derived from `email_messages`.** The largest
awards are phoned by the executive director. A column that could not record that
would push somebody to send a duplicate email to make the portal behave. Three
columns — when, by whom, how — enforced together by trigger, because a date with
no method cannot answer the question the column exists for.

**The decline's words are not copied into the audit log.** `email_messages`
holds the subject; the body of a letter to a third party is not something to
duplicate into an append-only table nobody can edit.

**Seven mutants, all killed** after one survivor was fixed: the portal
announcing the decision, the mask leaking its own flag, the acceptances-first
gate removed, an empty decline body accepted, an award sent with no award row,
the already-told check removed, and the all-versus-some gate.

**Known gaps.** No bulk send — each letter is sent individually, which at 250
declines is a long afternoon and is the next thing to build here. Nothing yet
creates the award record from an awarded decision, so that step is manual. The
Foundation still owes the decline wording itself; the machinery does not need it
and the first real send does.
