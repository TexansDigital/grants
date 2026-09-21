# What Steward needs from the Foundation

One list, kept current. Everything here blocks work that is otherwise ready to
start, or blocks the platform going live. Nothing here is something I can do
myself, decide on your behalf, or work around.

Last updated: 21 September 2026.

---

## 0. Waiting on your terminal, not on a decision

Two things, neither of which needs a judgement call. They are first because
everything below assumes the preview environment matches the code.

**Apply the migrations and redeploy.** Three are outstanding:

```
npm run whoami
npm run migrate:preview
npm run build:web && npx wrangler deploy --env=""
```

| Migration | What it adds |
|---|---|
| `0022_retention_notice_stamp` | Records which files have already been warned about, so a missed cron night delays the month-out retention warning instead of losing it. |
| `0023_conflict_cleared` | Lets an admin record that a declared conflict is not one, instead of the reviewer being blocked until somebody recuses them. |
| `0024_award_amendments` | The amendments table 0012 has been pointing at since Phase 0. Until it is applied, an award recorded at the wrong amount still cannot be corrected. |

**Then look at the Turnstile widget on `apply.`, on a real browser.** The
Worker's Content-Security-Policy said `script-src 'self'`, which blocked
Turnstile's script and its challenge iframe outright: the widget could not have
rendered on the sign-in page or the eligibility screen, and no token was ever
produced. That is fixed and tested, but the fix can only be confirmed where
there is a real network route to `challenges.cloudflare.com`, which the build
environment does not have. Open the sign-in page and confirm you see the
checkbox.

**Nothing here touches production.** `migrate:preview` runs against the preview
database, which is what `npm run whoami` prints before you commit to anything.

---

**The short version, in the order it unblocks things:**

| | What | Blocks |
|---|---|---|
| 0 | Apply migrations 0022–0024, redeploy, eyeball Turnstile (§0) | The three features above, and confirming bot protection works at all |
| 1 | ~~`apply.` DNS record, and Resend's DNS records~~ | **DONE 20 Sep.** Both hostnames live, domain verified, SPF/DKIM/DMARC published. |
| 2 | ~~Resend API key, as a Wrangler secret~~ | **DONE 20 Sep.** A sign-in link was sent, delivered, and used to reach the grantee portal. |
| 3 | R2 key + secret, `steward-staging-backups`, bucket CORS | Every file upload. (Account id and `steward-preview-backups` are done.) |
| 3a | A Google Shared Drive, from IT | Nothing today. Uploads stay on R2 until it exists — see §1.4a |
| 4 | Your impact metrics, as a CSV | What grantee reports ASK. The machinery is finished. |
| 5 | The scoring rubric, as a CSV or XLSX | The entire review and scoring module |
| 6 | Decline letter wording | Decision communication |
| 7 | A security review by somebody who did not write this | Going live. A gate, not a task. |
| 8 | Six policy decisions (§3) | Various. I have a recommendation for each. |

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

**Status: partly done. This is now the single largest blocker left.**

`R2_ACCOUNT_ID` is filled in. There is still no R2 access key or secret, so
every presigned upload refuses rather than half-working — which blocks an
Inspire Change application outright, since it requires three file uploads.

**What I need.**

- An R2 access key id and secret (R2 → Manage API tokens), as Wrangler secrets:
  `npx wrangler secret put R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
- CORS on `steward-preview-files`, from the rules already written in
  `config/r2-cors.json`:
  `npx wrangler r2 bucket cors set steward-preview-files --file=config/r2-cors.json`

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

---

## 4. Things you will need to do, but not yet

- Apply the fourteen migrations to staging: `npm run migrate:staging`.
- Confirm the presigned upload actually works against a real R2 bucket. I can
  test everything up to the signature; the PUT itself needs real credentials
  and a real bucket, and this is exactly the step that historically fails in a
  way that does not reproduce from the command line.
- Screen-reader testing by somebody who uses one. I can write correct markup
  and have. I cannot verify how it sounds.
- Three friendly organizations submitting real applications on their own
  devices, with no help. That is the Phase 2 verification, and it is not
  optional — every applicant problem this platform has will be found there or
  by a real applicant on deadline day.
