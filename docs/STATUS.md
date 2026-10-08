# Status

**Last verified: 2026-10-08.** Every line below says how to check it, because a
status file that nobody can re-verify becomes fiction within a week. This
project has already been bitten three times by a document that was true when
written and false when read.

Where it says **you**, that is the Foundation. Where it says **Claude**, that
is the assistant. Where it says **unknown**, neither of us has checked.

---

## Blocking right now

**One decision and one cleanup. No engineering.**

The live end-to-end check is **done, 2026-10-08.** A report obligation was
created against a test grant, the nightly reminder was read as a plan on the
Reports screen, sent on confirmation, and the letter **arrived in a real
inbox** reading *"October 22, 2026. Due in 14 days."* — the right day, in the
right words, from `grants@houstontexansfoundation.org`.

That is the first time this system has been shown to put a letter in front of
a human being. It also caught a bug before thirteen nonprofits did: see
*A due date in a letter is a day, not an instant* below.

### 1. The due date for the 2025 update — the Foundation's call

Condition 10, and the only thing gating the pilot. The due date **is** the send
schedule: the nightly job mails at 14 days, 3 days and on the day, so a date
inside two weeks emails everybody tomorrow.

### 2. The test rows are in production again

Today's check put them there deliberately. As of 2026-10-08 production holds
**14 awards, $469,001.00, 14 organizations and 2 report periods** — the real
thirteen plus `TEST-2026-001`, its two periods (one `accepted`, one `open`) and
its three grantee logins.

Clear them before the real ask, or the dry run says fourteen and confirming it
emails whoever is on the test contact record:

```
npx wrangler d1 execute steward-production --remote --env production --yes \
  --json --command="$(cat scripts/sql/remove-test-data.sql)"
```

It ends by printing what is left. Expect `13 / 46900000 / 13 / 0`. **The dry
run must say 13** before anyone confirms the real send.

### Not blocking: mail into `houstontexans.com`

Two letters to `@houstontexans.com` addresses were recorded `sent`, shown
**Delivered** by Resend, and reached no mailbox. The same letter reached Gmail.
So the sending side is sound, and this is filtering inside the Texans' own M365
tenant — plausibly anti-impersonation, a lookalike domain carrying the
company's name into the corporate domain being the shape of a phish. **It does
not touch the thirteen**, who are all on their own domains. One for the mail
admins, through an Exchange message trace.

**There is nothing to fix in DNS, and this file said so already.** The Gmail
message's own headers, read on 2026-10-08:

```
spf=pass    smtp.mailfrom=...@rsend.houstontexansfoundation.org
dkim=pass   header.i=@houstontexansfoundation.org header.s=resend
dmarc=pass  header.from=houstontexansfoundation.org
```

All three pass, and both DKIM signatures align to the From domain. **SPF for
Resend is published on `rsend.houstontexansfoundation.org`**, not on the root —
that subdomain is the envelope sender (`Return-Path`), and SPF is checked
against the envelope sender, never against the `From:` a human reads. The root
domain's `v=spf1 include:_spf.mx.cloudflare.net ~all` belongs to Cloudflare
Email Routing and is not consulted for anything Steward sends.

Claude claimed on 2026-10-08 that Resend was missing from SPF and that every
message softfailed. That was asserted from the root record alone, was never
checked, and was **wrong** — see *Bugs found by sweeping* below, where the
class is named.

So a message from this system passes SPF, passes DKIM twice, passes DMARC and
lands in a Gmail inbox, and the Texans' tenant drops it silently. Nothing in
DNS will change that; it needs an allow entry from whoever administers that
tenant.

### Cleared since the last revision

- **Deployed.** `npm run deploy:production` ran twice on 2026-10-08, ending at
  version `b8249d4f` by wrangler's own report. The new API and the interface
  that drives it are both live, which a bare `npx wrangler deploy` would not
  have achieved — it uploads whatever is already in `./public`, so a deploy
  straight after a pull ships the new API behind the old screen. `npm run
  check:commands` fails on a bare one anywhere in this repository.
- `0029` applied, via `scripts/sql/apply-0029.sql` — the DDL and the
  `d1_migrations` row in one command, which is what `0028` got wrong.
  `npm run golive` reads 29 applied, 29 on disk.
- A 7403 from a remote `d1 execute` **is intermittent, and the first response
  is a retry.** It was briefly believed that `--json` was the fix and that
  `npm run migrate:production` could therefore never work; on 2026-10-08 a
  `--json` command failed and then succeeded on an immediate retry, which
  disproved it.
- `npm run deploy:production` and `deploy:staging` now exist and build first.
  Only `deploy:preview` did.

---

