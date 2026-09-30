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

## Where each value comes from

Nobody wrote this down, and at cutover the question "where am I pasting from?"
arrived with a live prompt already waiting. The answer differs per secret, and
three of the four cannot be read back once created.

| Secret | Where to get it | Readable again later? |
|---|---|---|
| `SESSION_SIGNING_KEY` | Generate it: `openssl rand -base64 48` | Never needs to be. Pipe it straight into `wrangler secret put` so it touches no clipboard and no shell history. |
| `RESEND_API_KEY` | resend.com, API Keys, Create. "Sending access" is enough. | **No.** Shown once. |
| `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` | Cloudflare dashboard, R2 Object Storage, API, Manage API tokens, Create. | **No.** The secret half is shown once. |
| `TURNSTILE_SECRET_KEY` | Cloudflare dashboard, Turnstile, the widget, Settings. | **Yes.** This is the only one you can go and re-read. |

**You cannot recover a value from wrangler.** `wrangler secret list` prints
names, never values. So a secret set in preview and not saved elsewhere is
gone, and production needs a freshly created one -- which is the better shape
anyway: a production credential should be revocable without taking preview
down with it.

**The signing key must be NEW for production.** Reusing preview's would let a
session minted against test data validate against production.

**Scope the R2 token to the production buckets only** --
`steward-production-files` and `steward-production-backups`, Object Read &
Write -- rather than granting it the whole account. A leaked production token
then cannot reach preview, and the reverse holds too.

**Turnstile is deliberately the SAME widget as preview.** A Turnstile widget
binds to hostnames, and `apply.` and `grants.` do not change at cutover; they
move from one Worker to another. The site key in `wrangler.toml` is the public
half of that widget, so the secret must be that same widget's secret.

**Set them one at a time.** `wrangler secret put` reads from stdin, so a
pasted block of several commands feeds the next command line into the previous
prompt as its value. You get a secret whose value is a command string, no
error, and a failure that surfaces much later as something unrelated. If you
are ever unsure whether a value landed, set it again: `secret put` overwrites,
so re-running is free and always cheaper than wondering.

## Email: what the absence of a key does

> **THIS NO LONGER DESCRIBES THE DEFAULT ENVIRONMENT. Read this first.**
>
> `RESEND_API_KEY` **is set** on the default (preview-bound) Worker, and has
> been since deliverability testing. The deployed `steward` Worker on
> `apply.houstontexansfoundation.org` sends real email to real addresses. It
> was proven on 2026-09-30 by a live magic link delivered to mail-tester.
>
> So the safety property below — "a preview run cannot mail a real applicant"
> — **is gone for the deployed default environment**. It still holds for a
> local `wrangler dev` run and for the test suite, neither of which has the
> key.
>
> What this costs: any e2e harness driven against the deployed default Worker
> mails whatever address it is given. The harnesses use `@example-*.org`
> fixtures that bounce harmlessly, but a real address typed into one of them
> reaches a real person.
>
> Once production exists, the default environment should have its key
> **removed** and testing should move to a surface that cannot mail anyone.
> Tracked in `docs/ROADMAP.md`.

`RESEND_API_KEY` was originally **unset in preview and staging**, and that
absence was a safety property rather than an oversight:

- With no key, `transportFor()` returns null, `sendEmail()` records every send
  as `suppressed` in `email_messages`, and nothing is called. A run without a
  key cannot mail a real applicant. This still describes local development and
  the test suite. It no longer describes the deployed default Worker.
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
