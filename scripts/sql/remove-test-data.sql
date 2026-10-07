-- Remove the two test awards from production.
--
-- APPLY IT WITH --command=, NOT --file:
--
--   npx wrangler d1 execute steward-production --remote --env production --yes \
--     --command="$(cat scripts/sql/remove-test-data.sql)"
--
-- `--file --remote` switches to D1's bulk IMPORT endpoint, which refuses an
-- OAuth login with `Authentication error [code: 10000]`. That is the endpoint,
-- not a missing permission -- the same login carries `d1 (write)`. The equals
-- sign matters too: this file opens with a `--` comment, and an unbound
-- `--command "$(cat …)"` makes yargs read those leading dashes as the next
-- flag and exit with "You must provide either --command or --file".
-- `npm run check:commands` fails on either mistake anywhere in this repo.
--
-- NO TRANSACTION. The statements run as a batch of separate statements, with
-- no rollback across them (`scripts/apply-sql.mjs` says the same). That is
-- safe here because every statement is a soft-delete already filtered on
-- `deleted_at IS NULL`, and the audit INSERT is guarded by NOT EXISTS, so a
-- half-applied run is fixed by running it again rather than by unpicking it.
--
-- WHY THIS FILE EXISTS. The 2025 import put thirteen real grants in
-- (IC-2025-001 .. IC-2025-013, $469,000 in total). Two more rows were created
-- by hand while testing: the end-to-end claim test and the demo CSV. Both are
-- honestly labelled, but "Ask past grantees for an update" selects awards that
-- are active or completed, have term dates, and have no report period -- and
-- the demo row qualifies. Left in place it makes the dry run say fourteen, and
-- confirming that dialog emails whoever is on its contact record.
--
-- The test row also carries a report period marked 'accepted', which Impact
-- counts in its reporting-coverage figure. That number ends up in a board
-- paper, so a fake accepted report is not a cosmetic problem.
--
-- SCOPE. Every statement is scoped through source_reference IN
-- ('TEST-2026-001','DEMO-01'). No real grant carries either reference -- the
-- thirteen are IC-2025-NNN -- so this cannot reach one even if run twice or
-- run against the wrong database.
--
-- SOFT DELETE ONLY. Nothing here removes a row (the triggers would refuse it
-- anyway). deleted_at is stamped, in the ISO-with-milliseconds form the rest of
-- the codebase writes, and every read path filters on it.
--
-- ORDER IS LOAD-BEARING. organizations_no_soft_delete_with_live_records
-- refuses an organization delete while a live user or application still points
-- at it, so those are stamped before the organization is. The organization
-- statements additionally require that no live award remains against the
-- organization, so an organization that somehow held a real grant as well is
-- left alone rather than taken down with the test row.
--
-- RE-RUNNABLE. Every UPDATE is already filtered on deleted_at IS NULL, and the
-- audit INSERT is guarded by NOT EXISTS because audit_log's append-only trigger
-- aborts on a colliding id rather than ignoring it. A second run writes nothing
-- and fails nothing.
--
-- WHAT IT DOES NOT DO. report_submissions has no deleted_at column, so the
-- submission filed by the test is not stamped. It stops appearing because every
-- read reaches it through report_periods, which is filtered -- but the row is
-- still in the table. Stated here rather than left to be discovered.

-- 1. Draft report answers, reached through the test awards' report periods.
UPDATE report_drafts
   SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND report_period_id IN (
         SELECT rp.id
           FROM report_periods rp
          WHERE rp.award_id IN (
                  SELECT id FROM awards
                   WHERE source_reference IN ('TEST-2026-001','DEMO-01'))
       );

-- 2. The report periods themselves. status is deliberately NOT touched: the
-- test period is 'accepted', and report_periods_accepted_is_terminal refuses
-- any move off that status. Stamping deleted_at alone is permitted and is all
-- that is needed -- the compliance desk and Impact both filter on it.
UPDATE report_periods
   SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND award_id IN (
         SELECT id FROM awards
          WHERE source_reference IN ('TEST-2026-001','DEMO-01')
       );

-- 3. The claim that produced the end-to-end test award, matched or granted.
UPDATE grantee_claims
   SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND (matched_award_id IN (
          SELECT id FROM awards
           WHERE source_reference IN ('TEST-2026-001','DEMO-01'))
     OR granted_award_id IN (
          SELECT id FROM awards
           WHERE source_reference IN ('TEST-2026-001','DEMO-01')));