## What we are trying to do

Collect progress updates from the thirteen organizations that received Inspire
Change grants in 2025, through a portal those organizations log into with a
magic link.

This is **not** the 2026 application cycle. That is a separate, later launch
with a higher bar (see *Not in scope* at the bottom).

---

## The thirteen conditions

Production is "live" when all thirteen are true. Today: **11 of 13**, with
the two outstanding both the Foundation's to run.

That count was stale at `0 of 13` while eleven rows beneath it said *done* —
the first thing this file warns about, in its own opening paragraph.

### Infrastructure — production serving

| # | Condition | State | How to check |
|---|---|---|---|
| 1 | `steward-production` migrated clean from empty | **done 2026-10-04**, 29 migrations as of 2026-10-08 | `npm run golive` reports 29 applied, 29 on disk; the ledger fault of 2026-10-07 is fixed |
| 2 | R2 buckets and KV created and bound | **done** | `npm run check:config` |
| 3 | Five production secrets set, new signing key | **done 2026-10-04** | `npx wrangler secret list --env production` lists all five |
| 4 | Seeded config only; apps, awards, orgs all 0 | **done 2026-10-04** | 1 program, 2 stages, 2 forms, 2 admins, 5 metrics; apps/awards/orgs all 0 |
| 5 | Deployed, hostnames moved off the default Worker | **done 2026-10-04** | version 9878ea38; wrangler reassigned both custom domains from steward to steward-production |
| 6 | `golive` clean | **done 2026-10-04** | every automated check green against steward-production; four OPEN items remain, none automatable |
| 7 | Access challenges `grants.`, and does NOT cover `apply.` | **done 2026-10-04** | staff shell resolved adam.cann as admin, which requires a valid Access JWT; apply. loads with no Access prompt |
| 8 | `apply.` serving, no open cycles | **done 2026-10-04** | "Nothing is open right now", plus the Tell us about a grant we gave you entry point |

| 8b | Report form published in production | **done 2026-10-04** | version 1, 9 fields, 5 of them linked to metric definitions |

### The work itself

| # | Condition | State | How to check |
|---|---|---|---|
| 9 | Thirteen imported, with an audit row each | **done 2026-10-04**, confirmed 2026-10-07 | listed by hand: `IC-2025-001` .. `IC-2025-013`, `source_system = 'spreadsheet'`, summing to exactly $469,000. One test award, `TEST-2026-001`, is present again from the 2026-10-08 live check and is cleanup item 2 above. |
| 10 | Update request dry-run matched 13, then run | not done — **do not run until the dry run says 13**; the mechanism itself was proven end to end on 2026-10-08 against one test grant | Programs → Ask past grantees for an update. **Gated on a decision, not on engineering:** the due date for the 2025 update is also the send schedule, because the nightly job mails at 14 days, 3 days and on the day. A date inside two weeks means everybody is emailed tomorrow. |
| 11 | A magic link clicked on a phone, from Outlook, with a photo attached | **done 2026-10-04** | link delivered to a shared M365 mailbox, opened on a phone; 3 files uploaded to steward-production-files after bucket CORS was set |
| 12 | Restore drill run against production | **done 2026-10-05** | export `d1/2026-10-05/070101`, 573 rows across 33 tables, every table matching the manifest, 102 triggers off and back on, no dangling references; thirteen organizations and their amounts recognised by hand |
| 13 | One grantee claim approved end to end | **done 2026-10-05** | connected, declined, and the new grantee signed in to exactly one award with no sign of the other thirteen |

---

## Blocked on you

1. ~~Finish the production secrets.~~ **Done 2026-10-04.** All five present.
   The signing key was freshly generated, not copied from preview. The R2 key
   is scoped to `steward-production-files` only, by the reasoning in
   `docs/R2-UPLOADS.md`.

   One credential was exposed in a screenshot during this and **was rolled**:
   the first `steward-production` R2 token was deleted and replaced with
   `steward-production2`. The bucket was empty and nothing was deployed, so
   nothing was reachable with it.

2. ~~Close `FY26 fall test`.~~ **Done 2026-10-04.** Closed by
   adam.cann@houstontexans.com, audit row `cycle.closed` written with the real
   actor rather than `system`. No cycle is open, so nothing on
   `apply.houstontexansfoundation.org` is publicly applyable. This was also the
   first live exercise of the cycle-close fix, which had never worked before
   2026-09-30.

3. ~~Fix the Cloudflare token's KV permission.~~ **Withdrawn. This was wrong.**
   `npm run whoami` on 2026-10-04 shows the OAuth token carries
   `workers_kv (write)`, so nothing is missing. The Authentication error 10000
   on `wrangler kv namespace create --env production` had some other cause,
   still unknown. The namespace exists, so it no longer blocks anything; it is
   recorded here only so the wrong diagnosis does not get acted on later.

