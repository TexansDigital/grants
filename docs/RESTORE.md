# Restoring from a nightly export

The nightly cron exports every table to R2 as NDJSON, with a manifest holding
row counts. This is how you put it back, and what the result does and does
not prove.

**A backup you have never restored is a hypothesis.** The procedure below has
been run end to end against a real export taken by the real scheduled handler,
into an empty database. It has not been run against the *preview* bucket's
nightly export, and it has never been run against production.

Production now exists and holds real grantee records, so the drill below is
owed. See **Drilling production** at the end.

---

## The procedure

    npm run backup:pull -- --out=./export --remote
    npm run restore -- --from=./export --persist-to=/tmp/steward-drill

The first pulls the most recent export (`d1/latest.json` points at it) out of
R2. Add `--prefix=d1/2026-09-21/040711` for an older one.

The second applies every migration to an empty database, loads the rows, and
checks what landed against the manifest. `--persist-to` is what makes it a
drill rather than a gamble: wrangler keeps that database somewhere else
entirely, so nothing touches the one you develop against.

It refuses any database whose name mentions production. There is no flag.

---

## Then rebuild the search index

**A restore leaves full-text search empty and does not say so.**

The export skips virtual tables, so `application_fts` comes back empty.
`application_search_state` is an ordinary table, restores perfectly, and
records every application as indexed. The result is a search that answers "no
results" to every question while reporting itself up to date. A reviewer
asking "have we ever funded youth mental health in Fort Bend County" gets a
confident no.

The restore script does not load `application_search_state`, and prints a
warning naming how many applications are unindexed. Rebuild it:

    await fetch('/api/search/reindex', { method: 'POST' }).then((r) => r.json())

Run from the browser console while signed in as an admin -- the route is
behind Cloudflare Access and curl from a terminal has no session to present.
Admin only, idempotent, and it writes an audit row. It rebuilds
every submitted application from what is stored, and clears the index entry of
anything sitting in draft. Applications it cannot rebuild are listed in the
response rather than skipped silently.

---

## Two things the drill found

Both were found by running it, not by reading the code, and both are fixed in
the script:

**Per-table files defeat deferred foreign keys.** An export is ordered by
table, not by dependency, so children legitimately precede parents. Deferred
foreign keys are checked at COMMIT — and a file per table is a commit per
table, so every child was checked while its parent was still two files away.
The whole load has to be one transaction.

**An "empty" database is not empty.** Migrations seed reference data —
`field_types`, `promotion_targets` — so the load hit a UNIQUE violation
against rows a migration had written seconds earlier. The export's copy is the
one that should win, so each table is emptied before its rows go in.

---

## What a green run establishes

That these bytes, from this export, reconstruct a database whose row counts
match the manifest table by table and whose foreign keys all resolve.

## What it does not

That the rows are **correct**. Row counts and foreign keys agree just as
happily with an export that was wrong in its values. Verifying values means
looking at a handful of real records and recognising them, which is a human
step.

That **R2 still holds the uploaded files**. The database stores object keys.
A restored database pointing at objects a lifecycle rule deleted is a restored
database with no financial statements behind it.

That the **preview or production** export is restorable. Only a drill against
that export, pulled from that bucket, says anything about that one.


---

# Drilling production

Production carries thirteen organizations' award history and their reports.
This is the drill that turns the nightly export from a hypothesis into
something you have seen work.

## Before you can run it at all

**An export has to exist.** `scheduledBackup` runs only from the cron, at
07:00 UTC -- 2am Central -- and there is no route to trigger it on demand. The
production Worker was deployed on 2026-10-04, so its first export is the
morning of 2026-10-05. Until then the backups bucket is empty and the pull
below will find nothing.

Check before you start:

    npx wrangler r2 object get steward-production-backups/d1/latest.json --file=/tmp/latest.json --remote

A file means there is an export to drill. A 404 means the cron has not run
yet, or ran and failed -- and the difference matters, so look at the Worker's
logs rather than assuming the former.

