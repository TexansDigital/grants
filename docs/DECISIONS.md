# Decisions made during Phase 0

These were made to keep the build moving. Each is cheap to reverse now and
expensive to reverse after Phase 2 holds real applications.

## 1. A published form definition is immutable

Editing a published form mints a new version. Enforced by triggers in migration
`0003`, not by convention.

**Why.** An edited label on a 2026 form silently changes the meaning of a 2024
application. These are financial records read years later, sometimes by people
reconstructing why a grant was awarded.

**Cost if wrong.** An admin who wants to fix a typo mid-cycle has to publish a
new version, and applications already in flight stay pinned to the old one.
That is more friction than editing in place.

**To reverse.** Drop the `*_after_publish` triggers and allow in-place edits.
Do it before real applications exist, not after.

## 2. The Inspire Change seed is structurally complete, not copy-faithful

Every field in the reference list exists with the right type, validation, and
`maps_to` target. Exact labels, help text, and option wording still need to
come from the Formstack export.

**Why.** The brief describes the fields in prose, not as exact strings. Guessing
at applicant-facing copy and shipping it as if it were confirmed would be a
false green light.

**To close.** Content entry against existing rows. Not a schema change.

## 3. A multi-stage program creates one application row per stage

An LOI and its invited full application are two rows linked by
`prior_application_id`.

**Why.** Each stage's submitted state stays frozen and auditable. Prefilling the
full application from the LOI becomes an explicit copy with an audit row rather
than an in-place overwrite of an already-submitted record.

**Cost if wrong.** "Show me this organization's journey" is a chain walk rather
than a single row read.

## 4. Search is an aggregate document, populated at submit

One FTS5 row per application, not an external-content index over
`application_answers`.

**Why.** Two reasons, in migration `0005`. The useful unit of search is the
application, not the answer fragment. And autosave writes every few seconds, so
trigger-driven index maintenance would rebuild continuously for drafts nobody
searches.

**Consequence.** Drafts are not searchable. Staff search submitted work, so this
is correct rather than merely acceptable.

## 5. `value_int` and `value_real` are separate columns

The data model in the brief specified a single `value_number`.

**Why.** A column named `value_number` takes REAL affinity in SQLite. That is
precisely how a grant amount silently becomes a float. Currency and integer
field types write to `value_int` only, and a `typeof()` CHECK makes a float
physically unable to land there.

## 6. Audit and error logging are Phase 0 deliverables

The phase list left them implicit until later.

**Why.** Phase 0 introduces no mutating endpoints, so the definition of done
would be unfalsifiable for the first phase. Landing the tables, the helpers, and
the org-scoping helper now means Phase 1 cannot be built without going through
them.

## Still open, and now blocking sooner than the brief implies

- **Grace rule for late drafts (open decision #6).** Implemented as a per-cycle
  `draft_grace_hours`, defaulted to 0 (hard cutoff). Someone has to choose the
  real value before Phase 2 opens a cycle.
- **Declined applicants keeping portal access (open decision #4).** Has a schema
  implication for `users.is_active`. Wanted before Phase 2, not during it.
