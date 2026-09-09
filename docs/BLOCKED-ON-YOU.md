# What Steward needs from the Foundation

One list, kept current. Everything here blocks work that is otherwise ready to
start, or blocks the platform going live. Nothing here is something I can do
myself, decide on your behalf, or work around.

Last updated: 9 September 2026.

---

## 1. Blocking the public form going live

### 1.1 A domain, and its DNS

**Status: nothing exists.** `houstontexansfoundation.org` does not resolve —
no A record on the apex, on `www`, or on the planned
`applications.houstontexansfoundation.org`. I checked from this environment
and calibrated the result: a real-but-unreachable domain returns a different
error than an unregistered one, and this returns the unregistered one. I could
not run a WHOIS to tell "never registered" from "registered, no DNS", because
outbound is proxy-blocked here — check the registrar or Cloudflare dashboard.

**Why it blocks.** DNS is lead time, not effort. Three things hang off it:

- The sign-in link. An applicant's magic link has to point at a hostname that
  exists, and the link is the whole authentication system for external users.
- Email deliverability. SPF, DKIM and DMARC are records on this domain. A
  grantee who cannot receive a login link cannot file a report, and a decline
  letter landing in spam is a decline letter that gets re-sent by a human.
- Cloudflare Access. Staff sit behind Access on this hostname; the public
  applicant routes must sit outside it. That is a policy written against a real
  domain.

**What I need.** The domain registered and its nameservers on Cloudflare.
`docs/EMAIL-DNS-SETUP.md` is the step-by-step for the email records once it
exists — written for someone who has not done this before.

### 1.2 Resend: domain verification and an API key

**Status: not done.** There is no `RESEND_API_KEY`, so every email the system
produces is recorded and deliberately suppressed. That is the correct state for
preview — a development run cannot mail a real applicant — but it means no
email has ever actually been delivered by this system.

**What I need.** The Resend domain verified (it depends on 1.1) and the API key
set as a Wrangler secret. Never in the repo, never in `wrangler.toml`.

### 1.3 R2 storage credentials

**Status: placeholders.** `wrangler.toml` carries
`R2_ACCOUNT_ID = "FILL_IN_ONCE_KNOWN"`, and there is no R2 access key or
secret. Uploads are built and tested, and cannot work against a real bucket
without these.

**What I need.**

- The Cloudflare account id, into `wrangler.toml`.
- An R2 access key id and secret, as Wrangler secrets.
- CORS on the preview bucket allowing the app origin, once 1.1 exists.

### 1.4 A security review by somebody who did not write this

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
