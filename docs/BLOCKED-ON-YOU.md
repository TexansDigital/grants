# What Steward needs from the Foundation

One list, kept current. Everything here blocks work that is otherwise ready to
start, or blocks the platform going live. Nothing here is something I can do
myself, decide on your behalf, or work around.

Last updated: 9 October 2026.

---

## 0. Do these, in this order — 9 October 2026

**Do not set a due date for the 2025 update until §3.10 is decided.** That was
the top of this list yesterday and it is now the one thing to hold. See §3.10.

| # | Action | Who | Blocking? |
|---|---|---|---|
| 1 | Decide **§3.10 — does the nightly cron mail grantees by itself?** | You | **Yes.** Everything waits on it. The switch now exists (`REMINDERS_AUTOMATIC`); it is **off**, and off is the default. |
| 2 | Confirm or replace **§3.12 — the five report questions** | You, in writing | **Yes.** Free to change today, permanent after the first real answer. |
| ~~3~~ | ~~Clear the test rows~~ | **DONE 9 October.** Verified independently: 13 awards, $469,000.00, 13 organizations, **0 live report periods**, 13 mailable grantee logins and **0 test logins**. The 19 October auto-send is gone with the period. |
| 4 | **Pull, then deploy**: `git pull` then `npm run deploy:production` | You, two commands | Yes — the 9 October deploy predates the cron switch |
| 5 | ~~Decide §3.5 — second admin~~ **DONE.** Allie and Amanda. **Ask Amanda to sign in once** — her account has never been used | You, one message | Before you rely on it |
| 6 | Add `np=reject` to DMARC | You, one DNS edit | No, but cheap |
| 7 | Re-paste `CLAUDE.md` into the Claude Project prompt | You | No |
| 8 | `houstontexans.com` message trace | Your mail admins | No — does not affect the thirteen |

Production right now, read from it rather than remembered: **13 awards,
$469,000.00, 13 organizations, 0 live report periods, 29 migrations, and 13
mailable grantee logins on 13 distinct domains.** No test data remains.

### 0.1 The test rows — cleared 9 October 2026

Done. Recorded because the dated hazard it carried is the evidence for §3.10.

`TEST-2026-001` had an **open** period due 2026-10-22, and the ladder is 14, 3
and 0 days before, then weekly for ever (`src/lib/reportReminders.ts:56-59`).
The 14-day rung fired on 8 October. Left alone, the nightly cron would have
mailed the three test logins again on **19 October**, **22 October** and weekly
after, with nobody pressing anything. They were mailboxes the Foundation
controls, so it cost nothing — and it is the proof that §3.10 describes a live
behaviour rather than a theoretical one.

**One thing the removal proved on its way out.** Today's test award reused the
reference `TEST-2026-001` on a new award id. The cleanup script keys its audit
row on the **award id**, not the reference, precisely so a reused reference
still gets its own row. Under the obvious keying it would have collided with
8 October's row, been skipped by the `NOT EXISTS` guard, and the award would
have been soft-deleted **with no audit row at all** — a financial record
removed with no trace, against non-negotiable 6. Three rows exist, one per
award. The comment that explains the choice is in
`scripts/sql/remove-test-data.sql`.

To re-run it after any future test:

```
npx wrangler d1 execute steward-production --remote --env production --yes \
  --json --command="$(cat scripts/sql/remove-test-data.sql)"
```

---

## One command that answers "is it ready"

```
npm run golive
```

Read-only: GETs and SELECTs, nothing written, no flag that writes. It goes and
checks the things that are either true right now or not, rather than asking you
to take anybody's word for them — including mine. Among them: that the
applicant hostname is **not** behind Cloudflare Access (the fault found on 20
September, which would have put every nonprofit into a pool of fifty free
seats), that the CSP admits uploads to R2 (the fault that made every upload
fail silently with no request even made), that every cycle marked open is
actually reachable by an applicant, that two admins exist, that every migration
is applied, and that no test cycle is sitting open where a nonprofit would read
it as a real programme.

It exits non-zero when something blocks. It also prints four items it can never
close — a security review by somebody who did not write this, email genuinely
delivered, an upload proven against the real bucket, and a screen reader driven
by somebody who uses one — because a green run must never be mistaken for
permission to open the form.

The database follows the surface: checking the deployed hostnames reads the
**remote preview** database, because that is the one those hostnames answer
from. `--local` checks a dev worker against your local database instead.
`--local-db` and `--remote-db` override that pairing if you ever want to cross
the two.

