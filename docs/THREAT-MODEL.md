# Threat model

Written for whoever is hired to do the security review CLAUDE.md keeps
recommending, so that review starts from the interesting questions rather than
from reading the repository cold. It is deliberately blunt about where I would
look first.

**This document is not a security review and does not substitute for one.** I
wrote the code it describes. I can write scoped queries, hashed single-use
tokens and authorization tests, and I can explain the threat model. I cannot
certify the result, and nobody should treat a green test suite as a finding of
safety.

---

## What is worth stealing

In rough order of how badly a breach would hurt the organizations whose data
this is — not the Foundation:

1. **Audited financial statements and operating budgets** belonging to
   nonprofits, uploaded to R2. These are third-party financial records held in
   custody. A nonprofit that loses its audit to a breach of *our* system has
   been harmed by us.
2. **EINs** — nine digits that identify a legal entity and appear on tax
   filings. Not secret, but a clean list of hundreds of them with contact
   details attached is a phishing kit.
3. **Reviewer scores, internal notes and decision rationale.** Not
   catastrophic in the abstract; catastrophic to a specific relationship. "The
   board is thin and we are not convinced" reaching the executive director it
   describes is the kind of thing that ends a funding relationship and gets
   screenshotted.
4. **Demographic narratives** — applications describe the populations served,
   often in detail, on behalf of people who never agreed to anything.
5. **Contact details** for 100–300 nonprofit staff.

Notably absent: **no payment instruments, no bank details, no SSNs.** The
system records payment schedules and status; disbursement stays with finance.
W-9s are collected at award acceptance, from the ~50 organizations funded, not
from the ~300 that apply.

---

## Trust boundaries

There are four, and they are not equally hard.

**1. The public internet → the public endpoints.** `/api/public/cycles`,
`/api/public/forms/:id`, `/api/public/grants`, `/api/public/eligibility`,
`/api/auth/request-link`, `/api/auth/verify`. No session. Turnstile on the
entry points; rate limits on sign-in and eligibility. Everything here is
either data the Foundation chose to publish or a write that creates an
organization and mails a link.

**2. A magic-link session → that organization's data.** The applicant and
grantee door. A signed-in external user reaches 17 routes. Every one of them
derives `organization_id` from the session, never from the request. This is
the boundary that matters most and the one with the most surface.

**3. Cloudflare Access → the staff API.** Access verifies a JWT against the
team's JWKS; the Worker checks `aud` and maps the email to a `users` row. No
auto-provisioning — an authenticated email with no row gets 404. Staff fit
inside Access's 50 free seats; **applicants and grantees must never be put on
Access**, both because seat 51 is blocked rather than billed and because it
would put nonprofits behind the Foundation's identity provider.

**4. Admin → reviewer.** Inside the staff API, a reviewer sees only
applications assigned to them. This is a real boundary, enforced in SQL, and
it is the one most likely to be got wrong by a future change, because it looks
like a UI concern.

The hostname split — `grants.` for staff, `apply.` for nonprofits — is
enforced in code (`surfaceOf`), not in the Access dashboard. That was a
deliberate move after the dashboard setting silently widened itself when a
second custom domain was added to the same Worker.

---

## What is actually in place

Stated so a reviewer can check the claims rather than rediscover them.

