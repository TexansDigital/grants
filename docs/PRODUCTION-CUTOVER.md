# Production cutover

The one-time move from the preview database to a real production environment.

Read this whole file before running anything. Every command here is **run by a
human**. Nothing in this runbook is automated, and nothing in it should be run
in a hurry.

## Why this exists

Until now everything has run on `steward-preview`: one D1 database, two R2
buckets, one KV namespace, all bound by the *default* environment in
`wrangler.toml`, and served by a Worker named `steward` on
`apply.houstontexansfoundation.org` and `grants.houstontexansfoundation.org`.

That was correct while the only data was test data. It stops being correct the
moment a real nonprofit's award history lands in it, because the name
`steward-preview` invites someone, later, to reset it.

Production is a **separate Worker** (`steward-production`) with its own
database, buckets, KV, secrets and Access policy. The hostnames move to it at
the end. Until they move, production is unreachable, which is what makes it
safe to build and verify before cutting over.

## Before you start

- **Do this while there are no real users.** The cutover is a hostname swap
  with a short window where the site is briefly the new Worker with an empty
  database. That is fine today and expensive later.
- **Nothing is copied from preview.** Production is seeded from the same
  committed seed files the preview database was built from. Test
  organizations, test applications, the test award and `FY26 fall test` are
  left behind deliberately.
- **`Community Futures Fund` does not go to production.** It is the Phase 0
  proof (`src/seed/secondProgram.ts`), a hypothetical program that exists so
  the test suite can verify a new program needs no schema change.

---

## Phase A — Create the resources

Nothing is deployed and nothing is routed. This only creates empty things.

```
npx wrangler d1 create steward-production
npx wrangler r2 bucket create steward-production-files
npx wrangler r2 bucket create steward-production-backups
npx wrangler kv namespace create SESSIONS --env production
```

Each prints an id. Keep all four; Phase B needs them.

FILES and BACKUPS are separate buckets on purpose. One nightly export contains
every organization's data, and keeping it beside applicant uploads means a
single bucket-level mistake exposes both.

**Verify:** `npx wrangler d1 list` shows `steward-production`, and
`npx wrangler r2 bucket list` shows both buckets.

---

## Phase B — Configuration and secrets

**B1. Fill in the four ids** in the `[env.production]` block of
`wrangler.toml`, replacing each `FILL_IN_AT_DEPLOY_TIME_DO_NOT_COMMIT`:

| Binding | Value |
|---|---|
| `[[env.production.d1_databases]]` → `database_id` | the D1 id from Phase A |
| `[[env.production.r2_buckets]]` FILES → `bucket_name` | `steward-production-files` |
| `[[env.production.r2_buckets]]` BACKUPS → `bucket_name` | `steward-production-backups` |
| `[[env.production.kv_namespaces]]` SESSIONS → `id` | the KV id from Phase A |

**What production inherits and what it does not.** Wrangler splits config in
two, and the split is not obvious. `[assets]`, `[observability]`, `main` and
`compatibility_date` are **inherited**, so production serves the React bundle
without declaring anything. `routes` is inherited too, which is exactly why
production sets `routes = []` explicitly -- without that line it would inherit
the live hostnames and reassign them the first time anyone deployed it.
Bindings and vars are **not** inherited: `[vars]`, `d1_databases`,
`kv_namespaces` and `r2_buckets` must each be declared for production or they
are simply absent. All four now are, and `check:config` fails the build if a
var is ever added to the default environment without reaching production.

These are committed. They are identifiers, not credentials — useless to anyone
without account access, and committing them is what makes the deploy
reproducible. The protection that matters is elsewhere and stays: `routes = []`
on the production environment, and the explicit `--env production` flag on
every command that touches it.

**B2. Set the production secrets.** Secrets are per-environment; nothing
carries over from the default environment.

```
npx wrangler secret put SESSION_SIGNING_KEY --env production
npx wrangler secret put RESEND_API_KEY --env production
npx wrangler secret put R2_ACCESS_KEY_ID --env production
npx wrangler secret put R2_SECRET_ACCESS_KEY --env production
npx wrangler secret put TURNSTILE_SECRET_KEY --env production
```

`SESSION_SIGNING_KEY` should be **new**, not the preview one. Reusing it means
a session minted against preview data would validate against production.

Generate one with:

```
openssl rand -base64 48
```

**Verify:** `npm run check:config` passes, and
`npx wrangler secret list --env production` lists all five.

---

## Phase C — Migrations on an empty database

```
npx wrangler d1 migrations apply steward-production --remote --env production
```

This is Definition of Done #1: migrations run clean from empty. If any
migration fails here, stop — do not patch it by hand and do not edit an
applied migration. Write a new one.