Reading remote preview is a SELECT. This script writes nothing, and there is no
flag that makes it write.

---

**The short version, in the order it unblocks things:**

| | What | Blocks |
|---|---|---|
| 0 | A redeploy | The HEIC picker fix. Nothing else is waiting. |
| 0b | **Rebuild the report form** (§2.1b) | The photos-and-video field. One click, and until you make it a grantee cannot send you a picture. |
| 0c | **Your historical awards** (§2.1c) | The whole past-grantee feature. It connects people to awards that already exist; with none imported it does nothing. |
| 0a | ~~Migrations 0022–0025, redeploy, Turnstile~~ | **DONE 21–22 Sep.** Turnstile confirmed rendering in a real browser. |
| 1 | ~~`apply.` DNS record, and Resend's DNS records~~ | **DONE 20 Sep.** Both hostnames live, domain verified, SPF/DKIM/DMARC published. |
| 2 | ~~Resend API key, as a Wrangler secret~~ | **DONE 20 Sep.** A sign-in link was sent, delivered, and used to reach the grantee portal. |
| 3 | ~~R2 key + secret, bucket CORS, the first real upload~~ | **DONE 22 Sep.** A submitted application carries three attachments; one was read back out of the bucket at 218,056 bytes and identifies as a PDF. The upload path has been exercised end to end. |
| 3a | A Google Shared Drive, from IT | Nothing today. Uploads stay on R2 until it exists — see §1.4a |
| 4 | Your impact metrics, as a CSV | What grantee reports ASK. The machinery is finished. |
| 5 | The scoring rubric, as a CSV or XLSX | The entire review and scoring module |
| 6 | Decline letter wording | Decision communication |
| 7 | A security review by somebody who did not write this | Going live. A gate, not a task. |
| 8 | Nine policy decisions (§3) | Various. I have a recommendation for each. |

Eloqua has its own document: `docs/ELOQUA-SETUP.md`.

---

## 1. Blocking the public form going live

### 1.1 DNS records — DONE, 20 September 2026

**Status: done and verified by request, not by assumption.**

| | State |
|---|---|
| `grants.` — staff | Live, behind Cloudflare Access. |
| `apply.` — applicants and grantees | Live, **not** behind Access. Verified by `curl`. |
| SPF | Two records, on different names, and both are correct. The root carries Cloudflare Email Routing's; Resend's is on `rsend.houstontexansfoundation.org`, which is the envelope sender and the one receivers actually check. Confirmed `spf=pass` in a delivered message's headers, 2026-10-08. |
| DKIM | `resend._domainkey`, verified in Resend. Confirmed `dkim=pass` and aligned to the From domain, 2026-10-08. |
| DMARC | `p=none`, reporting to `dmarc@houstontexansfoundation.org`. |
| MX | Cloudflare Email Routing, forwarding only. See `DECISIONS.md` §29. |

Both hostnames are declared in `wrangler.toml` with `custom_domain = true`, so
wrangler creates the DNS records at deploy; there is no record to hand-write.

**The check that must be re-run whenever a hostname is added**, because it
cannot be seen from the repository or from a deploy log:

```
curl -sSI https://apply.houstontexansfoundation.org/ | head -5
curl -sSI https://grants.houstontexansfoundation.org/ | head -5
```

`apply.` must NOT redirect to `<team>.cloudflareaccess.com`; `grants.` must.
This found a live fault on 20 September: the Access application was scoped to
the Worker rather than to a hostname, so it had silently taken the applicant
hostname too, and every nonprofit would have consumed one of 50 free Access
seats. `DECISIONS.md` §28.

### 1.2 Resend — DONE, 20 September 2026

**Status: done, and proven end to end rather than assumed.** The domain is
verified, `RESEND_API_KEY` is set as a Wrangler secret on the `steward` Worker,
and a sign-in link was sent, delivered, opened, and used to reach the grantee
portal. `email_messages` recorded it as `sent` with no error.

Preview and staging still have no key of their own, so a test run cannot mail a
real applicant. Note that the Worker serving both live hostnames is the
preview-bound one, so **that safety property no longer holds for it** — a
deliberate trade, taken with no real applicants in the database yet.

### 1.3 A backups bucket

**Status: named in `wrangler.toml`, not created.** The nightly D1 export is
built and writes to an R2 bucket bound as `BACKUPS` — deliberately a *different*
bucket from the one holding applicant uploads, because one export contains
every organization's data and concentrating that beside the files an applicant
can reach through a presigned URL means one bucket-level mistake exposes both.

