# What Steward needs from the Foundation

One list, kept current. Everything here blocks work that is otherwise ready to
start, or blocks the platform going live. Nothing here is something I can do
myself, decide on your behalf, or work around.

Last updated: 19 September 2026.

---

## 1. Blocking the public form going live

### 1.1 DNS records on a domain that already exists

**Status: better than I previously reported, and I should correct that.** I
earlier said the domain "does not resolve" and implied it might not be
registered. That was an overreach from an incomplete check — I looked at the
apex and at `applications.`, found nothing, and drew a conclusion the evidence
did not support.

**What is actually true**, re-checked properly:

| | State |
|---|---|
| Zone on Cloudflare | Live. Nameservers `crystal.ns.cloudflare.com`, `jay.ns.cloudflare.com`, valid SOA. |
| `grants.` — staff | Resolving, proxied through Cloudflare. |
| `apply.` — applicants and grantees | **Nothing published.** This is the one the portal needs. |
| SPF, DKIM, DMARC | **No TXT records at all.** |
| MX | None. |

The apex having no A record is normal for a zone used only through subdomains.
It is not evidence of anything.

**The hostname is `apply.`, not `applications.`** — `docs/DECISIONS.md` §15
settled that, and earlier versions of this file had it wrong.

**What I need.** An `apply.` record pointing at the Worker, and the Resend DNS
records below. Both are dashboard work, not registration lead time.

**How to check it yourself** (I cannot — the sandbox blocks outbound to your
domain):

```
dig +short NS  houstontexansfoundation.org
dig +short A   grants.houstontexansfoundation.org   # answers today
dig +short A   apply.houstontexansfoundation.org    # empty today
dig +short TXT houstontexansfoundation.org          # SPF goes here
dig +short TXT _dmarc.houstontexansfoundation.org
curl -sS https://grants.houstontexansfoundation.org/health
```

That last one is the real test. `{"status":"ok"…}` means the Worker is live
behind Access. A Cloudflare Access login page also passes — it means Access is
doing its job and you are not signed in.

### 1.2 Resend: domain verification and an API key

**Status: not done.** There is no `RESEND_API_KEY`, so every email the system
produces is recorded and deliberately suppressed. That is the correct state for
preview — a development run cannot mail a real applicant — but it means no
email has ever actually been delivered by this system.

**What I need.** The Resend domain verified (it depends on 1.1) and the API key
set as a Wrangler secret. Never in the repo, never in `wrangler.toml`.

### 1.3 A backups bucket

**Status: named in `wrangler.toml`, not created.** The nightly D1 export is
built and writes to an R2 bucket bound as `BACKUPS` — deliberately a *different*
bucket from the one holding applicant uploads, because one export contains
every organization's data and concentrating that beside the files an applicant
can reach through a presigned URL means one bucket-level mistake exposes both.

**What I need.** Create two buckets, named `steward-preview-backups` and
`steward-staging-backups`, in the Cloudflare dashboard under **R2 → Create
bucket**.

The dashboard rather than the CLI on purpose: wrangler's OAuth login does not
request an R2 scope, so `wrangler r2 bucket create` fails with a permissions
error no amount of re-authenticating fixes. The Worker's own R2 bindings are
unaffected — they bind at deploy time from `wrangler.toml`.

Production's name is a placeholder and gets filled in at deploy time.

**And one thing only a human can do.** The export has never been restored. A
backup nobody has restored is a hypothesis — the manifest says so in the file
itself. Before the first real cycle, take one export and load it into an empty
database, then check the row counts against the manifest. That test is the
difference between having backups and believing you do.

### 1.4 R2 storage credentials

**Status: placeholders.** `wrangler.toml` carries
`R2_ACCOUNT_ID = "FILL_IN_ONCE_KNOWN"`, and there is no R2 access key or
secret. Uploads are built and tested, and cannot work against a real bucket
without these.

**What I need.**

- The Cloudflare account id, into `wrangler.toml`.
- An R2 access key id and secret, as Wrangler secrets.
- CORS on the preview bucket allowing the app origin, once 1.1 exists.

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

- Apply the eleven migrations to staging: `npm run migrate:staging`.
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
