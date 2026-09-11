# Importing past awards

Two files, both CSV. Fill the headers exactly as given; the importer matches on
header text, not position, so column order does not matter and extra columns
are ignored rather than rejected.

**Do not send me the real files.** Fill them locally and run the import
yourself, the same arrangement as the applications import. Everything here is
built and tested against invented fixtures.

---

## 1. Awards — `docs/awards-import-template.csv`

One row per award. Two years is roughly 50 to 200 rows, which is a morning's
work in a spreadsheet and is the single highest-value thing you can hand over:
nothing in grantee reporting can start until awards exist.

| Column | Required | Notes |
|---|---|---|
| `external_reference` | **yes** | Your own id for this award — a row number, a grant number, anything stable and unique. This is what makes the import **idempotent**: run the file twice and nobody is awarded twice. If you have no id, `IC-2025-001` style is fine. |
| `organization_name` | **yes** | As you hold it. Used to create the organization if the EIN is new. |
| `ein` | **yes** | Nine digits. Dashes, spaces or neither — all accepted. This is how an award finds its organization, and how the same nonprofit across two years becomes one record rather than two. |
| `program_slug` | **yes** | `inspire-change` for all of these unless you ran something else. |
| `fiscal_year` | no | Four digits. Used to pick the cycle when one exists. |
| `awarded_amount` | **yes** | Dollars. `25000`, `$25,000`, `19999.99` all work. Stored as integer cents. |
| `awarded_date` | **yes** | `YYYY-MM-DD`. The date the decision was made. |
| `announcement_date` | no | When it could be announced publicly, if that differed. |
| `term_start`, `term_end` | no | **Strongly recommended.** Report due dates are generated from these. Without them every report period has to be entered by hand. |
| `is_multi_year` | no | `yes`/`no`. Default no. |
| `parent_external_reference` | no | For year two of a multi-year grant, the `external_reference` of year one. Renewals link; they are never duplicated records. |
| `agreement_signed_date` | no | Blank means outstanding, and shows up in the data-health view. |
| `w9_received_date` | no | Same. |
| `media_release_date` | no | Same. |
| `grantee_contact_name` | **yes** | The person who will file reports. |
| `grantee_contact_email` | **yes** | **This is their login.** Get it right — there is no password and no alternative route in. An address that no longer works means that grantee cannot report. |
| `grantee_contact_phone` | no | |
| `status` | no | `pending`, `active`, `completed`, or `cancelled`. Defaults to `active`. |
| `notes` | no | Anything a human should see. Never shown to the grantee. |

### What the importer does with a row

- **Matches the organization by EIN.** An existing one is reused; a new one is
  created. This is a deliberate, admin-run path — it does **not** go through
  the public eligibility screen, which treats an EIN as identifying but never
  as proof that somebody may act for an organization.
- **Creates a grantee user** for `grantee_contact_email`, so they can sign in.
- **Refuses the whole file** if any row is unusable, and says which row and
  why. A half-applied import of financial records is worse than none.
- **Runs dry by default.** The first pass reports what it would do; you look at
  it, then run it for real.

### Rows it will refuse

- An EIN that is not nine digits.
- A duplicate `external_reference` inside the file.
- `parent_external_reference` pointing at a row that is not in the file and not
  already imported.
- An amount that is not a positive number.
- A `term_end` before its `term_start`.
- A missing contact email.

---

## 2. Impact metrics — `docs/metrics-import-template.csv`

One row per thing you ask grantees to count. These become fields on the report
form, and the values grantees enter become the aggregate numbers in board
reporting — so the list here is what you will be able to report on, and nothing
else.

| Column | Required | Notes |
|---|---|---|
| `metric_key` | **yes** | A short stable id: `individuals_served`. Lower case, underscores. Never changes once reported against. |
| `label` | **yes** | The question as a grantee reads it. |
| `help_text` | no | One line under the label. Use it to say what counts — this is where "unique individuals, not visits" belongs, and it is the difference between a number you can add up and one you cannot. |
| `metric_type` | **yes** | `integer` (a count), `currency` (dollars), `decimal` (a rate or average), or `text` (a description, never aggregated). |
| `unit` | no | `people`, `meals`, `hours`. Shown next to the field. |
| `is_required` | no | `yes`/`no`. Default no. |
| `sort_order` | no | Whole number. Order they appear on the form. |

### One thing worth deciding before you fill this in

A metric's **type cannot change** once a grantee has reported against it —
the database refuses it — because changing it would restate history. If you
are unsure whether something is a count or a description, `text` is the
reversible choice: you can add a count later, but you cannot turn last year's
sentences into numbers.

Two of the questions already on the application are worth revisiting here,
because they become the same problem in reporting: "estimated number of
individuals served" as a required whole number produces an invented figure
from any organization that counts meals or visits rather than people — and
that figure then appears in Foundation reporting as fact.
