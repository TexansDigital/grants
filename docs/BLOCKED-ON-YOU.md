# What Steward needs from the Foundation

One list, kept current. Everything here blocks work that is otherwise ready to
start, or blocks the platform going live. Nothing here is something I can do
myself, decide on your behalf, or work around.

Last updated: 23 September 2026.

---

## 0. Waiting on your terminal — a redeploy

Migrations 0001–0027 are applied to preview. **0026** (reserved field keys) and
**0027** (`grantee_claims`) both went in on 22 September, and the deploy at
`3b316931` carried the claim queue.

Since that deploy, three things have landed that are worth a redeploy:

- The file picker fix. The photos-and-video field listed mime types only, so
  Chrome on Windows and Android greyed out every HEIC photo — every photo an
  iPhone takes — with no error at all. This is client-side, so a redeploy is
  the whole fix and it applies to the application form's uploads immediately.
- The upload refusal used to read "must be a image or video file". It now
  reads like English.
- Word and Excel files the browser declines to name are no longer refused.

```
npm run whoami
npm run deploy:preview
```

`whoami` prints the database name before anything writes. No migration is
pending; nothing here touches production.

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
| SPF | One record, Cloudflare Email Routing's. |
| DKIM | `resend._domainkey`, verified in Resend. |
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
LOCAL preview database by default — add `--preview` for the remote preview one.
There is no production flag and there will not be one.

Then, in Configuration: **Build a report form from this program's metrics**,
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

Configuration → Inspire Change → **Build a report form from this program's
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
| 3.5 | **Who holds the second admin account**, and the runbook if the primary owner is unavailable mid-cycle. | Two admin accounts exist from day one by design. One admin is a continuity failure, not a security preference. | Name a person before the first cycle opens. |
| 3.6 | **Does the NFL impose any reporting format** on Inspire Change funds? | Changes what the export module has to produce. If there is a required format, building exports before knowing it is waste. | Ask early. It is a question, not a decision. |
| 3.7 | **The 200 MB ceiling on a grantee's video.** | A phone shoots roughly 60 MB a minute at 1080p, so 200 MB is about three minutes. Lower it and long clips fail at the end of an upload, which is the worst place to fail. Raise it and R2 fills with footage nobody watches. | Keep 200 MB and six files. Revisit once there is real usage to look at rather than a guess. |
| 3.8 | **Is report media ever deleted?** | **Right now: never.** Retention covers application attachments only — financial statements get a purge date once an application is decided. Report photos and videos have no retention path at all, and they are the files that will actually fill the bucket. See §4 on cost. | A long window, five years or the award term plus some, then deletion — but this needs a decision, not a default. Deciding it late means deciding it about real footage of real children. |
| 3.9 | **Approving a claim requires an admin to name the award.** | Deliberate: the system offers matches and refuses to guess, because attaching the wrong organization to an award exposes one nonprofit's grant to another. It means claims cannot be bulk-approved. | Keep it. The volume is tens a year, not thousands, and the failure it prevents is the unrecoverable kind. |

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