**Verify:** the table list comes back complete and every table is empty.

```
npx wrangler d1 execute steward-production --remote --env production --json --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

`--json` is required. A bare `wrangler d1 execute --remote` fails with a 7403.

---

## Phase D — Seed configuration, and only configuration

Production gets programs, stages, forms, metrics and admins. It gets no
applications, no organizations, no awards and no cycles with data in them.

**D1. Inspire Change program, stages and forms:**

```
node scripts/apply-sql.mjs --file=seeds/inspire-change.sql --db=steward-production --remote
```

**D2. The report form.** `reportform:build` writes SQL to **stdout**, not to a
file, so it has to be redirected. Checked by running it, because the runbook
originally told you to apply a `seeds/report-form.sql` that nothing ever
creates.

```
npm run reportform:build > seeds/report-form.sql
node scripts/apply-sql.mjs --file=seeds/report-form.sql --db=steward-production --remote
```

**D3. Two admin accounts.** CLAUDE.md treats a single admin as a continuity
failure, not a preference. `admin:sql` takes the addresses as **arguments** --
it writes no file without them, and the resulting seed grants exactly those
people staff access, so read the list before you run it.

```
npm run admin:sql -- first.admin@example.org second.admin@example.org
node scripts/apply-sql.mjs --file=seeds/admins.sql --db=steward-production --remote
```

**D4. Impact metrics**, if the program's metric definitions are ready.

**Verify:** counts are what you expect and nothing transactional came along.

```
npx wrangler d1 execute steward-production --remote --env production --json --command "SELECT (SELECT COUNT(*) FROM programs) programs, (SELECT COUNT(*) FROM form_definitions WHERE status='published') forms, (SELECT COUNT(*) FROM users WHERE role='admin') admins, (SELECT COUNT(*) FROM applications) apps, (SELECT COUNT(*) FROM awards) awards, (SELECT COUNT(*) FROM organizations) orgs"
```

`apps`, `awards` and `orgs` must all be **0**. If they are not, something was
copied that should not have been.

---

## Phase E — Deploy and cut over

**E1. Deploy, still unrouted:**

```
npm run build:web
npx wrangler deploy --env production
```

`routes = []` means the new Worker answers on nothing yet. This is deliberate:
the hostname move is a separate, conscious act.

**E2. Move the hostnames.** In `[env.production]`, set:

```
routes = [
  { pattern = "grants.houstontexansfoundation.org", custom_domain = true },
  { pattern = "apply.houstontexansfoundation.org", custom_domain = true }
]
```

Then remove those same two routes from the default environment's `routes`, so
the old Worker stops claiming them, and deploy production again.

Deploying production with those routes while the default Worker still holds
them will reassign them. Removing them from the default environment first
makes the handover explicit rather than a race.

**E3. Re-point Cloudflare Access.** The policy protecting
`grants.houstontexansfoundation.org` follows the hostname, not the Worker, so
it should carry over — **confirm it, do not assume it**. An unprotected staff
surface is the worst outcome of this whole runbook. See `docs/ACCESS-SETUP.md`.

**Verify, in this order:**

1. `npm run golive` — hostnames, CSP, trial-cycle check
2. Open `grants.houstontexansfoundation.org` in a private window. You must be
   challenged by Access. If you are not, **stop and fix it before anything
   else.**
3. Open `apply.houstontexansfoundation.org`. It should show no open cycles.
4. Sign in as an admin and confirm the seeded forms render.

**Rollback:** put the two routes back on the default environment and redeploy
it. The preview Worker and its data are untouched throughout.

---

## Phase F — Load the real data

Only after Phase E is verified.

1. **Import the thirteen 2025 grantees.** Awards → Import,
   `docs/inspire-change-2025-grants.csv`. Read the preview, confirm the
   organization count reads 13, then commit.
2. **Request updates.** Configuration → Ask past grantees for an update. Set
   the awarded-date window and a due date. **Dry run first** and check the
   matched count before running it for real.
3. **Email the thirteen**, pointing at `/tell-us`. Send four, check
   Resend → Emails for bounces, then send the remaining nine.
4. **Approve claims** as they arrive.

---

## What this runbook does not do

- **It does not verify security.** A human review is still owed before the
  public application form takes real applications.
- **It does not test restore.** `docs/RESTORE.md` describes the drill. Run it
  against production once, deliberately, before you rely on the nightly
  export.
- **It does not warm the sending domain.** `houstontexansfoundation.org` is
  new enough that SpamAssassin still applies `FROM_FMBLA_NEWDOM28`. That decays
  on its own; the mitigation is to send in small batches and watch bounces.