**`steward-preview-backups` now exists.** Wrangler provisioned it during
`npm run deploy:preview`, because it is a declared binding — a path that does
NOT need the R2 scope. An earlier version of this document said bucket creation
was dashboard-only; that is true of `wrangler r2 bucket create`, whose failure
under wrangler's OAuth login has no R2 scope to fix, and not of a binding
provisioned at deploy.

**Still needed:** `steward-staging-backups`. Nothing is waiting on it.

Production's name is a placeholder and gets filled in at deploy time.

**And one thing only a human can do.** The export has never been restored. A
backup nobody has restored is a hypothesis — the manifest says so in the file
itself. Before the first real cycle, take one export and load it into an empty
database, then check the row counts against the manifest. That test is the
difference between having backups and believing you do.

### 1.4 R2 storage credentials

**Status: keys and CORS DONE 22 September. One real upload remains.**

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are all set, the
last two as Wrangler secrets that never passed through a conversation, and
`steward-preview-files` carries its CORS rules. What is left is the fact that
**no file has ever been uploaded through this system to a real bucket** — see
1.4b.

The token setup below is kept because production needs its own, and the
reasoning behind each setting is the part worth not re-deriving.

**Do not send me the key or the secret.** Not in chat, not in a screenshot, not
in a file. `wrangler secret put` reads them from your terminal and hands them
to Cloudflare; they never pass through here and there is no version of this
where they need to. A key pasted into a conversation is a key that has to be
rotated, which is a job on top of the job.

**Create the token.** Cloudflare dashboard → R2 → **API** → *Manage API tokens*
→ **Create API token**.

| Setting | Value | Why |
|---|---|---|
| Token name | `steward-preview-presign` | Names the environment, so the production one is obviously different later. |
| Permission | **Object Read & Write** | Presigning needs both: applicants and grantees PUT their uploads, staff GET them back. Admin Read & Write would also let this key create and delete buckets, which nothing in Steward does. |
| Specify bucket | `steward-preview-files` **only** | Not "all buckets". `steward-preview-backups` holds a nightly export of every organization's data; a presigning key that can read it turns one leaked URL into the whole database. |
| TTL | Forever, or a date you will remember | A token that expires silently looks exactly like a broken upload. |
| Client IP filtering | Leave empty | The signing happens in a Worker, whose egress IP is not stable. |

Cloudflare shows the **Access Key ID** and **Secret Access Key** once. Copy them
straight into these two commands, in the repo directory:

```
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Each one prompts, you paste, it goes to Cloudflare. Ignore the S3 endpoint and
the jurisdiction-specific endpoints it also offers — `R2_ACCOUNT_ID` is already
set and the endpoint is built from it.

**Then CORS on the uploads bucket**, from the rules already in the repo:

```
npx wrangler r2 bucket cors set steward-preview-files --file=config/r2-cors.json
```

That file allows `PUT` from `apply.houstontexansfoundation.org` and from
localhost, and nothing else. It does **not** list `GET`, and that is correct
rather than an omission: a download is a top-level navigation to the signed
URL, and navigations are not subject to CORS. Adding `GET` there would widen
the bucket for no behaviour.

**That command works**, and it was predicted here that it would not. The
prediction came from `npm run whoami` reporting no R2 scope on the OAuth token
— which is true, and is why `wrangler r2 bucket create` fails — but the scope
wrangler needs to set a CORS policy is not the same one. Recorded because the
wrong half of that rule was about to be repeated for production.

If it ever does refuse, the dashboard does the same job: R2 →
`steward-preview-files` → Settings → CORS Policy → Edit, with `PUT` from
`https://apply.houstontexansfoundation.org` and from `http://localhost:8787`,
and nothing else.

**Done 22 September** on `steward-preview-files`, two rules.

`GET` is deliberately absent. A download is a top-level navigation to the
signed URL, and navigations are not subject to CORS, so listing it there would
widen the bucket for no behaviour at all.

### 1.4b The first real upload — DONE, 22 September 2026

**Done.** A submitted application carried three attachments; one was read back
out of `steward-preview-files` with `wrangler r2 object get` at 218,056 bytes
and identified by `file(1)` as PDF 1.4. The round trip has been made exactly
ONCE, by hand. Nothing in this repository re-checks it, and no test can.

The rest of this section is kept because production needs the same walk.

**This was the line that mattered.** Every presigned PUT this system has ever
made has been against a stub. The rules it follows are the ones CLAUDE.md calls
"learned the hard way" — `aws4fetch` rather than the AWS SDK, the signature in
the query string, and no `Content-Type` from the browser, because signing with
`signQuery` signs only the host header and an extra header produces a 403 that
does not reproduce in curl.