## The drill

    npm run backup:pull -- --out=./export-prod --remote --bucket=steward-production-backups
    npm run restore -- --from=./export-prod --persist-to=/tmp/steward-prod-drill

THE FIRST COMMAND USED TO BE REFUSED BY ITS OWN SCRIPT. pull-backup.mjs
rejected any bucket whose name contained "prod", so this runbook said to pass
`--bucket=steward-production-backups` and the script said no -- the drill was
unrunnable, and nobody found out until somebody followed these steps.

Reading an export is not writing to production. What CLAUDE.md protects is the
FILES bucket, which holds applicants' financial statements; that one is still
refused, and `scripts/lib/buckets.mjs` draws the line by what is in the bucket
rather than by what its name contains.

The restore refuses any database whose name mentions production and has no
flag to override it, so this cannot write to the thing it is proving. It
builds a scratch database somewhere else entirely and loads the export into
that.

## Then do the part a script cannot

The restore checks row counts against the manifest and that foreign keys
resolve. Both agree just as happily with an export that is wrong in its
values. So open the restored database and **recognise something**:

    npx wrangler d1 execute steward-preview --local --persist-to=/tmp/steward-prod-drill --json --command "SELECT o.legal_name, a.awarded_amount_cents, substr(a.awarded_at,1,10) FROM awards a JOIN organizations o ON o.id=a.organization_id ORDER BY o.legal_name"

THE NAME IS `steward-preview`, NOT the directory. This read the wrong way for
as long as this file has existed, and it fails outright: wrangler resolves a
database NAME against wrangler.toml, and `steward-prod-drill` is not in there.
What isolates the drill is `--persist-to`, which hands wrangler a different
directory to keep the file in. The name is only how wrangler finds the entry.

Thirteen organizations you can name, each at an amount you recognise, all
awarded 2025-12-03, plus the test award. If a name is wrong or an amount is
off by a factor of a hundred, the export is wrong and the row counts would
never have told you.

## What this drill still does not prove

**That R2 still holds the files.** The database stores object keys. A restored
database pointing at objects that are gone is a restored database with no
photographs and no financial statements behind it. The export covers D1 only.

**That search works.** Rebuild the index afterwards, against the real
production hostname, or a reviewer's question gets a confident "no results"
from an index that reports itself up to date.

NOT WITH curl. The route is behind Cloudflare Access, a terminal has no Access
session, and the request never reaches the handler. Sign in to Steward as an
admin, open the browser console, and run:

    await fetch('/api/search/reindex', { method: 'POST' }).then((r) => r.json())

The page already holds the Access cookie, so this is the one place a devtools
console is the simple answer rather than the clever one. There is no button
for it yet; there should be, and it is on the roadmap.

## When to run it again

After any migration that moves data rather than adding a column, and once a
year regardless. An export format drifts; the first time you need it is the
worst time to discover that.

---

# What the production drill found

Run 2026-10-05 against `d1/2026-10-05/070101`, the export the scheduled
handler wrote at 07:01 UTC that morning.

573 rows across 33 tables. Every table held exactly what the manifest claimed,
102 triggers came off and went back on, no foreign key was left dangling. The
thirteen organizations and their amounts were read back and recognised, which
is the half no script can do.

**The run also cost three corrections to this file**, all found by following
it rather than by reading it:

1. The verification step named the `--persist-to` directory as if it were a
   database, so the one step that checks the rows are recognisable failed
   outright.
2. The reindex step was a curl at a hostname behind Cloudflare Access, which
   never reaches the handler.
3. `pull-backup.mjs` refused any bucket whose name contained "prod", so the
   first command in the drill was rejected by its own script.

That is the argument for drilling a backup rather than trusting one, made
three times in two days. None of the three was visible from reading the code.

**Still not proven by any of it:** that R2 holds the files those rows point
at. The export covers D1 only, and a restored database pointing at objects a
lifecycle rule deleted is a restored database with no financial statements
behind it.
