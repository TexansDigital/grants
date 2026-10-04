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
| 6 | `golive` clean | not done | `npm run golive` |
| 7 | Access challenges `grants.`, and does NOT cover `apply.` | **done 2026-10-04** | staff shell resolved adam.cann as admin, which requires a valid Access JWT; apply. loads with no Access prompt |
| 8 | `apply.` serving, no open cycles | **done 2026-10-04** | "Nothing is open right now", plus the Tell us about a grant we gave you entry point |

### The work itself

| # | Condition | State | How to check |
|---|---|---|---|
| 9 | Thirteen imported, with an audit row each | not done | *Checking the databases* |
| 10 | Update request dry-run matched 13, then run | not done | Configuration → Ask past grantees for an update |
| 11 | A magic link clicked on a phone, from Outlook | not done | do it |
| 12 | Restore drill run against production | not done | `docs/RESTORE.md` |
| 13 | One grantee claim approved end to end | not done | do it |

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

---

## Not in scope for this launch

The 2026 application cycle. That opens a public form taking financial
documents from hundreds of strangers, and it does not go without the human
security review. The pilot can go without it because every grantee claim is
approved by a person before any award data is released, and thirteen known
organizations is a small, observable surface. That is a judgment, not a fact,
and it is yours to overrule.
