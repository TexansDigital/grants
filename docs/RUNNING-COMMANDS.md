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
