# Phase 0 report

Definition of done, reported honestly. Where a claim is partial, it says so.

## 1. Migrations run clean from empty — MET (with a caveat)

`readD1Migrations` feeds the real numbered files to `applyD1Migrations` inside
workerd, against a real local D1, for every test file. `isolatedStorage` gives
each test a fresh migrated database.

**Caveat:** "fresh preview database" here means a local Miniflare D1, not a
remote preview D1. The migration splitter is the same one
`wrangler d1 migrations apply --remote` uses, so the `CREATE TRIGGER ... BEGIN
... END;` blocks are safe remotely, but no migration has been applied to a real
preview database yet. **A human must run `npm run migrate:preview` and confirm
it succeeds before Phase 1 relies on it.**

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
- `unindexStatements` still has no caller. Search now joins `applications` and
  filters `deleted_at`, so a stale index entry cannot surface — but the index
  itself is not pruned.
- `attachments.parent_type/parent_id` remains a polymorphic pointer with no
  per-type existence constraint.
- One person cannot represent two organizations: `users_email_uniq` is global
  and the role CHECK permits exactly one `organization_id`. A shared executive
  director or a fiscal sponsor breaks this. Cheap to fix now with a
  `user_organizations` join table; expensive after Phase 2.
- Soft-deleted organizations can still have live users and applications.
- `field_type` is a reference table, but `src/lib/fieldTypes.ts` still switches
  on a hardcoded union, so a new type is a row *plus* a code change to be
  renderable. The migration is gone; the code change is not.

**Security posture:** I cannot perform a security review and have not. A human
security review is required before the public form goes live. R2 does no malware
scanning; type and size validation is not safety. SPF, DKIM and DMARC on the new
domain are prerequisites for Phase 2, and no code can substitute for them.

**Scheduled D1 export to R2 must land before Phase 2**, not in Phase 7 as the
original plan had it. Phase 2 is the first moment this system holds real
third-party audited financial statements, and Time Travel is not a backup.