Two faults on this path have already been found and fixed without a real bucket
being involved: the page's CSP refused every PUT before it was made, and
Turnstile's script was blocked the same way. Both were invisible to the test
suite and visible in a browser console in one second.

So: start an application on `apply.`, reach Documents, attach a PDF.

| What you see | What it means |
|---|---|
| Progress bar, then the filename with **Open** and **Remove** | It works. Click Open; the file should download. |
| Refused at the presign step, before the browser tries anything | A key is wrong. The page says so rather than failing silently. |
| Presign succeeds, upload fails with nothing useful on screen | CORS. The console (F12) carries the real message. |

Report the console line either way. A 403 on this path has a small number of
causes and the message distinguishes them.

**One fault already found and fixed, before you spend an afternoon on it.** The
page's Content-Security-Policy said `connect-src 'self'`, so the browser refused
every presigned PUT before making it — silently, with no request, no R2 error
and nothing in any log. No upload could ever have succeeded. Fixed and tested;
`DECISIONS.md` §31. **Redeploy before testing an upload**, or you will be
testing the broken version.

**And the thing that has never been tested.** The presigned PUT has never run
against a real bucket. Everything up to the signature is tested; the PUT itself
needs real credentials, and `CLAUDE.md` records this as the step that
historically fails in a way that does not reproduce from the command line.
Budget a round trip.

### 1.4a A Google Shared Drive, not a My Drive folder

**Status: wanted, not blocking.** Uploads stay on R2 until this exists, so
nothing is waiting on it — see `docs/DECISIONS.md` §27. Applicant uploads were
to move to Google Drive at your direction. The Phase A spike ran against the real
service account and the real `houstontexansfoundation` folder, and Google
refused the write:

> `403 storageQuotaExceeded` — "Service Accounts do not have storage quota.
> Leverage shared drives, or use OAuth delegation instead."

A file written by a service account is owned by that service account, and a
service account has no Drive storage in Workspace. In a My Drive folder there is
nobody else to charge the bytes to. In a Shared Drive the organization owns the
file and the bytes come from pooled storage.

Everything else about the approach is proven working: the browser uploaded the
whole file direct to Google, CORS and all, under the narrow `drive.file` scope.

**What I need.** A Shared Drive, with a folder in it, and
`steward-uploads@steward-grants.iam.gserviceaccount.com` added as a **Content
manager** member. Then the new folder id, which is not a secret.

**This needs a Workspace admin, not you.** Shared drives exist in the tenant and
there is 5 TB of pooled storage, but *New shared drive* is greyed out on this
account: "You don't have permission to create shared drives." That is an
admin-console setting on the organizational unit.

Two things to request together, because the second one is the next wall and
finding it after the first is done costs another round trip:

1. A new Shared Drive, with the requester as **Manager** — or permission to
   create shared drives, whichever the admin prefers.
2. Confirmation that an **external member** may be added to it. The service
   account's address is not in the `houstontexans.com` domain, so Drive treats
   it as external, and many tenants block that on shared drives. There is a
   per-shared-drive toggle a Manager can flip; failing that it is an admin
   change.

### 1.5 A security review by somebody who did not write this

**Status: not started, and I cannot do it.** I can write scoped queries, hashed
single-use tokens and authorization tests, and I have. I cannot certify the
result — an author reviewing their own work is the one review that does not
count. This system will hold EINs, audited financial statements and operating
budgets belonging to other organizations.

This is a recommendation I will keep repeating rather than let go quiet. No
formal legal gate was asked for; I am raising it anyway.

---

## 2. Blocking specific modules

### 2.1 The scoring rubric

**Blocks: the whole review and scoring module.** The tables exist — rubrics,
weighted criteria, assignments with conflict declaration, per-criterion scores.
There is no rubric to load and no screen to load it with, and building scoring
against a guessed rubric would mean rebuilding it.

**What I need.** Criteria, weights and maximum scores, as a spreadsheet (CSV or
XLSX). It gets parsed, confirmed by an admin, and versioned per cycle, so a
2026 score keeps meaning what it meant in 2026.

### 2.1a Your impact metrics, as a spreadsheet

**Status: the machinery is finished and waiting; the content is not here.**

Grantee reporting is now built end to end — a nonprofit can sign in, see their
grants, and file a report from a phone. What they are ASKED is the one part
that is still invented. `docs/metrics-import-template.csv` holds a plausible
starter set that I made up. **It is not confirmed by anyone and must not be
treated as your metrics.**

