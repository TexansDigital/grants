# Restoring from a nightly export

The nightly cron exports every table to R2 as NDJSON, with a manifest holding
row counts. This is how you put it back, and what the result does and does
not prove.

**A backup you have never restored is a hypothesis.** The procedure below has
been run end to end against a real export taken by the real scheduled handler,
into an empty database. It has not been run against the *preview* bucket's
nightly export, and it has never been run against production, which does not
exist yet.

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

    curl -X POST https://grants.houstontexansfoundation.org/api/search/reindex

Admin only, behind Access, idempotent, and it writes an audit row. It rebuilds
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
