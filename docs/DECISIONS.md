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