**What I need.** One CSV per program, in the template's shape:

```
metric_key,label,help_text,metric_type,unit,is_required,sort_order,promotes_to
```

- `metric_key` is the identity that ties this year's answer to last year's.
  Lower-case letters, digits and underscores. **It must be the same string next
  year.** Reword the question whenever you like; changing the key splits the
  series in two, silently, and the first anyone notices is a board report with
  half the numbers.
- `metric_type` is one of `integer`, `currency`, `decimal`, `text`. It is
  **frozen** once anybody reports against it, because reinterpreting last
  year's answers restates history. Changing your mind later means retiring the
  metric and adding a new one under a new key.
- `promotes_to` is blank on every row but one: put `funds_spent_cents` on the
  currency metric that answers "how much of the grant has been spent", if you
  ask that. At most one per program.

**How to run it**, once the file exists:

```
npm run metrics -- --program=inspire-change --file=your-metrics.csv           # dry run
npm run metrics -- --program=inspire-change --file=your-metrics.csv --apply
```

The dry run reads, plans and prints; it writes nothing. It runs against your
LOCAL preview database by default — add `--preview` for the remote preview one,
or `--db=steward-production` for production.

> **This paragraph used to say "there is no production flag and there will not
> be one." That is no longer true, and the script itself explains why.** The
> rule in CLAUDE.md is that a human names production in the moment, and
> `--db=steward-production` is exactly that: the database is typed out, in that
> command, by that person, and nothing defaults to it. The alternative during
> the cutover was hand-writing the INSERTs — a second implementation of the
> importer — or sending thirteen nonprofits a report form that asks for no
> numbers. Corrected 2026-10-09, after a new-hire review followed this
> paragraph and concluded the documented repair could not reach the database
> that had the problem.

Then, in **More ▾ → Programs** (`/configuration`): **Build a report form from
this program's metrics**,
read the generated wording, change anything you want, and **Publish**.

**You do not need the metrics before the awards.** Publishing attaches the form
to every report obligation that has been waiting for one, so the normal order
— import two years of awards now, send the metrics later — works. What
publishing will NOT do is re-point a report that already names a form: that
freeze is what stops a form edited this March changing the question a grantee
answered last October.

Re-running the file is the normal case — reword a question, add one, reorder
them — and a metric missing from the file is REPORTED, never removed, because a
column somebody forgot to paste is far more common than a decision to stop
asking. A reworded question reaches new reports only; reports already filed
keep the wording they were filed under.

### 2.1b Rebuild the Inspire Change report form — one click

**Blocks: a grantee sending you a photo or a video.** The report form now has a
"Photos and video" field, taking up to six files of up to 200 MB each,
including the HEIC photos and `.mov` clips a phone produces. Preview's
published report form predates it and **a published form definition is immutable
by design** — that freeze is what stops a form edited this March changing the
question a grantee answered last October. So the new field cannot appear on the
old form. A new one has to be built.

**More ▾ → Programs** → Inspire Change → **Build a report form from this program's
metrics**, read the generated wording, change anything you want, **Publish**.

Do this after §2.1a if the metrics CSV is close, so you build once rather than
twice. If the metrics are weeks away, build now anyway: an update with pictures
and no numbers is worth more than neither.

### 2.1c Your historical awards, as a spreadsheet

**Blocks: the entire past-grantee feature.** `/tell-us` is live: a past grantee
enters their organization and the grant they remember, an admin sees the claim
in a queue, picks the matching award by name or EIN, and connects them. From
that moment they can sign in and file an update.

It connects a person to an award **that already exists in the database**. None
do. Until the Foundation's past grants are imported, every claim lands in the
queue with nothing to connect it to.

**What I need first: the column headers only.** Not the data — a header row and
one invented sample row is enough to build the mapping against. Do not send
real EINs or grant amounts into this conversation; I will write the importer
and you run it against the real file on your own machine, the same way the
metrics importer works.

Whatever you have is fine. Organization name, EIN, amount, fiscal year and a
grant date are the useful minimum; anything else is a bonus and anything
missing is a blank, not an error.

### 2.2 Decline letter wording

**Blocks: decision communication.** The highest-reputation-risk output in the
system. Fifty acceptances and 250 declines go out the same week, and the
decline letter is the one that gets screenshotted and forwarded.

**What I need.** The wording, from the Foundation. This is the one piece of
copy that should not be drafted by the person who built the software.

