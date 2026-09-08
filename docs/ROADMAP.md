# Steward roadmap — draft for review

Written after Phase 1. This is a proposed **revision** to the phase plan in
CLAUDE.md, not a restatement of it. Where it differs, the reason is stated.

## Where we actually are

Phase 0 and Phase 1 are done, but the honest summary is narrower than the phase
names suggest:

**Built, tested, and reachable over HTTP:** Access-verified staff session,
program / cycle / form-definition reads, the form definition contract, the
applicant form renderer.

**Built and tested, but reachable by nothing.** This is the important one.
`saveDraft`, `submitApplication`, `searchApplications`,
`getApplicationForExternal`, `listApplicationsForExternal`, `promote`,
`validateUploadIntent` all exist with tests and have **zero HTTP routes**. The
submission engine is written. Nobody can reach it.

**Not built at all:**
- Applicant and grantee identity. `requireStaffSession` is the only auth in the
  system. The KV namespace is bound and unused. No magic link, no token table.
- R2 upload. `aws4fetch` is not a dependency; no presigning endpoint exists.
- Email. Resend is not a dependency. No sending path.
- Schema beyond applications. Migrations stop at 0005. There are **no tables**
  for rubrics, review assignments, review scores, awards, amendments, payments,
  report periods, report submissions, metrics, or metric values. That is roughly
  half the data model in CLAUDE.md, and Phases 3 through 6 all sit on it.
- The scheduled D1 export to R2. No cron trigger is configured.

## Two changes to the phase plan, and why

### 1. Split Phase 2. It is four risky things, not one.

CLAUDE.md says Phase 2 is the highest-risk phase and must not be compressed. It
then describes eleven steps that include a new identity system, a new storage
path, a new email dependency, and the first public endpoint this system has ever
had. Any one of those can sink a deadline day on its own.

Proposed split:

- **2a — Applicant identity.** Magic-link login on KV: single-use, hashed at
  rest, short expiry, rate limited. Ends with an applicant able to sign in and
  see an empty dashboard and nothing else. Small, self-contained, and the thing
  every later step assumes.
- **2b — Draft and submit over HTTP.** Route the engine that already exists:
  draft create, autosave, whole-form validate, submit, confirmation read-back.
  Wire the renderer's autosave to the server instead of localStorage. This is
  mostly plumbing precisely because the hard part was done in Phase 0.
- **2c — Uploads.** Presigned PUT direct to R2 per the pattern in CLAUDE.md
  (aws4fetch, do not sign Content-Type, bucket CORS). Replaces the inert upload
  control in the renderer.
- **2d — Public entry and cycle close.** The public cycle page, Turnstile,
  eligibility screen, returning-organization prefill, EIN check, the hard
  cutoff at `closes_at` and the grace rule.

### 2. Pull three Phase 7 items forward, to before 2d ships.

CLAUDE.md puts operations in Phase 7 and separately says the export must exist
before the public form goes live. Those two statements conflict. Phase 2d is the
moment this system starts holding other organizations' audited financial
statements and EINs, so the prerequisites belong before it, not after:

- **Scheduled D1 export to R2** via cron. Time Travel is disaster recovery, not
  backup. Currently there is no cron trigger at all.
- **SPF, DKIM and DMARC on the domain.** Not a code task. A grantee who cannot
  receive a login link cannot file a report, and this is a DNS lead time, not a
  sprint item.
- **The human security review.** CLAUDE.md is explicit that I cannot perform
  one. Booking it is a calendar action with a lead time, and it gates 2d.

## Proposed order

| # | Work | Depends on | Why here |
|---|---|---|---|
| **A** | Migrations 0006–0008: rubrics, reviews, awards, payments, reports, metrics | — | Unblocks Phases 3–6. Pure schema, no UI, reviewable in one sitting. Doing it now means later phases are not each preceded by a schema scramble. |
| **B** | 2a — applicant identity | A not required | Every external-facing thing assumes it. Smallest risky piece; do it alone. |
| **C** | 2b — draft and submit routes | B | Routes an engine that is already written and tested. |
| **D** | Phase 3 — review and scoring | A | Runs in parallel with C. Staff-only, behind Access, no new identity surface. |
| **E** | 2c — uploads | C | Needs a draft to attach to. |
| **F** | Ops prerequisites: cron export, SPF/DKIM/DMARC, book the security review | — | Start the DNS and the booking during C and D; they have lead times, not effort. |
| **G** | 2d — public entry, Turnstile, eligibility, close rules | E, F | The first public endpoint. Nothing public ships before F is done. |
| **H** | Phase 4 — awards, payments, decision communication | A, D | |
| **I** | Phase 5 — grantee reporting | A, H | Reuses the form engine and the 2a identity path. |
| **J** | Phase 6 — dashboard and exports | H, I | |

Phase 1 leftovers — rubric CSV/XLSX upload and parse, and form-definition
management in the UI — fold into A and D rather than standing as their own
phase. The rubric parser is only useful once `rubrics` and `rubric_criteria`
exist.

## Decisions this plan needs

1. **Applicant login mechanism.** The Cloudflare OTP took ten minutes to arrive
   and that is the current live evidence. Transactional mail through Resend is a
   different sender with different latency, but the deeper problem is that
   corporate scanners *follow* links in mail, which burns a single-use token
   before the applicant clicks it. A link that is single-use but survives a HEAD
   or a prefetch, or a link plus a code fallback, is the design question. This
   blocks B.
2. **The grace rule** for drafts started before close (open decision #6). The
   column exists and defaults to 0. Blocks G, not before.
3. **Whether declined applicants keep portal access** (open decision #4). Shapes
   the identity model in B.

## What I am not proposing

- No production deploy in any phase here. Everything stays on preview bindings.
- No public endpoint before F.
- I am not proposing to skip the offline scoring export in D. CLAUDE.md wants it
  as a fallback and is right that it should not be the default path.
