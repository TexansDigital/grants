# Collecting the 2025 progress reports

One procedure, start to finish, for asking the thirteen organizations that
received Inspire Change grants in 2025 for an update on what the money did.

Written for whoever is doing this, not for whoever built it. Every step names
the screen, the URL, the button and **what you should see**. Where a step can
go wrong in a way that reaches a nonprofit, it says so before the step, not
after.

> **If you are new here, this is the right document.** `docs/STATUS.md` is the
> state of the system; `docs/BLOCKED-ON-YOU.md` is the list of decisions.
> This is the job.

**Nav note.** Labels moved on 2026-10-07. *Programs* is behind the **More ▾**
menu at `/configuration`. The compliance desk is **Grants → Reports**, at
`/reporting`. URLs are given throughout because a label can be renamed and a
URL in a document survives it.

---

## Before you start: four things that are true and surprising

1. **The thirteen already have logins.** The awards import created an active
   grantee account from each row's contact email. They did **not** come through
   `/tell-us`, and they are mailable the moment a report obligation exists.
2. **The nightly cron is switched off, and that is deliberate.** It mails only
   when `REMINDERS_AUTOMATIC` is exactly `"on"` in `wrangler.toml`. It is set
   nowhere. Nothing goes out unless a person presses a button. If you later
   turn it on, it will mail at 14 days, 3 days and 0 days before a due date,
   then weekly for ever, at about 2am Central.
3. **Those thirteen addresses came off a spreadsheet and have never been
   confirmed.** The first letter is how you find out which ones are dead. Watch
   it go out; do not schedule it and leave.
4. **The five questions are not final until you say so.** See step 1.

---

## Step 1 — Settle the five questions. Do this first.

The report form asks five impact questions. **They are a placeholder set that
nobody at the Foundation chose** (`docs/BLOCKED-ON-YOU.md` §3.12 and §2.1a).

They are currently:

| | Question | Type |
|---|---|---|
| 1 | How many individuals did this grant directly serve? | whole number |
| 2 | What were you counting? | **free text** |
| 3 | How much of the grant has been spent? | money |
| 4 | Volunteer hours contributed | decimal, optional |
| 5 | Which counties did this work reach? | text, optional |

**Why the order matters.** A published form cannot be edited, and the metric
key is the identity of the data series — change a key after answers exist and
the series splits in two with no warning. Right now **no real grantee has
answered**, so this is free. After the first report lands it is permanent.

Question 2 is the one to fix even if you keep the rest: as free text, the
Impact screen adds up organizations counting meals, visits and households as
though they were the same number.

**Decide, then tell Claude to rebuild and publish the form.** It is a CSV and
a command, not a migration.

---

## Step 2 — Check what is actually in production

```
npm run golive
```

Expect `29 applied, 29 on disk`, two or more active admins, and four OPEN
items (security review, delivery to a real grantee, a recent upload check, a
screen reader). Those four are not automatable and are not blockers for this
job.

Then confirm the numbers:

```
npx wrangler d1 execute steward-production --remote --env production --yes \
  --json --command="SELECT (SELECT COUNT(*) FROM awards WHERE deleted_at IS NULL) awards, (SELECT COUNT(*) FROM report_periods WHERE deleted_at IS NULL) periods"
```

**You want `awards: 13` and `periods: 0`.**

If awards reads 14, test data is present — run
`scripts/sql/remove-test-data.sql` (see `docs/BLOCKED-ON-YOU.md` §0.1) and look
again. If periods is not 0, somebody has already asked; stop and find out who.

A 7403 error here is intermittent. Run it again before concluding anything.

---

## Step 3 — Pick the due date

**This is a decision, not a step.** The due date is also the send schedule if
the cron is ever switched on, and it is what the letter tells thirteen
organizations.

Give people a reasonable window. Six to eight weeks is normal for a progress
report. Avoid a date inside two weeks.

---

## Step 4 — Dry run. **The number must be 13.**

Go to **More ▾ → Programs** (`/configuration`) → **Ask past grantees for an
update**.

Set the window to `2025-01-01` – `2025-12-31`, enter the due date from step 3,
and run the **dry run**.

