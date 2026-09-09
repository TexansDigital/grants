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

`RESEND_API_KEY` is now live code. The rest do not exist yet.

## Email: what the absence of a key does

`RESEND_API_KEY` is deliberately **unset in preview and staging**, and that
absence is a safety property rather than an oversight:

- With no key, `transportFor()` returns null, `sendEmail()` records every send
  as `suppressed` in `email_messages`, and nothing is called. A preview run or
  a test cannot mail a real applicant.
- Staging additionally sets `EMAIL_FROM = ""`, so a send there throws rather
  than delivering. Staging holds the friendly-organization fixtures, whose
  addresses reach real people.
- `npm run check:config` fails the build if any of these names is assigned in
  `wrangler.toml`, and if staging's `EMAIL_FROM` is ever given a value.

Setting the key on an environment is therefore the single action that makes
that environment able to email real people. Treat it as a deploy step with a
human in it, not a convenience.

**Before setting it in production**, SPF, DKIM and DMARC must be published on
`houstontexansfoundation.org` and the domain verified in Resend. Deliverability
is not solved by code: a grantee who cannot receive a login link cannot file a
report. Step-by-step walkthrough: `docs/EMAIL-DNS-SETUP.md`.

## Local development

Local secrets go in `.dev.vars`, which is gitignored. Use obviously fake values.
Never copy a production secret into a local file.

## Rotation

There is no rotation runbook yet. That is a known gap, owned by whoever holds
the second admin account (open decision #7).