| | |
|---|---|
| Magic-link tokens | Stored hashed, single-use, 15-minute expiry |
| Sessions | Opaque token, hashed KV key, 7-day expiry, `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Lax` |
| Sign-in rate limits | 5 per email per 15 min, 20 per IP per hour |
| Bot protection | Turnstile on the public entry points — and it had never once run until 21 September, because the CSP was blocking the widget |
| Uploads | Presigned PUT direct to R2, 10-minute expiry, 15 MB default cap, MIME allow-list defaulting to PDF and office formats |
| Downloads | Presigned GET, 5-minute expiry, forced `content-disposition: attachment` and `application/octet-stream` |
| Audit log | Append-only by trigger — no update, no delete, no INSERT OR REPLACE |
| Soft delete | Everywhere; nothing is hard-deleted |
| Payload guard | Every `auth: 'applicant'` response is inspected for internal-only fields and fails closed |
| Headers | CSP, HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`, `base-uri 'none'` |

---

## Where I would look first

Ordered by how much I would expect to find, not by how serious it would be.

**1. Rate limiting stops at the front door.** `checkRateLimit` is called from
sign-in and eligibility and nowhere else. An authenticated applicant can call
autosave, or mint presigned upload URLs, as fast as they like. The blast
radius is bounded — it is their own draft, and uploads are capped per file —
but there is no ceiling on *how many* objects one organization can put in the
bucket, and a presigned URL is a bearer token. I would attack this first.

**2. MIME type is taken from the client.** The upload intent names its own
content type and the server checks it against an allow-list. Nothing inspects
the bytes. R2 does no malware scanning. The mitigations are real but indirect:
buckets are private, downloads force an attachment disposition with an opaque
type, and nothing is ever rendered inline. Still — a file that says it is a
PDF and is not will be stored and served to Foundation staff.

**3. The reviewer boundary.** Scores, the review queue, the scoring sheet, the
applicant-history panel, and search. Search is the one I would press hardest:
it returns ranked snippets of narrative text across organizations, and it was
once scoped by "is this person staff" and nothing else, which handed a
reviewer a snippet of every application in the system. It is now scoped
through the same helper as the detail view. Check that they cannot drift
apart.

**4. The eligibility endpoint creates organizations.** It is public, behind
Turnstile and an IP rate limit, and it writes rows. That is the only
unauthenticated write path that creates records. Data-health has a junk
cleanup for what it lets through.

**5. Two functions in `scope.ts` have no production caller.**
`getApplicationForExternal` and `getApplicationForStaff` are thoroughly tested
and reached by nothing that serves a request; the live paths are `readDraft`
and `getApplicationDetailForStaff`. Not a hole — but if you audit `scope.ts`
and conclude the scoping is careful, check that the routes go through the
functions you read. Recorded in the roadmap as an open decision.

**6. Decision leakage before the letter.** `applicantVisibleStatus` masks an
outcome until `decision_communicated_at` is set, in two places. A third read
path that forgets the mask would tell a nonprofit it was declined days before
a human sent the letter. This is a correctness bug that presents as a
reputational incident.

**7. `error_log` and `audit_log` contents.** Both are written from code paths
that handle applicant data. Check that neither accumulates narrative text,
EINs or email addresses in a table with weaker access rules than the rows they
came from.

---

## Things I know are not solved

- **No human has reviewed this.** That is the point of this document.
- **No penetration test.** Nothing has been attacked by anyone trying.
- **R2 does no malware scanning.** Type and size validation is not safety.
- **Deliverability is not code.** SPF, DKIM and DMARC are configured; a
  grantee who cannot receive a login link cannot file a report, and that is an
  availability problem with a security-shaped cause.
- **No real-time collaboration.** Two admins on one award is last-write-wins
  except where optimistic locking was added deliberately (awards, scoring).
- **Accessibility is mechanically clean and has never been screen-reader
  tested.** Not a security property; listed because it is the same class of
  claim.
- **The Turnstile iframe is not covered by any automated check**, because
  preview sets no site key.
- **Time Travel is not a backup.** The nightly export is; it has now been
  restored once, into an empty database, from a real export. See
  `docs/RESTORE.md` for what that does and does not establish.

---

## What I would want a reviewer to produce

Not a list of missing headers. Specifically:

1. An attempt to read one organization's data while signed in as another,
   through any route, by any means — including ones the route census does not
   model, such as a presigned URL from a different session or a replayed
   magic link.
2. A judgment on whether the reviewer/admin split holds under the assumption
   that outside consultants are hostile, since they are added and removed
   inside a single cycle.
3. A judgment on the upload path specifically, as the place where this system
   takes custody of other people's financial records.
4. Whatever you find that is not on this list, which is the part I cannot
   write.
