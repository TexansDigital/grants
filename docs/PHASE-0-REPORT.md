# Phase 0 report

Definition of done, reported honestly. Where a claim is partial, it says so.

## 1. Migrations run clean from empty — MET, verified on real D1

`readD1Migrations` feeds the real numbered files to `applyD1Migrations` inside
workerd, against a real local D1, for every test file. `isolatedStorage` gives
each test a fresh migrated database.

**Verified remotely on 2026-09-08.** All five migrations applied in order to the
`steward-preview` D1 (region WNAM), 95 commands total, no errors and no skipped
statements. The remote schema census is byte-identical to local:

| | local | remote |
|---|---|---|
| indexes | 43 | 43 |
| tables | 23 | 23 |
| triggers | **27** | **27** |

The trigger count was the risk worth checking. Triggers are the enforcement
mechanism for append-only logging, published-form immutability, the
retired-to-draft block, cross-program referential integrity, and the per-cycle
application limit. A splitter that mishandled `CREATE TRIGGER ... BEGIN ...
END;` would have left the remote database missing those guarantees while every
local test still passed.

A live probe confirmed enforcement rather than mere presence: inserting an
`error_log` row and then updating it was rejected by real D1 with
`error_log is append-only: rows cannot be updated` (`SQLITE_CONSTRAINT_TRIGGER`,
code 7500). One probe row remains in the preview `error_log`, which is correct —
the table has no delete path by design.

## 2. Authorization rules have passing tests — MET for the library, NOT for routes

Verified by mutation: removing `AND organization_id = ?` fails tests; changing
404 to 403 fails tests; a soft-deleted row is now hidden; `assertOwnedByExternalSession`
refuses internal roles; `searchApplications` refuses external sessions; and a
`PRAGMA table_info` test asserts every `applications` column is classified as
applicant-safe or internal, so a newly added internal column cannot slip in.

**Not met:** there are no HTTP routes yet, so these are library tests, not
enforcement tests. `src/index.ts` has one `/health` route and no tests. The
reviewer branch of `getApplicationForStaff` cannot be exercised until
`review_assignments` exists in Phase 3; it fails closed until then.

## 3. Money paths checked for integer cents — MET

- `parseCurrencyToCents` uses string arithmetic; ~60 adversarial inputs rejected.
- The end-to-end fixture uses `$19,999.99`, chosen because float math does NOT
  survive it. The original suite used `$25,000.07`, which `x * 100` happens to
  produce exactly — so it passed against a deliberately broken parser.
- `assertCents()` is called at the binding site, because a database CHECK
  **cannot** reject the string `'2500007'`: SQLite applies TEXT→INTEGER affinity
  before the CHECK runs.
- `value_int` carries a range bound; a currency answer may not populate
  `value_text`, `value_real` or `value_json`.

## 4. Audit rows for every mutating action — MET

Every insert in the seeder now audits, including `program_stage.created`,
`form_section.created` and `form_field.created` (34 field rows per Inspire
Change seed). A login-capable user gets its own `user.created` row.

Two properties are tested rather than asserted:
- **Atomicity:** a batch that fails mid-flight leaves zero audit rows.
- **Guarding:** on the losing side of a concurrent submit, the audit row is
  suppressed along with the mutations. An audit trail that records events which
  did not happen is worse than none, because it is believed.

## 5. Verification step performed — MET, and narrower than first claimed

The schema-snapshot test is a weak assertion on its own: the seeder emits only
INSERTs, so the schema is identical by construction. It is kept as a tripwire.

The load-bearing verification is now the vocabulary boundary:
- a **new field type** (`date`) is a row in `field_types`, not a migration;
- a **new promotion target** is a row in `promotion_targets`, not a migration;
- a program with **no applicant organization** (a scholarship) can be published,
  because the required promotion set is per-program configuration.

**Needs a human:** nothing in Phase 0 requires a browser or a device. Phase 2
does, and that verification stands as written — three friendly organizations
submitting on their own devices.

## 6. Known gaps, shortcuts, and technical debt

**Not built, deliberately:**
- No HTTP routes beyond `/health`. No authentication of any kind.
- No version-minting. Publication is one-way and immutable, but
  "create version N+1 from N" does not exist. `form_definition.version_created`
  is an audit verb with no code behind it.
- `gate_on_prior_decision` and `prior_application_id` are stored and read by
  nothing. Phase 2/3 consume them.
- No seeding command. Seeding is TypeScript invoked from a Worker; wiring it to
  a CLI is Phase 1.

**Known weaknesses:**
- `unindexStatements` still has no caller. Search joins `applications` and
  filters `deleted_at` and `withdrawn`, so a stale index entry cannot surface —
  but the index itself is not pruned. The natural caller is the withdraw
  endpoint, which is Phase 2.
- **One person cannot represent two organizations.** `users_email_uniq` is
  global and the role CHECK permits exactly one `organization_id`. A shared
  executive director, a fiscal sponsor, or a grant consultant working for two
  nonprofits breaks this. Fixing it means a `user_organizations` join table and
  a change to session scoping — the part of the system that must not be wrong.
  Cheap now, expensive after Phase 2 holds real applications.
  **This is a decision for a human, not a defect I should fix unilaterally.**
- `field_type` and `maps_to` are reference tables, but `src/lib/fieldTypes.ts`
  still switches on a hardcoded union and `src/lib/mapsTo.ts` holds the column
  maps. A new field type is a row *plus* a code change to be renderable. The
  migration is gone; the code change is not. Drift between the two now fails a
  test rather than failing silently.

**Closed after the review, before Phase 1:**
- `attachments.parent_type/parent_id` now has a per-type existence trigger.
- An organization can no longer be soft-deleted while live applications or
  users still point at it.
- Vocabulary drift between the reference tables and the code is now a test
  failure.

**Security posture:** I cannot perform a security review and have not. A human
security review is required before the public form goes live. R2 does no malware
scanning; type and size validation is not safety. SPF, DKIM and DMARC on the new
domain are prerequisites for Phase 2, and no code can substitute for them.

**Preview D1 exists; R2 and KV do not yet.** `wrangler.toml` still names
`steward-preview-files` and `steward-preview-sessions`, which have not been
created. Phase 2 needs both; Phase 1a needs neither.

**Scheduled D1 export to R2 must land before Phase 2**, not in Phase 7 as the
original plan had it. Phase 2 is the first moment this system holds real
third-party audited financial statements, and Time Travel is not a backup.
