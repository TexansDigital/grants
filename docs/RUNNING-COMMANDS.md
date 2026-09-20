# Running commands safely, with several projects on one machine

`npm run whoami`

Run it before anything that writes. It is read-only and prints, in order: which
project directory you are in, which Cloudflare account your credentials resolve
to, and **which database the default commands would touch**.

---

## The problem it solves

Wrangler finds an account from whichever credentials are available — an OAuth
login shared across every project on the machine, or a `CLOUDFLARE_API_TOKEN`
sitting in the environment. Nothing in `wrangler d1 execute` tells you which
account answered. So the command that drops a table looks identical whether it
lands on this project's preview database or on something else entirely, and you
find out afterwards.

With several projects open, the realistic mistake is not choosing the wrong
flag. It is being in the wrong directory, or having a token exported in one
terminal tab and not another.

## What it checks

- **The directory and the config.** A `wrangler.toml` that does not declare
  `name = "steward"` means you are somewhere else, whatever the prompt says.
- **`CLOUDFLARE_API_TOKEN`.** If it is set, it silently overrides your
  logged-in account — and the script cannot tell you whose token it is, so it
  warns rather than reassures.
- **The default bindings**, resolved from `wrangler.toml` itself: the database
  name, its id, its preview id, and every R2 bucket.
- **That `database_id` and `preview_database_id` match.** If they diverge,
  `--remote` and `--local` reach different databases and one of them is not
  preview. That is the specific way non-negotiable #2 gets broken by accident.
- **That no production id is committed.**
- **That your token carries the D1 scope.** The scopes an OAuth token holds are
  fixed when it is minted, so a token from an older wrangler reports a
  perfectly healthy login and then fails on the first
  `d1 migrations apply --remote` — with a permissions error that reads as
  though the database is missing rather than as though the token is.
  `npx wrangler logout && npx wrangler login` mints a new one.
- **R2 is different, and the script says so rather than warning.** Wrangler's
  OAuth flow does not request an R2 scope at all, so re-authenticating will
  never produce one. Create buckets in the Cloudflare dashboard (R2 → Create
  bucket); the Worker's own R2 bindings do not need the scope, because they
  bind at deploy time from `wrangler.toml`.

## The four targets

| | Flag | Hits |
|---|---|---|
| Local | `--local` | `.wrangler/state` in this directory. Safe, disposable. |
| Preview | `--remote` | The preview database. Shared, invented data. |
| Staging | `--env staging` | `steward-staging`. Holds **real past data**. |
| Production | `--env production` | Refuses to run until a human fills in the ids. |

Production is un-runnable from a clean checkout on purpose: the ids are
placeholders, `npm run check:config` fails if a real one is ever committed, and
a deploy is a deliberate act by a person who filled them in for that one
command.

## Two habits worth having

**Never put `CLOUDFLARE_API_TOKEN` in your shell profile.** Export it in the one
terminal that needs it, for as long as it needs it. A token in `.zshrc` is
active in every tab, for every project, forever.

**Read the database name out loud before pressing enter** on anything
destructive. There is no flag that makes a mistake here reversible: D1's Time
Travel is a 30-day in-place restore, not an undo, and it does not help at all if
you were pointed at the wrong database.

---

## The self-test: proving an upload reaches R2

**Why this exists.** Whether R2 accepts a presigned PUT cannot be proven from
this repository. The browser harness intercepts the request, so what is tested
is its shape — a PUT carrying no `Content-Type`, which is the rule R2 punishes
with a 403 that does not reproduce in curl. The rest needs real credentials, a
real bucket, and a human. This is that test.

**It runs in its own program.** `community-futures-fund` was written as the
Phase 0 proof that adding a program needs no migration, and it is used here so
that nothing invented ever lands in Inspire Change. Its only cycle is status
`draft`, so it cannot appear on the public open-cycles page — a fabricated
grant programme advertised to nonprofits would be a genuinely bad outcome.

**The metrics in `docs/selftest-metrics.csv` are invented.** They are not the
Foundation's and must never be treated as them. When the real metrics arrive
they go into Inspire Change, which this leaves untouched.

### The sequence

1. **Seed the program.**

   ```
   npx wrangler d1 execute steward-preview --remote --file=seeds/community-futures-fund.sql
   ```

2. **Load the invented metrics.** Dry run first; it writes nothing.

   ```
   npm run metrics -- --program=community-futures-fund --file=docs/selftest-metrics.csv --preview
   npm run metrics -- --program=community-futures-fund --file=docs/selftest-metrics.csv --preview --apply
   ```

3. **Build and publish the report form.** Configuration → *Build a report form
   from this program's metrics* → read it → **Publish**.

4. **Import the award.** Configuration → *Import grants from a spreadsheet* →
   `docs/selftest-award.csv` → Check → Import.

   Its term ran to **31 August 2026**, which is deliberate: a report opens on
   the term end date and is due ninety days later, so this one is open now
   rather than in 2027.

5. **Create the obligation.** Reporting → *Create missing report obligations*.
   Expect one final report, open, due late November 2026.

6. **File it as the grantee.** Sign in at `apply.houstontexansfoundation.org`
   with the address in the CSV, open the report, **attach a file**, and send it.

7. **Confirm the object exists.** Cloudflare → R2 → `steward-preview-files`.
   There should be one object under `org/<organization id>/`.

   That last step is the whole point. Everything before it has been proven in a
   browser against a local database; only this proves R2 accepted the upload.

### If the upload fails

A `403` in the browser console is almost always one of the two documented
traps: a `Content-Type` sent by the browser, or a CORS rule that does not
admit the origin. `config/r2-cors.json` holds the rules, and
`DECISIONS.md` §31 holds the third trap, which was the page's own
Content-Security-Policy refusing the request before it was ever made.

### Afterwards

The fixture is invented data in a program nothing else uses. Leave it or
soft-delete it; nothing in Inspire Change depends on it either way.
