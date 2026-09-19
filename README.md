# Steward

A multi-program grantmaking platform on Cloudflare. Intake, review, award,
payment, grantee reporting, and reporting out, for any number of grant programs.

Inspire Change is the first program on it. Nothing about Inspire Change is
hard-coded: every program defines its own stages, form, rubric, metrics, and
compliance policy as data.

See `CLAUDE.md` for the full architecture, constraints, and phase plan.

## Getting set up on your own machine

Everything below assumes you are **inside the project directory**. `npm run`
reads `package.json` from wherever you are standing, so running it from your
home directory gives you `ENOENT: no such file or directory, open
'/Users/you/package.json'` — that is npm saying "you are not in a project",
not anything being broken.

    git clone https://github.com/TexansDigital/grants.git
    cd grants
    npm install

Then, once, and before anything that writes:

    npm run whoami

It prints which Cloudflare account your credentials resolve to and **which
database the default commands would touch**. It is read-only. With several
projects on one machine that check is the difference between a command landing
where you meant and landing somewhere else — see `docs/RUNNING-COMMANDS.md`.

If you would rather not have to be in the directory, the same check runs from
anywhere by path:

    bash ~/grants/scripts/preflight.sh

## Status

**The applicant path is complete end to end** — eligibility, sign-in,
autosaving draft, uploads, review, submit, confirmation email. Grantee
reporting is in progress. See `docs/ROADMAP.md` for what is built, what is
built but unreachable, and what has never been exercised for real;
`docs/BLOCKED-ON-YOU.md` for what the Foundation still owes.

## Layout

    migrations/       numbered D1 migrations, applied in order, never edited
    src/lib/          audit, errors, scoping, money, form engine, search
    src/seed/         program specs as data, plus the generic seeder
    test/             runs in workerd against a real local D1
    docs/             decisions, secrets, phase reports

## Commands

    npm run whoami        which account and which database am I about to touch
    npm test              full suite in a real Workers runtime against local D1
    npm run verify        config check, typecheck, then the full suite
    npm run typecheck     Worker/test typecheck, then tooling typecheck
    npm run migrate:local apply migrations to the local preview database
    npm run dev           wrangler dev against preview bindings
    npm run e2e:applicant drive the applicant path in a real browser

Every one of these must be run from inside the project directory.

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