-- 4. One audit row per award, BEFORE the award changes, so before_json records
-- the live state. actor_kind is 'system' because this runs as SQL with no
-- session behind it; pretending an admin user did it would be a worse record
-- than admitting no user id exists.
INSERT INTO audit_log (
  id, actor_user_id, actor_kind, actor_role, actor_organization_id,
  action, entity_type, entity_id,
  before_json, after_json, changed_fields_json,
  request_id, ip, user_agent, created_at
)
SELECT
  'audit-testdata-' || a.source_reference,
  NULL,
  'system',
  NULL,
  NULL,
  'award.test_data_removed',
  'award',
  a.id,
  json_object(
    'source_reference', a.source_reference,
    'source_system', a.source_system,
    'organization_id', a.organization_id,
    'awarded_amount_cents', a.awarded_amount_cents,
    'status', a.status,
    'deleted_at', a.deleted_at
  ),
  json_object('deleted_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  json_array('deleted_at'),
  NULL,
  NULL,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM awards a
 WHERE a.source_reference IN ('TEST-2026-001','DEMO-01')
   AND a.deleted_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM audit_log
          WHERE id = 'audit-testdata-' || a.source_reference
       );

-- 5. The awards. awarded_amount_cents is untouched, so
-- awards_amount_is_not_edited_in_place does not fire.
UPDATE awards
   SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND source_reference IN ('TEST-2026-001','DEMO-01');

-- 6. Any application belonging to a test organization. Guarded on the
-- organization having no live award left, so a shared organization is skipped.
UPDATE applications
   SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND organization_id IN (
         SELECT a.organization_id FROM awards a
          WHERE a.source_reference IN ('TEST-2026-001','DEMO-01')
            AND NOT EXISTS (
                  SELECT 1 FROM awards live
                   WHERE live.organization_id = a.organization_id
                     AND live.deleted_at IS NULL)
       );

-- 7. The grantee logins created for the test. Deactivated AND stamped, and
-- sessions_valid_from pushed forward so any session token already issued stops
-- being honoured. That column only moves forward, by trigger, so this is safe
-- to repeat.
UPDATE users
   SET is_active = 0,
       sessions_valid_from = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND organization_id IN (
         SELECT a.organization_id FROM awards a
          WHERE a.source_reference IN ('TEST-2026-001','DEMO-01')
            AND NOT EXISTS (
                  SELECT 1 FROM awards live
                   WHERE live.organization_id = a.organization_id
                     AND live.deleted_at IS NULL)
       );

-- 8. Contact records for the same organizations. Not covered by the
-- organization trigger, but a live contact under a deleted organization is a
-- row the Eloqua opt-in sync could still pick up.
UPDATE contacts
   SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND organization_id IN (
         SELECT a.organization_id FROM awards a
          WHERE a.source_reference IN ('TEST-2026-001','DEMO-01')
            AND NOT EXISTS (
                  SELECT 1 FROM awards live
                   WHERE live.organization_id = a.organization_id
                     AND live.deleted_at IS NULL)
       );

-- 9. The organizations, last. The trigger is the backstop; the NOT EXISTS
-- clauses are the intent.
UPDATE organizations
   SET status = 'inactive',
       deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND merged_into_id IS NULL
   AND id IN (
         SELECT a.organization_id FROM awards a
          WHERE a.source_reference IN ('TEST-2026-001','DEMO-01')
            AND NOT EXISTS (
                  SELECT 1 FROM awards live
                   WHERE live.organization_id = a.organization_id
                     AND live.deleted_at IS NULL)
       );

-- 10. What is left. Expect 13 awards, 46900000 cents, 13 organizations,
-- 0 report periods.
SELECT (SELECT COUNT(*) FROM awards        WHERE deleted_at IS NULL) AS awards,
       (SELECT SUM(awarded_amount_cents) FROM awards WHERE deleted_at IS NULL) AS cents,
       (SELECT COUNT(*) FROM organizations WHERE deleted_at IS NULL) AS orgs,
       (SELECT COUNT(*) FROM report_periods WHERE deleted_at IS NULL) AS periods;