**It must say 13 grants.** Not 12, not 14.

- **14** means test data is still present. Go back to step 2.
- **12 or fewer** means an award already has a report period, and the ask skips
  those. Find out which and why before continuing.

Do not press confirm until the number is 13.

> **Do not press "Create missing report obligations"** on the Reports screen.
> It sits near this and sounds like the same thing. It is not: it has no dry
> run, it writes immediately, and it generates periods dated from the award
> term — which for 2025 grants is already in the past. The ask in this step
> then skips all thirteen as "already asked", and there is no way to undo it in
> the app.

---

## Step 5 — Confirm the ask

Press confirm. This creates thirteen report obligations. **It does not send
anything.**

Check the compliance desk at **Grants → Reports** (`/reporting`). Thirteen
rows, status `open`, your due date.

---

## Step 6 — Read the letter before anyone gets it

On `/reporting`, press **Preview the letters**.

This is the safety rail, and it is the best thing on the screen. It shows:

- every organization that would be written to,
- **every email address**, spelled out,
- **the letter itself** — press *Read the letter* on any organization to see
  the exact subject and body that address would receive,
- how many letters would leave the building,
- whether a mail provider is even configured.

**Read the addresses, and read one letter.** This is the only moment before
thirteen nonprofits are contacted where a mistake is cheap to fix.

### Adding a note

Above the button is **A note from the Foundation**, optional, one paragraph.
Whatever you write there appears in every letter in this send, between the list
of reports and the sign-in instructions. For example: *"We know several of you
are mid-season. If the date is a problem, reply and we will move it."*

Three things about it:

- **It is not saved.** Write it again next time, on purpose. A note written for
  one round that quietly went out with the next would be worse than no note.
- **It cannot reach the dates.** The report name, the programme, the due date
  and the sign-in wording are generated. A letter has already gone out of this
  system with a hand-computed date that was wrong by a day, which is why.
- **Edit it and the Send button greys out** until you press Preview again. The
  letters on screen were rendered with the old note, and the server refuses a
  send whose note does not match what was previewed.

---

## Step 7 — Send

Press **"Send N now."**

It carries the number you were shown, the note you previewed, and a
fingerprint of both plus every recipient address. If anything moved between
reading the plan and pressing the button — a letter more, a different address,
an edited note — **the run refuses and sends nothing.** That is intended: what
you read is what leaves, or nothing does.

Afterwards the panel reports sent, suppressed, refused by the provider, and how
many had already been written to today.

- **refused by the provider** is a real failure. Those grantees were not
  reached. Data health lists them.
- **suppressed** means no mail provider is configured. In production that means
  the Resend key is missing — nothing was sent at all.

**Sent is not delivered.** Nothing in this system knows whether a letter
arrived; there is no bounce handling yet. Assume one or two of thirteen
addresses are dead and follow up by phone.

---

## Step 8 — Chase

With the cron off, chasing is manual: come back to `/reporting` and repeat
steps 6 and 7 when you want another round. The panel will tell you who has
already been written to today, and no one is mailed twice in a day regardless.

Rows go red when a report is past its due date.

---

## Step 9 — Receive and accept

A grantee signs in at `apply.houstontexansfoundation.org/reports`, enters their
email, gets a sign-in link, and files. You will see the row move to
`submitted`.

Open the submission from `/reporting`. You can:

- **Accept** it — the obligation is closed. Accepted is terminal; it cannot be
  moved back.
- **Send it back with notes** — the row becomes `revisions_requested` and the
  ball returns to the grantee.

A report sitting in `submitted` is waiting on **you**, and is not counted
against the grantee anywhere.

---

## If something goes wrong

See `docs/IF-SOMETHING-IS-WRONG.md`.

---

## What this procedure does not cover

- **Whether a letter was delivered.** No bounce or complaint handling exists.
- **Checking reported spend against the award.** Nothing compares the figure a
  grantee types to what was granted or paid.
- **Exporting any of this for a board.** There is one aggregate CSV at
  `/api/dashboard.csv` and no grant-level export. That is Phase 6.