Two rules are already fixed and are not up for negotiation in the build:
decline emails are never sent automatically, and acceptances go out before
declines.

### 2.3 Award agreement and W-9 handling

**Blocks: nothing yet — Phase 4.** Raised now because it changes the schema.
Are award agreements e-signed in-system later, or do they stay a manual upload?

---

## 3. Policy decisions only you can make

Each of these is a real fork. I have a recommendation for each; none should be
decided by whichever behaviour I happened to build first.

| # | Decision | Why it matters | My recommendation |
|---|---|---|---|
| 3.1 | **Draft grace rule.** A draft started before the deadline, submitted after it. | Already a per-cycle column (`draft_grace_hours`), currently unset. A hard cutoff at midnight loses applications that were 90% written. | A short grace window — hours, not days — applying only to drafts that existed before close. Never a later deadline for everyone. |
| 3.2 | **Declined applicants keep portal access?** | Decides whether next year's application prefills or is retyped. Reducing applicant burden is the strongest signal in current grantmaking practice. | Yes, keep access. The cost is a login; the benefit is a returning applicant not retyping their mission statement. |
| 3.3 | **Retention of uploaded financial statements** after a cycle closes. | You hold other organizations' audited financials. Keeping them forever is a growing liability with no stated purpose. | A stated period tied to the award term, then deletion. Needs a decision before the first real cycle, not after. |
| 3.4 | **Confidentiality agreements for outside review consultants** — tracked in-system or handled offline? | Consultants see full applications including financials. | Offline for now; revisit if the reviewer pool grows. |
| 3.5 | ~~**Who holds the second admin account**~~ **DECIDED 2026-10-09.** | Allie Gentile and Amanda Grosdidier, alongside Adam Cann. Three active admins. | **One thing left: Amanda has never signed in.** `last_login_at` is null on that account, so nobody has proved Cloudflare Access admits her. An admin account nobody has used is an assumption, not a continuity plan — and the moment it gets tested is the moment it is needed. Ask her to sign in once at `grants.houstontexansfoundation.org`, today. `npm run golive` now names any admin who has not. The runbook half of this is `docs/IF-SOMETHING-IS-WRONG.md`. |
| 3.6 | **Does the NFL impose any reporting format** on Inspire Change funds? | Changes what the export module has to produce. If there is a required format, building exports before knowing it is waste. | Ask early. It is a question, not a decision. |
| 3.7 | **The 200 MB ceiling on a grantee's video.** | A phone shoots roughly 60 MB a minute at 1080p, so 200 MB is about three minutes. Lower it and long clips fail at the end of an upload, which is the worst place to fail. Raise it and R2 fills with footage nobody watches. | Keep 200 MB and six files. Revisit once there is real usage to look at rather than a guess. |
| 3.8 | **Is report media ever deleted?** | **Right now: never.** Retention covers application attachments only — financial statements get a purge date once an application is decided. Report photos and videos have no retention path at all, and they are the files that will actually fill the bucket. See §4 on cost. | A long window, five years or the award term plus some, then deletion — but this needs a decision, not a default. Deciding it late means deciding it about real footage of real children. |
| 3.9 | **Approving a claim requires an admin to name the award.** | Deliberate: the system offers matches and refuses to guess, because attaching the wrong organization to an award exposes one nonprofit's grant to another. It means claims cannot be bulk-approved. | Keep it. The volume is tens a year, not thousands, and the failure it prevents is the unrecoverable kind. |

| 3.10 | **Does the nightly cron mail grantees by itself?** | `wrangler.toml:392` runs `0 7 * * *` on production, about 2am Central, and `src/index.ts:2511` calls `runReportReminders` with **no count guard and no human** — that guard, `runRemindersNow`, is on the manual path only. The awards importer created an active grantee login from each CSV row (`src/import/importAwards.ts:406`), so **all thirteen are mailable now**: thirteen logins, thirteen distinct domains, none blank. `docs/ONBOARDING.md` said the opposite until 9 October and that sentence is what the plan for the human note rested on. Set a due date and walk away, and fourteen days before it the thirteen are mailed overnight with nobody having read the letter. | **Turn the automatic chase off for the 2025 ask — it now is, by default.** As of 9 October the cron mails only when `REMINDERS_AUTOMATIC` is exactly `"on"`. It is set nowhere, so the cron records `REMINDERS_AUTOMATIC_OFF` and mails nobody. **The Reports screen's "Send N now" is unaffected** — it still lists every address and still refuses if the count moved. The switch removes the *unattended* send, not the ability to send. Off is the default because the failure modes are not symmetrical: off when it should be on means a late reminder a human notices; on when it should be off means mail that cannot be recalled reaching organizations you fund. Turn it on, in `wrangler.toml` under `[env.production.vars]`, once you have watched one real round go out. |