## Blocked on Claude

Nothing is blocked, and nothing is waiting to deploy.

Owed, and named here rather than left in a commit message:

- **The funding-history search is not built.** The data it needs now exists
  (an award's focus area, counties and purpose), and the index does not. Until
  it does, a grant is findable by the organization's name, its EIN and its
  reference, and not by what it funded.
- **No CSV or PDF export.** Executives never log in — CLAUDE.md is explicit
  that the export *is* the product for them — so there is currently nothing
  for an executive at all. That is Phase 6.
- **Neither the Grants nor the Organizations list paginates.** The 101st row
  is unreachable. Harmless at thirteen; it is on the clock against 2026.
- **Two admin screens render a calendar day in the browser's time zone.**
  The payment ledger shows a payment due `2026-11-01` as 10/31/2026, and the
  award amendment trail shows a term starting `2026-01-01` as 12/31/2025 — the
  wrong year, on the record of a change to a grant. Same class as the bug the
  reminder letter had; the guard that catches it only looks at the Worker, not
  at `web/`. Found 2026-10-08 by sweeping, not by anyone hitting it. Detail
  under *Bugs found by sweeping* below.
- **A deduplicated send is counted as a send.** `sendEmail` returns
  `deduplicated: true` when an idempotency key has already been used that day
  (`report_reminder:<user>:<day>`), and `runReportReminders` ignores the flag,
  so pressing Send twice reports "N sent" the second time while nothing leaves
  the building. Seen on 2026-10-08 and not yet fixed. `retention.ts` and
  `decisionComms.ts` ignore the same flag and have not been checked. The
  letters are not duplicated — that is the mechanism working — but the count
  on the screen is a lie, and on a decline run that is a lie about whether
  someone was told.
- **`reportDue` computes the UTC day while the grantee portal uses Central.**
  A grantee opening the portal at 8pm Central on the due date sees "due
  today"; the server already counts it a day late, and under a `block`
  compliance policy that can refuse their next application for a report that
  is not late. Flagged four times, not fixed, because it moves a boundary that
  refuses people money and that is not a decision to slip into a UI commit.

## Waiting on the Foundation team

Decisions for people, not engineering, collected in **docs/ONBOARDING.md**.
The one that gates the pilot is the **due date for the 2025 update**: it is
also the send schedule, because the nightly job mails at 14 days, 3 days and
on the day, so a date inside two weeks means everybody is emailed tomorrow.

## Blocked on neither, but owed before the public form

- A **human security review**. Claude cannot certify this and has said so
  repeatedly. The system holds EINs, audited financial statements and
  operating budgets belonging to other organizations.
- **Screen-reader testing** on a real device.
- Scoring rubric, impact metric definitions, decline letter wording.

---

## Checking the databases

Read-only. Run either, or ask Claude, who can query both through the
Cloudflare connector.

```
npx wrangler d1 execute steward-production --remote --env production --json --command "SELECT (SELECT COUNT(*) FROM programs) programs, (SELECT COUNT(*) FROM applications) apps, (SELECT COUNT(*) FROM awards) awards, (SELECT COUNT(*) FROM organizations) orgs"
```

`--json` gives machine-readable output, nothing more. A 7403 from this
command is intermittent and the first response is a retry — see
`docs/RUNNING-COMMANDS.md`.

Before the import, `apps`, `awards` and `orgs` must all read **0**. If they do
not, something was copied that should not have been.

---

## Deployed

**Production version `b8249d4f`, 2026-10-08**, the second deploy that day and
the first one made by `npm run deploy:production`, which builds the web app
before it uploads.

Two deploys on 2026-10-08:

| Version | Carries |
|---|---|
| `f504fe56` | the due-date amendment trail, the reminder plan and confirmed send, the Texas county vocabulary and its picker |
| `b8249d4f` | `formatCalendarDay` — a due date in a letter is a day, not an instant |

`f504fe56` was deployed before `0029` was applied, and was safe under the new
schema only because the code in it never writes `report_periods.due_date`, so
the new triggers could not fire against it. That was luck with a reason behind
it, not a plan; the ordering to want is migration first, then deploy.

Four deploys on 2026-10-07, in order:

| Version | Carries |
|---|---|
| `6277d429` | the To do screen, Grants and Organizations, Impact, the six-item nav |
| `d1715cc0` | the audit-pass fixes — overdue firing a day early, cancelled awards in totals, `revisions_requested` dropped from To do |
| `e970fce1` | the compliance desk banded by who is holding each report up, and the report panel restructured |
| `618a4bfb` | an award's own subject matter: what it funded, its focus area, its counties |

**`618a4bfb` was the first deploy this project has made that carried a
migration** — `0028_award_subject.sql`, four nullable columns on `awards`. It
applied, and the ledger row did not get written; see *Blocking right now*.

Nothing is waiting to deploy. The county vocabulary and picker (`10dcc9e`,
`898d37a`) went out with `f504fe56`.

How to check: `npx wrangler deployments list --env production` names the
version, and the Grants tab lists the imported 2025 grants.

---

## What is already done

Finished and verified, so neither of us re-opens it:

- **Email deliverability.** 9.3/10 on mail-tester, SPF and DKIM both passing
  and aligned (`DKIM_VALID_AU`), DMARC publishing to a real mailbox, Resend
  domain Verified, TLS Enforced. The only deduction is domain age, which
  decays on its own. Do **not** enable Resend click tracking: it rewrites
  links, and your links carry a live credential.
- **The cutover runbook**, `docs/PRODUCTION-CUTOVER.md`. Six phases, each with
  a verification.
- **Phase A and B1.** Production names four resources, none shared with
  preview, no placeholders left.
- **The 2025 grantee file**, `docs/inspire-change-2025-grants.csv`. Thirteen
  rows, $469,000, parses with no problems.
- **The report form**, published as version 3 in preview.

### The To Do screen

Opening the platform now lands on **To do**: one list of everything
outstanding, in the order it should be done — unanswered past-grantee claims,
reports filed and unread, reports overdue, reports due soon, and files near
their destruction date. Before it, each of those lived on its own tab and
raised no hand, and the landing page was the pipeline, which outside an open
cycle is a table of nothing.

Its one promise is that **an empty list means nothing is outstanding**, so
three things are deliberate: a failed load reads as a failure rather than as
nothing-to-do; a truncated list says it is truncated; and a report period that
is still `scheduled` — generated from an award's terms, never requested from
the grantee — counts as outstanding, because that is the case where the
Foundation has not done its part.

Check it: `npm run e2e:todo` drives it in a real browser, both themes and at
phone width, and writes `/tmp/todo-light.png` and `/tmp/todo-dark.png`.

### The award page

Every grant now has its own page at `/awards/<id>`, carrying its facts, its
report obligations, its paperwork, its payment schedule and its amendment
history. Reach it from the amount column on Reporting, or from the "Connected
to" column on Past grantees.

**This was a hole, not a nicety.** All of those screens were mounted inside
the application detail view, and imported grants have no application — so the
thirteen 2025 Inspire Change grants had no page at all. Their W-9 status,
payments and report periods were in the database, served by working endpoints,
and could not be looked at by anybody.

Two things on it are deliberate. A blank Reporting section says **which** blank
it is: without grant period dates, generation is impossible and the fix is to
amend the award; with them, nobody has simply asked yet, and the button to ask
is right there. And an imported grant is not offered the public-listing
control, because publishing checks a record that lives on the application —
the server refuses it, so the screen does not offer it.

Check it: `npm run e2e:award`, which writes `/tmp/award-light.png` and
`/tmp/award-dark.png`.

### The organization page

Every nonprofit now has a page at `/organizations/<id>`: their grants, their
applications, the people recorded against them, and — at the top, as a banner
— whether anybody there can sign in. Reach it from "All their grants" on any
grant page.

**Can anybody sign in** is the operational question this month. Reminders only
reach grantees who already have an account, so a nonprofit that has never
claimed their grant is invisible to every automated nudge in the system. The
failure is silent: the report goes overdue, the nightly job finds nobody to
email, and the compliance desk shows a red row nobody caused. The page says so
in words, as something a person has to do.

This could not reuse the existing history endpoint. `organizationHistoryForStaff`
gates on the organization having at least one application — right for its job,
and fatal here, because imported grants have none. All thirteen 2025 grantees
answer 404 from it today, **to an admin**. A test pins that, so if the gap is
ever closed elsewhere we find out.

Check it: `npm run e2e:organization`, which writes `/tmp/organization-light.png`
and `/tmp/organization-dark.png`.

**Known gap:** there is no organization *list* or search yet, so the page is
reached from a grant or by typing the address. The list belongs with the
Organizations tab.

### The Grants and Organizations lists

Two new screens, at `/awards` and `/organizations`, and two new tabs.

**Grants** is the first answer this system has ever had to "show me the
grants" — awards were reachable only through the application that produced
them, or one at a time by id. Each row carries its reporting state and whether
the grantee can sign in, because the question is never just what was funded.

**Organizations** exists mostly for one button: *Which grantees can we not
reach?* Funded nonprofits where nobody has an account. No reminder from
Steward reaches them whatever goes overdue, and until now that could only be
asked one nonprofit at a time — useless for finding the ones nobody has
thought about.

Filter state is in the address on both, so a filtered list is a link somebody
can send. Check them: `npm run e2e:lists`.

**The navigation now wraps to two lines at 1280px**, with eleven items. That
is the rename-and-move phase, which is next: To do · Grants · Organizations ·
Applications · Results · Impact · Programs, with Reporting folded into Grants.

### The Impact screen

A new tab at `/impact`: what grantees have reported back, per programme, with
a grant-year picker.

**Every figure is shown with its denominator, and that is the point of the
screen.** "4,200 people served" is a fact if every grantee has filed and a
floor if three of thirteen have, and the number reads identically either way —
on its way into a board paper or a press line where nobody can see behind it.
So a coverage sentence sits *above* the figures (a note underneath is a
footnote, and footnotes do not travel with a copied number): *"Based on 3 of 13
updates accepted, covering $120,000 of grants."*

Three absences are deliberately different, because conflating them would
misrepresent the grantees:

- A metric nobody has answered reads **"Not reported yet"**, never `0`.
- A grantee who genuinely reached nobody reads **`0`** — their answer is not erased.
- A written answer shows **who answered** and no figure at all. A summed sentence is a fabrication.

A programme where nothing has been asked says exactly that, rather than
presenting "0 of 0 updates" as a complete year. That is the state all thirteen
2025 grants are in today.

Only accepted reports count. A figure no member of staff has read must not be
in a published total, and one sent back for revision comes straight out again.

No charts. A bar chart of a number whose denominator is three would be a more
confident lie than the number alone.

Check it: `npm run e2e:impact`, which writes `/tmp/impact-light.png` and
`/tmp/impact-dark.png`.

### The navigation

Six items in the bar, the rest behind **More**:

| In the bar | Behind More |
|---|---|
| To do · Grants · Organizations · Applications · Impact · Results | My reviews · Data health · Retention · Programs |

Renamed: Pipeline → **Applications**, Dashboard → **Results**, Configuration →
**Programs**. A pipeline is a word about the system; nobody goes looking for a
dashboard; and "configuration" is why nobody could guess what was in it.

**Two sections have a second view rather than a second tab.** The compliance
desk sits under Grants and the past-grantee claims queue under Organizations —
each is the same subject as its section at a different grain, and being on
either still highlights the section it belongs to. That is two fewer things to
scan.

**The split is by role**, because "rarely used" is a fact about a person. My
reviews is an admin's occasional errand and a reviewer's whole job, so it is
in the bar for a reviewer. And a menu that would hold one item doesn't appear
at all — the item goes in the bar instead.

Check it: `npm run e2e:nav`, which measures that the bar is one line at
1280px, that Escape *and* a background click close the menu, and that opening
something from the menu still tells you where you are.

### The compliance desk, banded

Reports was thirteen rows reading *Final report / December 3 / Scheduled* with
the two or three that needed something scattered among them. The header said
"3 overdue" and then hid those three in the pile.

Four bands, by **who is holding each report up**, which is the only question
that changes what you do next: *Waiting on us* (filed, unread) · *Late* ·
*Still to come* · *Settled*. A fifth catches any status the rules do not claim
and says so, because a screen promising "every obligation" must not be able to
drop a nonprofit's report between bands when a seventh status is added.

The largest band says in words why it is largest: **"The scheduled ones have
not been asked for."** All thirteen sit there, and that sentence is the only
outstanding work this month.

Three things that were wrong and had one cause each:

- **The filter captions were 16px body text** — larger than the column
  headings and every value in the table. `internal.css` styles `.filter
  label`, and this screen alone wrote `<label class="filter">` with a bare
  span, matching no rule at all. Twelve of sixteen filter controls looked one
  way and these four looked another.
- **Clicking a row appeared to do nothing.** The detail panel renders after
  the table, so at thirteen rows it opened about 500px below the bottom of an
  800px window and the page did not move. It scrolls and takes focus now, and
  closing returns focus to the row.
- **The loudest badge marked the row that needed nothing.** ACCEPTED was a
  solid fill while FILED, AWAITING US — the only row where the Foundation is
  the hold-up — was a quiet outline.

Check it: `npm run e2e:reports`, which counts the distinct type treatments on
the screen and fails if the number grows, because "so many fonts and font
sizes" is only a number a machine can hold on to.

### What a grant was for

The system could say the Foundation gave an organization $50,000 in 2025.
**Nothing in it could say what for.**

That is not a gap in a search box. `0005_search.sql` declares an index with
`counties`, `focus_area` and `narrative`, and its header opens by quoting *"have
we ever funded youth mental health in Fort Bend County"*. It indexes
**applications**. `awards.application_id` is NULL for everything imported, and
the award importer accepts identity and dates — ein, amount, term_start,
status, notes — and nothing describing the work. None of the thirteen has a row
in that index and none ever will.

So `0028` gives an award its own `project_title`, `purpose`, `focus_area` and
`counties_served_json`, editable on the grant page, audit-logged, under the
same optimistic lock as an amendment. It is **not** an amendment: that trail
answers "what changed about this grant's terms" and filling in a blank
description is not that. The Grants list shows the focus area under the
organization, so the blanks are visible across the portfolio rather than one
grant at a time.

**All thirteen are blank today.** Thirteen grants is a screen's work and there
is no bulk route; an importer column is the answer if a year ever arrives with
ninety.

### The Texas place vocabulary

254 counties from the US Census county FIPS file, and 1,471 cities mapped to
the counties their ZIPs fall in. Generated by `scripts/buildTexasPlaces.py`,
which documents provenance and refuses to emit a county it cannot reconcile
against the Census list.

The ZIP source spells two of them wrong — *De Witt* for DeWitt, *Mclennan* for
McLennan — which is the argument for a vocabulary in one line. Katy resolves to
Harris, Fort Bend **and** Waller, which is the real answer.

The grant page offers the 254 through a native datalist and adds them as
chips, canonicalised in the browser as well as on the server so the chip
somebody sees is the string that gets stored. **"Ft Bend" is marked, not
refused** — the platform runs programs that fund anywhere, so an unrecognised
place is never an error, but it carries *not a Texas county* in amber, which
is how a person notices they abbreviated.

It also caught a false claim: `0028`'s header says
`awards.counties_served_json` is "the same shape as
`applications.counties_served_json`". It is not — an application promotes the
multi-select's option VALUES, so Inspire Change stores `["harris","fort_bend"]`
while an award stores the names a person reads. `src/lib/counties.ts` carries
the correction and the one function that reconciles them. An applied migration
is never edited, so the file still says the wrong thing.

And the eighteen Greater Houston counties typed by hand into the Inspire
Change seed are now checked against the Census list. Nothing had ever verified
them. They are all correct.

### The audit pass

After the first production deploy, the new screens were audited for UX and for
correctness. Both passes found real defects; the worst were mine, and several
had been live.

**Things that said more than they knew.** "Can sign in" was true whenever a
`users` row existed — but the awards importer creates one for every imported
grant, so all thirteen 2025 grantees read Yes and the filter built on it
matched nothing. It now reports **when anybody last signed in**, which is
written only when a magic link is actually redeemed. Impact's coverage line
said "covering $469,000 of grants" using the *total*, on the one screen built
to carry denominators. The To do screen told a reviewer "no unanswered claims,
no reports, nothing overdue, no files near destruction" about three queues it
never queried and that they are not allowed to see.

**Things that disagreed with each other.** Overdue was re-implemented in SQL as
`due_date < <full ISO instant>`, which calls a report due *today* overdue —
while the compliance desk, running `reportDue.ts`, called the same report fine.
Refused awards kept their report periods and were counted as live obligations,
so a grant nobody took sat red forever. "Total awarded" included cancelled
awards, so the organization page and the dashboard reported different totals
for the same nonprofit. A waived report read as missing.

**Things only rendering shows.** Filter labels ran into their dropdowns because
the screens didn't use the house `.filter` wrapper. A failed load rendered
beside the empty state, so a 500 could read "Nothing to chase." Dates were ISO
on the new screens and "December 3, 2026" everywhere else. `badge-cancelled`,
`badge-completed` and `badge-pending` were never defined, so a rescinded grant
looked like one awaiting acceptance. The status filter offered "closed", which
is not a status this system has, and omitted "completed", which is what every
imported grant is.

**And the tests that would not have caught any of it.** The anti-row-
multiplication test created zero applications; the overdue test used a date two
years past, so it pinned the sign and not the boundary; the horizon test was
written in terms of the constant it was testing. Each is now pinned, and every
fix above was mutation-tested by reintroducing the bug.

### Bugs found and fixed during this work

Recorded because all four were invisible to a green test suite, and three were
found by reading real output rather than by testing:

- **Closing a cycle had never worked.** The client built `/closed`; the route
  is `/close`. Opening matched by coincidence. Now guarded by a test that
  checks every client URL against the server's route table.
- **The import preview counted thirteen organizations as one**, on the line
  directly above the Import button.
- **Five environment variables were missing from production** — including the
  R2 pair, whose absence breaks every upload and download. Now a build
  failure if any var is added to the default and not to production.
- **`docs/SECRETS.md` claimed preview could not email real people.** It can,
  and has since deliverability testing.
- **`/reporting?report=<id>` was a link that silently did nothing.** The open
  report was local state only, so the To Do screen and the award page both
  sent people to the compliance desk with no sign of which row they had been
  sent to. On thirteen rows that is an annoyance; on three hundred it is a
  dead link. The open report is in the address now, which also makes one
  report forwardable.
- **The More menu opened off the right edge at phone width**, with half its
  entries unreachable. Anchored to the button, a toggle near the right edge
  opens a 180px panel past it. At phone width it now spans the masthead.
- **A metric could vanish from Impact entirely.** The query filtered rows
  where the value did not count, so a programme whose one filed report had
  been sent back for revision lost the whole metric from the screen rather
  than reading "nobody has answered yet" — and a year with no accepted reports
  looked like a year with no metrics. The condition now lives inside `COUNT`
  and `SUM`; the definition is always present and only its numbers depend on
  what has been accepted.
- **The unreachable-grantees toggle looked identical on and off.** The rule
  styled the pressed state blue; `.btn` is already blue-filled, so it changed
  nothing. The one control on that screen that exists to be switched gave no
  sign of whether it was on. Only visible rendered.
- **`/grants` was nearly used for the staff list.** It is the *public* page
  listing who was funded, served on both hostnames. Caught by the
  route-shadowing test; the staff list is at `/awards`.
- **`.rowlink` had no styling but a cursor**, so every clickable cell in a
  table rendered with the browser's default button chrome. On the already-live
  compliance desk that meant "Bayou Harbor Trust" and "$35,000" as two grey
  boxes in one row. `.linklike` had existed for exactly this since the start.
  Fixed in one rule; three screens improved.
- **A new route would have made the award picker unreachable.** `GET
  /api/awards/:id` was declared above `GET /api/awards/search`, and the router
  takes the first path that matches with no preference for a literal segment
  over a parameter. The award page would have received the string "search" as
  an id, answered 404, and left the Connect button on the claims queue
  permanently greyed out with no reason shown — the only route by which any of
  the thirteen reaches their report. `test/routeShadowing.test.ts` now walks
  the whole table and fails on any route another route hides.
- **The To Do screen hung on "Loading…" forever on its first write**, because
  `App.tsx` keeps a list of the staff routes that need the shell's data and the
  new one was not on it. Fifteen green unit tests behind a landing page that
  never rendered; the browser harness caught it on its first run. The comment
  in that file predicts this exact mistake, and it is now the third time.

---

### Bugs found by sweeping for the class, not the instance

Adam asked, on 2026-10-07, why a bug found is not treated as evidence about
how this codebase goes wrong, and swept for siblings. It is now rule 4a in
`CLAUDE.md`. The first sweeps found three more bugs and two tests that passed
for the wrong reason:

- **`var(--rule)` is defined nowhere**, so `.danger-row`'s top border has never
  rendered — CSS drops the whole declaration when a var() in it resolves to
  nothing. Swept: **`var(--accent)` is undefined too**, in `.storage-usage` and
  `.request-updates`, both `border-left: 3px solid var(--accent)`. Neither has
  ever had the accent bar that is the point of the treatment, and one of them
  is the panel that writes report obligations against other organizations'
  grants, whose own comment says it "should not look like the rest of the
  page's furniture". Guarded by `npm run check:css`, now part of `verify`.
- **A comment claiming two modules agree** (`0028` on counties). Swept:
  `metricColumnFor` says it "mirrors the trigger in 0013 and the scaffolder's
  FIELD_TYPE_BY_METRIC_TYPE" and nothing checked it — the existing test
  asserts that constant equals a literal copy of itself, so changing the
  trigger leaves it green and the first symptom would be a grantee's report
  refused by the database mid-submit. `test/metricTypeAgreement.test.ts` drives
  all three for real.
- Two sweeps came back clean and are recorded as such: `??` not catching an
  empty string has three sibling call sites, all safe because `isBlank`
  normalises `''` to an all-NULL row at coercion; and unscoped harness
  selectors are self-detecting, because Playwright throws on a multiple match.

A fourth sweep, on 2026-10-08, came out of the live email check:

- **A due date in a letter is a day, not an instant.** The reminder for a
  report due `2026-10-22` was sent, arrived, and said **October 21, 2026** —
  because `new Date('2026-10-22')` parses as UTC midnight and rendering it in
  `America/Chicago` lands the evening before. Named the class as *a calendar
  day formatted in a time zone*, and swept every date-formatting call site
  in the Worker: four, of which **two were wrong**. The second was the embargo
  date in an award letter, which tells a grantee when they may announce their
  grant. Fixed with `formatCalendarDay`, which formats in UTC because a
  calendar day has no time zone. Guarded by `npm run check:dates`, which
  enumerates the call sites and fails on one that is not classified `calendar`
  or `instant` with a reason.

  This is the second bug in that corner, which is why the guard enumerates
  rather than spot-checks. **And the sweep was too narrow** — see below.

- **The same class is live in the admin screens, and the guard does not look
  there.** `check:dates` walks `src/` — the Worker — and stops. `web/src/`
  has a correct pair of helpers in `reportWording.ts` (`formatDay` formats in
  UTC, `formatMoment` in Central, and its comment records this same bug being
  found in the grantee portal earlier), and fourteen files, some of which
  bypass them with a bare `new Date(x).toLocaleDateString('en-US')` and no
  time zone at all — which renders in whatever zone the staff member's browser
  is in. Two confirmed wrong, both on money and paperwork screens:

  - `PaymentLedger.tsx` renders `scheduledDate` and `paidDate`, which are
    stored as `YYYY-MM-DD`. A payment due `2026-11-01` shows on the ledger as
    **10/31/2026**.
  - `AwardAmendments.tsx` renders the before and after of an amended
    `term_start`, `term_end` or `announcement_date`. Those are stored by
    `parseImportDate` as UTC midnight, so an award term starting
    `2026-01-01` reads **12/31/2025** — the wrong year, in the audit trail of
    a change to a grant.

  The rest of the fourteen are mostly real instants (`decidedAt`,
  `declaredAt`, `purged_at`), which the bare call renders acceptably. Each
  still has to be classified rather than assumed. **Not yet fixed**: it
  touches a dozen components, so it is a phase, not a patch — and the guard
  has to be extended to `web/` in the same change, or the next one lands the
  same way.

- **A settled item re-opened in the document that settles it.** Claude put
  *"add Resend to SPF"* into *Blocking right now* on 2026-10-08. Two hundred
  lines below, under *"Finished and verified, so neither of us re-opens it"*,
  this same file already said SPF and DKIM both pass and are aligned, and
  `docs/BLOCKED-ON-YOU.md` recorded the DNS as done and verified on 20
  September. The claim came from reading the root domain's SPF record and
  reasoning from it, instead of reading either file or the message headers.

  Named the class: **a mechanism asserted from memory when the repository
  already records the answer.** It has now happened five times in two days —
  `--file --remote`, the missing `.dev.vars`, the navigation labels, the
  `--json` rule, and this. Every one of them was written down somewhere in
  this repository before it was asserted wrongly.

  Guarded by `npm run check:status`, which fails when *Blocking right now*
  mentions a topic that *What is already done* has marked settled. Re-opening
  a settled item now means moving it out of that section first, which is a
  deliberate act rather than a lapse.

- **A retracted claim outlives its retraction.** The `--json` rule was
  disproved on 2026-10-08 and corrected in four places. Swept the repository
  for the claim afterwards and found it still asserted in two more:
  `scripts/apply-sql.mjs` and `scripts/sql/remove-test-data.sql`, both of
  which still tell a reader that `--json` is what makes a remote execute work,
  plus the same reasoning carried into `scripts/sql/apply-0029.sql` and
  `scripts/buildMigrationApply.mjs`. The commands in them still run; the
  explanation in them is false. **Not yet corrected** — recorded here so the
  next reader does not act on it.

**And two tests written that day passed for the wrong reason.** A CSS check
written as a vitest test imported the stylesheets with `?raw` — which resolves
to an **empty string** under `vitest-pool-workers`, so all three assertions
passed against nothing. And a trigger test used an *application* form, so the
insert was refused by a different trigger entirely. Both caught before they
shipped, only by asking why they passed. That is also now in `CLAUDE.md`.

### A migration applied without its ledger row

`0028` was applied to production with `wrangler d1 execute --file=`, on
instructions from Claude, rather than `wrangler d1 migrations apply`. The DDL
ran; `d1_migrations` was never written. `npm run golive` caught it —
`27 applied, 28 on disk` — which is the check doing exactly its job.

`npm run migrate:production` now exists, because the absence of a script is
why the wrong command got improvised in the first place.

## Not in scope for this launch

The 2026 application cycle. That opens a public form taking financial
documents from hundreds of strangers, and it does not go without the human
security review. The pilot can go without it because every grantee claim is
approved by a person before any award data is released, and thirteen known
organizations is a small, observable surface. That is a judgment, not a fact,
and it is yours to overrule.
