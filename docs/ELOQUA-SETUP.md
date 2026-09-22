# What to build in Eloqua

Eloqua has exactly two jobs in this system, and CLAUDE.md is deliberate about
both of them:

1. **The marketing opt-in.** One checkbox on the application form. It is the
   only field that ever leaves Steward for Eloqua.
2. **Scheduled bulk reminders** — "your grant report is due" — where batch
   latency does not matter.

**Eloqua must never send a magic link.** Batch latency, a marketing domain's
sending reputation, an unsubscribe footer on a login email, and contact-record
pollution. Sign-in links go through Resend, on the transactional domain, always.

Nothing else syncs. Not applications, not awards, not report contents, not
EINs, not financial statements.

---

## Why forms rather than the REST API

Two ways Steward could push to Eloqua: the Application REST API with OAuth, or
a **form POST** to an Eloqua form endpoint.

**Recommended: forms.** No OAuth handshake, no token refresh inside a Worker,
no `ELOQUA_CLIENT_SECRET` to hold. The endpoint is a plain HTTPS POST of
form-encoded fields. Processing steps on the Eloqua side do the rest, and the
marketing team can change what happens to a submission without a code change —
which is the correct division of labour.

The cost is that a form POST tells you very little about what happened to it:
a 200 means Eloqua accepted the payload, not that the contact was updated the
way you intended. Steward records what it sent either way, so a mismatch is
diagnosable from our side.

Say the word if your Eloqua admin would rather use the REST API and I will
build that instead; it is more code and two more secrets.

---

## Form A — marketing opt-in

**Fires:** on application submit, and only when the applicant ticked the box.
Nothing is sent for an applicant who left it unticked.

**Fields to create on the form:**

| Field | Contents | Notes |
|---|---|---|
| `emailAddress` | The contact email from the application | The only required one |
| `firstName` | Contact first name | |
| `lastName` | Contact last name | |
| `company` | Organization legal name | |
| `optInSource` | e.g. `Inspire Change 2026 application` | Which program and cycle produced it |
| `optInDate` | ISO date of the submission | |

**Processing steps, in order:**

1. **Update Contacts — With Form Data.** Maps the fields above onto the contact
   record, creating it if it does not exist.
2. **Subscribe Contacts to Email Group** → a group named something like
   *Texans Community Initiatives*.

Use an **Email Group**, not just a custom Yes/No field. The group is the object
that carries subscribe and unsubscribe semantics, and an opt-in that is only a
checkbox on a record is an opt-in with no way to honour an unsubscribe.

---

## Form B — report reminder queue

**Fires:** on a schedule from Steward, for every grantee with a report coming
due or overdue. This is the mechanism that makes a nonprofit come back and
report; without it the portal is a page nobody is told about.

**Fields to create:**

| Field | Contents |
|---|---|
| `emailAddress` | The grantee contact |
| `firstName` | Contact first name |
| `company` | Organization legal name |
| `programName` | e.g. `Inspire Change` |
| `reportLabel` | e.g. `Final report` |
| `reportDueDate` | The due date, in Central |
| `reportStatus` | `due_soon` or `overdue` |
| `portalUrl` | The reporting page — a plain URL, never a token |

**Custom contact fields** are needed to hold the last four, so an email can
merge them into its body.

**Processing steps:**

1. **Update Contacts — With Form Data.**
2. **Add Contacts to Shared List** → *Grant reports outstanding*.

**Then a Campaign or Program Canvas** on that shared list, sending the reminder
email. The email links to the reporting page and asks them to sign in there. It
carries no sign-in token: the page itself sends one, from Resend, when they ask.

Removing people who have filed is the other half. Simplest reliable approach:
Steward re-sends the whole current queue on each run and the shared list is
cleared before each campaign send. Your Eloqua admin may prefer a different
pattern — a segment with a `reportStatus` filter, for instance — and that is
their call.

---

## What I need back from you

Steward cannot post to a form that does not exist yet, and I cannot guess these.

| | What |
|---|---|
| 1 | **Eloqua site ID** — the numeric id in your instance's URLs |
| 2 | **The POST endpoint** — take it from Eloqua's own *View Form HTML* for each form, not from a guess. The host is pod-specific. |
| 3 | **`elqFormName`** for each of the two forms |
| 4 | **The exact HTML field names** Eloqua generated. They are often not what you typed — take them from the generated HTML. |
| 5 | **The email group name** for the opt-in |
| 6 | **The shared list name** for the reminder queue |

Then two Wrangler secrets get set and the sync is code I can write against a
real endpoint rather than a guessed one.

---

## Form B is now running through Resend in the meantime

**Not a replacement, and not a relitigation of the decision.** Eloqua is still
the right home for a scheduled bulk nudge and this document still describes
what to build. What changed is that the six things above need a marketing admin
who has not been asked yet, and in the meantime the reporting portal was a page
nobody was ever sent to -- so a report nobody asked for is a report nobody
files, and the compliance policy then blocks that organization's next
application over a silence the Foundation caused.

So the reminder runs on the nightly cron through Resend, on the transactional
domain that already carries the sign-in link. The volume settles it: 100 to 300
grantees a cycle on a ladder of a few sends each is far inside the free tier.
It carries no sign-in token, for the reason this document already gives.

**When Eloqua is ready**, the swap is one job in the cron handler and the
ladder logic moves to a segment. Nothing else changes, and `report_periods`
already records what was chased and when, so the two cannot both nag the same
grantee without it being visible.

## What is true today

Nothing above is built. The opt-in **is captured and stored** on
`contacts.marketing_opt_in` for every application submitted, so no consent is
being lost while this is outstanding — it is waiting to be pushed, not missing.
There is no Eloqua client in the codebase and no credentials are set.

The reminder queue also depends on report periods existing, which they now do.
