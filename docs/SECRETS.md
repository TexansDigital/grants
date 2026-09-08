# Secrets

Secrets live in Wrangler secrets and nowhere else. Not in `wrangler.toml`, not in a
committed `.env`, not in a code comment, and never echoed into a log or an error
response. `src/lib/errors.ts` redacts by key name at every depth before anything
reaches `error_log`, but redaction is a backstop, not a licence.

## Setting a secret

    npx wrangler secret put RESEND_API_KEY
    npx wrangler secret put RESEND_API_KEY --env production

## The secrets this system will need

| Name | Used for | Phase |
|---|---|---|
| `SESSION_SIGNING_KEY` | Signing session cookies and magic-link tokens | 2 |
| `RESEND_API_KEY` | Transactional email (confirmations, magic links, decisions) | 2 |
| `R2_ACCESS_KEY_ID` | Presigning R2 PUT and GET URLs via aws4fetch | 2 |
| `R2_SECRET_ACCESS_KEY` | Same | 2 |
| `TURNSTILE_SECRET_KEY` | Verifying Turnstile tokens on public endpoints | 2 |
| `ELOQUA_CLIENT_ID` / `ELOQUA_CLIENT_SECRET` | Marketing opt-in sync and bulk reminders | 7 |
| `IRS_BMF_API_KEY` | EIN verification source, if the chosen source needs one | 2 |

None of these exist yet. Phase 0 introduces no outbound integration.

## Local development

Local secrets go in `.dev.vars`, which is gitignored. Use obviously fake values.
Never copy a production secret into a local file.

## Rotation

There is no rotation runbook yet. That is a known gap, owned by whoever holds
the second admin account (open decision #7).
