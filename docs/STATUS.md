# Status

**Last verified: 2026-10-04.** Every line below says how to check it, because a
status file that nobody can re-verify becomes fiction within a week. This
project has already been bitten three times by a document that was true when
written and false when read.

Where it says **you**, that is the Foundation. Where it says **Claude**, that
is the assistant. Where it says **unknown**, neither of us has checked.

---

## What we are trying to do

Collect progress updates from the thirteen organizations that received Inspire
Change grants in 2025, through a portal those organizations log into with a
magic link.

This is **not** the 2026 application cycle. That is a separate, later launch
with a higher bar (see *Not in scope* at the bottom).

---

## The thirteen conditions

Production is "live" when all thirteen are true. Today: **0 of 13.**

### Infrastructure — production serving

| # | Condition | State | How to check |
|---|---|---|---|
| 1 | `steward-production` migrated clean from empty | **done 2026-10-04** | 27 migrations, schema identical to preview: 41 tables, 95 indexes, 102 triggers in both |
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
| 9 | Thirteen imported, with an audit row each | not done | *Checking the databases* |
| 10 | Update request dry-run matched 13, then run | not done | Configuration → Ask past grantees for an update |
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

Nothing. The next move is yours.

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

`--json` is required. A bare `wrangler d1 execute --remote` fails with 7403.

Before the import, `apps`, `awards` and `orgs` must all read **0**. If they do
not, something was copied that should not have been.

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

## Not in scope for this launch

The 2026 application cycle. That opens a public form taking financial
documents from hundreds of strangers, and it does not go without the human
security review. The pilot can go without it because every grantee claim is
approved by a person before any award data is released, and thirteen known
organizations is a small, observable surface. That is a judgment, not a fact,
and it is yours to overrule.
