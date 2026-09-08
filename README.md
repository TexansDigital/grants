# Steward

A multi-program grantmaking platform on Cloudflare. Intake, review, award,
payment, grantee reporting, and reporting out, for any number of grant programs.

Inspire Change is the first program on it. Nothing about Inspire Change is
hard-coded: every program defines its own stages, form, rubric, metrics, and
compliance policy as data.

See `CLAUDE.md` for the full architecture, constraints, and phase plan.

## Status

**Phase 0 — schema and form engine.** Complete. See `docs/PHASE-0-REPORT.md` for
what was verified and what was not.

## Layout

    migrations/       numbered D1 migrations, applied in order, never edited
    src/lib/          audit, errors, scoping, money, form engine, search
    src/seed/         program specs as data, plus the generic seeder
    test/             runs in workerd against a real local D1
    docs/             decisions, secrets, phase reports

## Commands

    npm test              full suite in a real Workers runtime against local D1
    npm run typecheck     Worker/test typecheck, then tooling typecheck
    npm run migrate:local apply migrations to the local preview database
    npm run dev           wrangler dev against preview bindings

## Environments

`wrangler.toml` points at **preview** bindings by default and there is no usable
production binding in the file. The `[env.production]` block carries deliberately
invalid placeholder ids so a careless `--env production` fails loudly rather than
touching real data. Production holds real EINs, audited financial statements, and
operating budgets belonging to other organizations.

Migrations are numbered files in `migrations/`, checked into git, applied in
order. Never edit a migration that has been applied; write a new one.

## Money

All money is integer cents, everywhere, with no exceptions. `src/lib/money.ts`
parses using string arithmetic so `25000.07` cannot become `2500006.9999999995`,
and `typeof()` CHECK constraints on every `*_cents` column mean a float is
physically unable to reach the database.