| 3.11 | **Is a report due "today" in Central or in UTC?** | `reportDue.today()` is the UTC day while the grantee portal shows Central (`src/lib/reportDue.ts:29`). A grantee opening the portal at 8pm Central on the due date reads "due today"; the server already counts them a day late, and under a `block` compliance policy that can **refuse their next application** for a report that is not late. Flagged four times and never fixed, because it moves a boundary that refuses people money and that is not a decision to slip into a commit. | **Central, everywhere.** It is the zone the deadline was communicated in, and the one the grantee is standing in. The cost is one shared helper and a check that bans the other form; the cost of leaving it is refusing a nonprofit money over six hours. |

| 3.12 | **The five questions the thirteen will be asked.** | They are a **placeholder set with no author at the Foundation.** §2.1a of this document says so in its own words: *"a plausible starter set that I made up. It is not confirmed by anyone and must not be treated as your metrics."* Production now holds those five, byte for byte, and the report form is published. A published form is immutable by design and the metric key is the series identity — change the key later and the series splits in two, silently. Right now **no real grantee has answered**: one submission exists and it is the end-to-end test. So this is free to change today and permanent the moment the first real report lands. The second question, *"What were you counting?"*, is free **text**, so the Impact screen's people-served total sums organizations that may be counting meals, visits and households, and the basis cannot be grouped or filtered. | **Write the five yourself, this week, even if you keep four of mine.** The 2025 answers become the baseline every future board and league report is measured against, and a baseline nobody chose is worse than a baseline that is merely imperfect. At minimum, replace the free-text basis with a fixed list of options so the totals mean something. |

---

## 3b. The 2026 cycle — what the Foundation has to produce

Engineering cannot start most of these. They are content, decisions and
bookings, and each one blocks a module that is otherwise built.

Verified against production on 2026-10-09: **0 rubrics, 0 rubric criteria,
0 public awards, 13 awards with no application, 0 awards with a focus area.**

### 3b.1 The scoring rubric — blocks review entirely

**The machinery is built.** `src/lib/rubrics.ts`, the upload and parse routes,
versioning per cycle, in-app scoring, the offline scorecard export and a
matching import that refuses a file made for a different rubric version. All
of it exists and none of it has ever been used, because **production holds
zero rubrics**.

| Who | What |
|---|---|
| **Executive Director** | Decide what the Foundation actually scores on, and the weight of each. Four to seven criteria is normal; more than ten and reviewers stop discriminating between them. |
| **Senior Director** | Write each criterion as a sentence a reviewer can score without asking what it means, and set a max score per criterion. |
| **Either** | Hand over a CSV or XLSX: criterion label, description, weight, max score. **`docs/rubric-template.csv` is a starting point with five criteria and equal weights** — change every word of it; it is a shape, not a recommendation. An admin uploads it and confirms the parse in-app; it versions per cycle. |

Until this exists, "why was X funded and not Y" has no answer but one person's
prose, and no consultant can be given anything to score.

### 3b.2 The executive product — there is currently nothing

Executives never log in, so the export **is** the product for them. Today the
only one is `/api/dashboard.csv`: aggregate totals by program, cycle and fiscal
year. No grant-level list, no impact export, no PDF. It also carries a
"Not included" caveat row that never prints, because the field feeding it is
set to empty unconditionally (`src/lib/dashboard.ts:336`).

| Who | What |
|---|---|
| **Executive Director** | Name the three or four numbers that actually go in a board paper, and say which ones the NFL requires in a set format (open decision 3.6 — this is a question to ask the league, not a decision to make). Building exports before that answer is waste. |
| **Executive Director** | Decide whether the deliverable is a CSV somebody pastes into a deck, or a PDF that stands alone. The PDF is more work and is the one an executive actually forwards. |
| **Senior Director** | Produce last year's board report and last year's league submission, as files. They are the specification; nothing else states what these outputs have to contain. |

### 3b.3 The public grants page — a data problem, not a code one

The page is built and is structurally empty. `src/lib/publicGrants.ts` inner-
joins `applications` on purpose: publishing is gated on
`decision_communicated_at`, an imported award has no application and therefore
no such stamp, so the condition cannot be evaluated. `setPublic` refuses with
*"This award was imported and cannot be published here."* All thirteen 2025
grants are in exactly that state.

Two ways out, and the choice is the Foundation's:

1. **Publish 2026 onward only.** Zero work. The page fills as the first real
   cycle completes, and 2025 is simply not on it.
2. **Make the thirteen publishable.** Needs a deliberate change — a publish
   path for imported awards that does not depend on a communication stamp,
   plus the Foundation confirming that each of the thirteen may be named
   publicly with its amount.

| Who | What |
|---|---|
| **Executive Director** | Choose 1 or 2. If 2, confirm the Foundation is content to publish organization, amount and purpose for each of the thirteen. |
| **Senior Director** | If 2: one line per grant describing what it funded, in language fit for a public page. See 3b.4 — it is the same sentence. |

### 3b.4 Portfolio and equity analysis — one missing field, one missing index

Two separate causes, and both need the Foundation, not a developer:

**Focus area never leaves the answers table.** `area_of_focus` in the Inspire
Change form has no `mapsTo` (`src/seed/inspireChange.ts:422`), so it stays in
`application_answers` and cannot be filtered, grouped or counted. **Counties
do map** (`counties_served`), so county analysis is reachable; focus area is
not. Adding `mapsTo` is a small change — but it needs a **fixed list of focus
areas the Foundation actually uses**, because a free-text or ad-hoc list
produces categories nothing can be grouped by. That list is the blocker.

**The thirteen describe nothing.** `focus_area`, `purpose` and counties are
blank on all thirteen (0 of 13 have a focus area). Nothing can be searched or
analysed about 2025 regardless of the above.

| Who | What |
|---|---|
| **Executive Director** | **Confirm or amend the five focus areas that already exist** in the application form (`src/seed/inspireChange.ts:427`): Education, Criminal justice reform, Workforce and economic development, Community resources, Basic needs. This is a smaller job than it looks — the list is written and in use; it needs endorsing, not inventing. Once applications are submitted against it, changing it splits the data. |
| **Senior Director** | For each of the thirteen 2025 grants: one focus area from that list, the counties reached, and one sentence on what it funded. **`docs/2025-grant-subjects-worksheet.csv` is already filled in with the reference, organization and amount** — three columns to complete, thirteen rows. This single sheet unblocks search, the public page and portfolio analysis at once. It is typed back in one award at a time on the award page; there is no bulk import, and at thirteen rows there does not need to be. |

### 3b.5 DMARC enforcement

The domain publishes `p=none`: forgery is monitored and nothing is done about
it. Anyone can send as `grants@houstontexansfoundation.org`, which matters most
during announcement week, when grantees are expecting mail from exactly that
address.

Google's aggregate report for 2026-10-08 shows every observed message passing
SPF and DKIM, both aligned. So tightening costs nothing **that we can see from
one day of data**.

| Who | What |
|---|---|
| **You, now** | Add `np=reject` to the DMARC record. It covers non-existent subdomains only, cannot affect `rsend.`, and blocks a whole class of forgery today. |
| **You, in 2–4 weeks** | Read the accumulated reports. If no legitimate sender other than Resend appears, move to `p=quarantine`, then to `p=reject` a few weeks later. |

**Do not jump straight to `p=reject`.** One day of reports cannot tell you
whether some other system — a marketing platform, a vendor, Eloqua — also sends
as this domain. If one does, enforcement silently destroys its mail.

---

## 4. Things you will need to do, but not yet

- Apply the fourteen migrations to staging: `npm run migrate:staging`.
- Confirm the presigned upload actually works against a real R2 bucket. I can
  test everything up to the signature; the PUT itself needs real credentials
  and a real bucket, and this is exactly the step that historically fails in a
  way that does not reproduce from the command line.
- Screen-reader testing by somebody who uses one. I can write correct markup
  and have. I cannot verify how it sounds.
- **Watch R2 storage once grantees start sending video.** You asked to be
  flagged above $5 a month. `GET /api/storage` reports total bytes, a split by
  what the file is attached to, how much of it has no retention path, and an
  estimated monthly cost at R2's $0.015 per GB. $5 a month is roughly 333 GB,
  which at six 200 MB videos per report is around 280 reports — so this is a
  problem that arrives gradually and only if nothing is ever deleted. Decision
  3.8 is the thing that decides whether it arrives at all.
- Three friendly organizations submitting real applications on their own
  devices, with no help. That is the Phase 2 verification, and it is not
  optional — every applicant problem this platform has will be found there or
  by a real applicant on deadline day.
