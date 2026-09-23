/**
 * Destroying an applicant's financial documents on a schedule.
 *
 * WHAT THESE TESTS ARE GUARDING. Every failure here is one-way. A file
 * destroyed early cannot be recovered from the applicant, who has no reason to
 * still have it and no obligation to send it again. A file that quietly never
 * gets destroyed is the exposure this whole feature exists to remove, and its
 * symptom is silence.
 *
 * So the tests are weighted towards what must NOT be destroyed: an application
 * still under review, an application whose award is live, a file an admin
 * asked to keep. The happy path is one test; the refusals are most of them.
 */

import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { objectKey } from '../src/lib/uploads';
import {
  recomputeDueDates,
  filesDueWithin,
  filesPastDue,
  runRetention,
  holdAttachment,
  purgeAttachmentNow,
  retentionScreen,
  retentionDays,
  noticeIsDue,
  recomputeReportDueDates,
  reportRetentionDays,
  RETENTION_DAYS_DEFAULT,
  WARN_HORIZON_DAYS,
  type DueFile,
} from '../src/lib/retention';
import { presignDownloadForStaff } from '../src/lib/downloads';
import type { Env, Session } from '../src/types';

const DAY = 86_400_000;

const r2Env = (over: Partial<Env> = {}): Env => ({
  ...(testEnv as unknown as Env),
  R2_ACCESS_KEY_ID: 'demo-access-key-id',
  R2_SECRET_ACCESS_KEY: 'demo-secret-access-key',
  R2_BUCKET_NAME: 'steward-preview-files',
  R2_ACCOUNT_ID: 'abc123account',
  DISPLAY_TIMEZONE: 'America/Chicago',
  ...over,
});

let n = 0;
let admin: Session;

beforeEach(async () => {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
    )
    .bind(id, `ret-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

/**
 * An application with one uploaded budget, and the bytes really in R2 so a
 * purge has something to destroy.
 */
async function applicationWithFile(opts: { decidedDaysAgo?: number | null } = {}) {
  const p = await seedProgram(db, ctxFor(admin), { ...INSPIRE_CHANGE, slug: `ret-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const orgId = newId();
  const applicationId = newId();
  const attachmentId = newId();
  const now = nowIso();
  const decided = opts.decidedDaysAgo == null ? null : iso(-opts.decidedDaysAgo * DAY);

  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Trust ${n}`, String(800000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, decided_at, decided_by, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, ?, ?, ?, ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(
      applicationId, cycleId, orgId,
      decided ? 'declined' : 'submitted',
      now, decided, decided ? admin.userId : null,
      now, now, p.formDefinitionIds.application!,
    )
    .run();

  const key = objectKey(orgId, attachmentId);
  await db
    .prepare(
      `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
         filename, mime_type, size_bytes, uploaded_at)
       VALUES (?, 'application', ?, ?, ?, 'audited-2025.pdf', 'application/pdf', 9, ?)`,
    )
    .bind(attachmentId, applicationId, orgId, key, now)
    .run();
  await (testEnv as unknown as Env).FILES.put(key, 'some bytes');

  return { applicationId, orgId, attachmentId, key, programId: p.programId, cycleId };
}

async function award(applicationId: string, orgId: string, programId: string, status: string) {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO awards (id, application_id, organization_id, program_id,
         awarded_amount_cents, awarded_at, status, created_at, updated_at)
       VALUES (?,?,?,?, 2500000, ?, ?, ?, ?)`,
    )
    .bind(newId(), applicationId, orgId, programId, now, status, now, now)
    .run();
}

const dueOf = async (attachmentId: string) =>
  (
    await db
      .prepare(`SELECT purge_due_at AS d, purged_at AS p FROM attachments WHERE id = ?`)
      .bind(attachmentId)
      .first<{ d: string | null; p: string | null }>()
  )!;

// ---------------------------------------------------------------------------

describe('when a file becomes due', () => {
  it('is due RETENTION_DAYS after the decision, in the same timestamp format as everything else', async () => {
    const { attachmentId } = await applicationWithFile({ decidedDaysAgo: 10 });
    await recomputeDueDates(db, 90);
    const { d } = await dueOf(attachmentId);
    expect(d).not.toBeNull();
    /*
     * THE BUG THIS PREVENTS. SQLite's datetime() returns
     * 'YYYY-MM-DD HH:MM:SS'; every other timestamp in this database is
     * ISO-8601 with milliseconds and a Z. Two formats in one column compare as
     * strings in whatever order the characters fall -- and ' ' sorts before
     * 'T', so a datetime()-shaped row would read as due before every
     * ISO-shaped now(). Every such file would be destroyed on the first run.
     */
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const days = (Date.parse(d!) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(79);
    expect(days).toBeLessThan(81);
  });

  it('is NOT due while the application is undecided', async () => {
    // The review still needs the budget. A clock from upload would destroy it
    // mid-cycle and punish whoever applied first.
    const { attachmentId } = await applicationWithFile({ decidedDaysAgo: null });
    await recomputeDueDates(db, 90);
    expect((await dueOf(attachmentId)).d).toBeNull();
  });

  for (const status of ['pending', 'active']) {
    it(`is NOT due while a ${status} award stands on it`, async () => {
      // The itemized budget is what the award was made against and what the
      // grantee's spending is later checked against. Destroying it would mean
      // holding a grantee to a document the Foundation threw away.
      const a = await applicationWithFile({ decidedDaysAgo: 200 });
      await award(a.applicationId, a.orgId, a.programId, status);
      await recomputeDueDates(db, 90);
      expect((await dueOf(a.attachmentId)).d).toBeNull();
    });
  }

  for (const status of ['completed', 'cancelled']) {
    it(`IS due once the award is ${status}`, async () => {
      const a = await applicationWithFile({ decidedDaysAgo: 200 });
      await award(a.applicationId, a.orgId, a.programId, status);
      await recomputeDueDates(db, 90);
      expect((await dueOf(a.attachmentId)).d).not.toBeNull();
    });
  }

  it('moves when the facts move, because it is recomputed and not stamped', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 200 });
    await recomputeDueDates(db, 90);
    expect((await dueOf(a.attachmentId)).d).not.toBeNull();

    // An award created weeks after the decision. A stamped date would have
    // destroyed the budget the award was made against.
    await award(a.applicationId, a.orgId, a.programId, 'active');
    await recomputeDueDates(db, 90);
    expect((await dueOf(a.attachmentId)).d).toBeNull();
  });

  it('leaves report attachments alone', async () => {
    // A grantee's report is part of the award record, not an applicant's
    // financial disclosure. Different question, not covered here.
    const { orgId } = await applicationWithFile({ decidedDaysAgo: 200 });
    const id = newId();
    await db
      .prepare(
        `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
           filename, mime_type, size_bytes, uploaded_at)
         VALUES (?, 'report_submission', NULL, ?, ?, 'receipts.pdf', 'application/pdf', 5, ?)`,
      )
      .bind(id, orgId, objectKey(orgId, id), nowIso())
      .run();
    await recomputeDueDates(db, 90);
    expect((await dueOf(id)).d).toBeNull();
  });
});

describe('destroying the bytes', () => {
  it('deletes the object, keeps the row, and audits it', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 200 });
    const env = r2Env();
    const result = await runRetention(env, ctxFor(admin), new Date());
    expect(result.purged).toBe(1);
    expect(result.purgeFailures).toBe(0);

    // The bytes are gone. head() rather than get(): an unread body from get()
    // is a resource the test pool refuses to tear down around.
    expect(await env.FILES.head(a.key)).toBeNull();

    // The record is not. Nothing is hard-deleted; what was destroyed is the
    // liability, and the row is what answers "what did they send us".
    const row = await db
      .prepare(
        `SELECT filename, size_bytes, purged_at, deleted_at FROM attachments WHERE id = ?`,
      )
      .bind(a.attachmentId)
      .first<{ filename: string; size_bytes: number; purged_at: string; deleted_at: string | null }>();
    expect(row?.filename).toBe('audited-2025.pdf');
    expect(row?.size_bytes).toBe(9);
    expect(row?.purged_at).not.toBeNull();
    expect(row?.deleted_at).toBeNull();

    const audited = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action='attachment.purged' AND entity_id=?`)
      .bind(a.attachmentId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('does not purge twice, and the schema refuses a restamp', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 200 });
    const env = r2Env();
    await runRetention(env, ctxFor(admin), new Date());
    const second = await runRetention(env, ctxFor(admin), new Date());
    expect(second.purged).toBe(0);

    await expect(
      db.prepare(`UPDATE attachments SET purged_at = ? WHERE id = ?`).bind(nowIso(), a.attachmentId).run(),
    ).rejects.toThrow();
  });

  it('keeps going when one file cannot be deleted', async () => {
    /*
     * THE BUG THIS PREVENTS. One exception abandoning the loop means a single
     * unreachable key keeps every other applicant's accounts alive
     * indefinitely -- and the run looks like it simply had nothing to do.
     */
    const a = await applicationWithFile({ decidedDaysAgo: 200 });
    const b = await applicationWithFile({ decidedDaysAgo: 200 });
    const base = r2Env();
    const env = {
      ...base,
      FILES: {
        ...base.FILES,
        delete: async (key: string) => {
          if (key === a.key) throw new Error('R2 is having a day');
          return base.FILES.delete(key);
        },
      } as unknown as R2Bucket,
    } as Env;

    const result = await runRetention(env, ctxFor(admin), new Date());
    expect(result.purgeFailures).toBe(1);
    expect(result.purged).toBe(1);
    expect((await dueOf(b.attachmentId)).p).not.toBeNull();
    expect((await dueOf(a.attachmentId)).p).toBeNull();
  });

  it('refuses a download once the bytes are gone, and says why', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 200 });
    const env = r2Env();
    await runRetention(env, ctxFor(admin), new Date());

    const err = await appErrorFrom(
      presignDownloadForStaff(env, ctxFor(admin), admin, a.attachmentId),
    );
    expect(err.code).toBe('CONFLICT');
    // A signed URL that 404s at R2 would read as a broken system rather than
    // a policy working.
    expect(err.publicMessage).toMatch(/retention policy/i);
  });
});

describe('an admin holding a file longer', () => {
  it('pushes the date out and survives the nightly recompute', async () => {
    /*
     * THE BUG THIS PREVENTS. Writing the extension into purge_due_at would be
     * undone by the next night's recompute, silently, and the file would be
     * destroyed on the original date with an audit row saying it had been
     * held. The effective date is the LATER of the computed one and the hold.
     */
    const a = await applicationWithFile({ decidedDaysAgo: 200 });
    await recomputeDueDates(db, 90);
    await holdAttachment(db, ctxFor(admin), admin, a.attachmentId, iso(60 * DAY), 'Board query open');

    const env = r2Env();
    const result = await runRetention(env, ctxFor(admin), new Date());
    expect(result.purged).toBe(0);
    expect(await env.FILES.head(a.key)).not.toBeNull();
  });

  it('refuses a hold with no reason, in the code and in the schema', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 10 });
    const err = await appErrorFrom(
      holdAttachment(db, ctxFor(admin), admin, a.attachmentId, iso(60 * DAY), '   '),
    );
    expect(err.code).toBe('VALIDATION_FAILED');

    // And not only in the code: an extension nobody can account for is what an
    // auditor asks about, so the database refuses it too.
    await expect(
      db
        .prepare(`UPDATE attachments SET retention_hold_until = ? WHERE id = ?`)
        .bind(iso(60 * DAY), a.attachmentId)
        .run(),
    ).rejects.toThrow();
  });

  it('refuses a hold in the past rather than silently doing nothing', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 10 });
    const err = await appErrorFrom(
      holdAttachment(db, ctxFor(admin), admin, a.attachmentId, iso(-DAY), 'typo'),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('records who held it, and why', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 10 });
    await holdAttachment(db, ctxFor(admin), admin, a.attachmentId, iso(30 * DAY), 'Audit in progress');
    const row = await db
      .prepare(
        `SELECT retention_reason AS r, retention_set_by AS who FROM attachments WHERE id = ?`,
      )
      .bind(a.attachmentId)
      .first<{ r: string; who: string }>();
    expect(row?.r).toBe('Audit in progress');
    expect(row?.who).toBe(admin.userId);

    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log
          WHERE action='attachment.retention_held' AND entity_id=?`,
      )
      .bind(a.attachmentId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });
});

describe('an admin deleting a file early', () => {
  it('destroys it now, with a reason on the audit row', async () => {
    // A board member's personal tax return attached to the wrong field should
    // not sit in R2 for ninety days because the policy says so.
    const a = await applicationWithFile({ decidedDaysAgo: 1 });
    const env = r2Env();
    await purgeAttachmentNow(env, ctxFor(admin), admin, a.attachmentId, 'Uploaded to the wrong field');
    expect(await env.FILES.head(a.key)).toBeNull();

    const row = await db
      .prepare(
        `SELECT after_json FROM audit_log
          WHERE action='attachment.purged' AND entity_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(a.attachmentId)
      .first<{ after_json: string }>();
    const after = JSON.parse(row!.after_json) as Record<string, unknown>;
    expect(after.reason).toBe('Uploaded to the wrong field');
    // The nightly job and a person pressing delete are both legitimate and are
    // not the same event.
    expect(after.actor_user_id).toBe(admin.userId);
  });

  it('refuses with no reason, and refuses a second time', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 1 });
    const env = r2Env();
    expect((await appErrorFrom(purgeAttachmentNow(env, ctxFor(admin), admin, a.attachmentId, ' '))).code)
      .toBe('VALIDATION_FAILED');

    await purgeAttachmentNow(env, ctxFor(admin), admin, a.attachmentId, 'wrong field');
    expect((await appErrorFrom(purgeAttachmentNow(env, ctxFor(admin), admin, a.attachmentId, 'again'))).code)
      .toBe('CONFLICT');
  });
});

describe('telling the admins', () => {
  // `warned` defaults to true -- "this file has already had its heads-up" --
  // so each test says for itself whether it is about a file the admins have
  // heard of. A default of false would make every quiet-period test pass for
  // the wrong reason.
  const line = (dueInDays: number, retrieved = false, warned = true): DueFile => ({
    id: newId(),
    filename: 'f.pdf',
    organization_name: 'Invented Trust',
    project_title: null,
    application_id: newId(),
    parent_type: 'application',
    effective_due_at: iso(dueInDays * DAY),
    download_url_first_issued_at: retrieved ? nowIso() : null,
    retention_notice_sent_at: warned ? nowIso() : null,
  });

  it('says nothing when everything has been asked for', async () => {
    // A daily email that is empty teaches the recipient to filter it, and the
    // one that matters arrives after the filter is in place.
    expect(noticeIsDue([line(2, true), line(5, true)], Date.now())).toEqual([]);
  });

  it('goes daily inside the last week', async () => {
    expect(noticeIsDue([line(3)], Date.now()).length).toBe(1);
    expect(noticeIsDue([line(1)], Date.now()).length).toBe(1);
  });

  it('is quiet in the middle, and speaks once at the horizon', async () => {
    // Between the month-out heads-up and the final week, a daily email would
    // be about twenty of them saying the same thing.
    expect(noticeIsDue([line(20)], Date.now())).toEqual([]);
    expect(noticeIsDue([line(WARN_HORIZON_DAYS - 0.5, false, false)], Date.now()).length).toBe(1);
  });

  it('still warns about a file whose heads-up night was missed', async () => {
    /*
     * THE BUG THIS PREVENTS. The heads-up used to fire only for files landing
     * in the slice between 29 and 30 days from the instant the run began. A
     * night the cron did not fire -- or fired an hour late -- skipped every
     * file in that slice permanently, and silently: the daily notices in the
     * last week would eventually arrive, but the warning that comes while
     * there is still a month to act on it never would.
     *
     * A file sitting at 20 days with no notice ever sent is exactly that
     * case, and it now speaks.
     */
    expect(noticeIsDue([line(20, false, false)], Date.now()).length).toBe(1);
  });

  it('does not warn again about a file already named, until the last week', async () => {
    expect(noticeIsDue([line(25)], Date.now())).toEqual([]);
    // ...and the daily window overrides the stamp, which is what makes the
    // last seven days daily rather than once.
    expect(noticeIsDue([line(5)], Date.now()).length).toBe(1);
  });

  it('writes one message per admin per day, however often the cron fires', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 87 });
    const env = r2Env();
    const first = await runRetention(env, ctxFor(admin), new Date());
    expect(first.noticesRecorded).toBeGreaterThan(0);

    const before = await db
      .prepare(`SELECT COUNT(*) AS n FROM email_messages WHERE template_key='files_due_for_deletion'`)
      .first<{ n: number }>();
    await runRetention(env, ctxFor(admin), new Date());
    const after = await db
      .prepare(`SELECT COUNT(*) AS n FROM email_messages WHERE template_key='files_due_for_deletion'`)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(a.attachmentId).toBeTruthy();
  });

  it('writes down which files it named, so the next night does not repeat itself', async () => {
    /*
     * The stamp is what makes the month-out heads-up a fact about the file
     * rather than about the instant the cron fired. A file 25 days out is
     * outside the daily window, so the only reason it is named tonight is that
     * it has never been named -- and tomorrow night that has to have changed.
     */
    const a = await applicationWithFile({ decidedDaysAgo: 65 });
    const env = r2Env();

    const run = await runRetention(env, ctxFor(admin), new Date());
    expect(run.noticesRecorded).toBeGreaterThan(0);

    const stamped = await db
      .prepare(`SELECT retention_notice_sent_at AS at FROM attachments WHERE id = ?`)
      .bind(a.attachmentId)
      .first<{ at: string | null }>();
    expect(stamped?.at).not.toBeNull();

    // And the file is now quiet, where before the stamp existed it depended on
    // the run landing inside a one-day slice.
    const due = await filesDueWithin(db, nowIso(), WARN_HORIZON_DAYS);
    expect(noticeIsDue(due, Date.now())).toEqual([]);
  });

  it('does not mark files as warned about when nobody was warned', async () => {
    /*
     * A database with no active admin records nothing and sends nothing.
     * Stamping anyway would mark every file in the horizon as already warned
     * about, and the first admin account created afterwards would never
     * receive the heads-up for any of them -- a silence caused by the fix for
     * a silence.
     */
    const a = await applicationWithFile({ decidedDaysAgo: 65 });
    await db.prepare(`UPDATE users SET is_active = 0 WHERE role = 'admin'`).run();

    const run = await runRetention(r2Env(), ctxFor(admin), new Date());
    expect(run.noticesRecorded).toBe(0);

    const stamped = await db
      .prepare(`SELECT retention_notice_sent_at AS at FROM attachments WHERE id = ?`)
      .bind(a.attachmentId)
      .first<{ at: string | null }>();
    expect(stamped?.at).toBeNull();
  });

  it('gives a held file a fresh heads-up when it comes back into view', async () => {
    // A hold pushes the date weeks out. Without clearing the stamp the file
    // would re-enter the horizon already marked as warned about, and the only
    // notice it ever got would describe a date that no longer applies.
    const a = await applicationWithFile({ decidedDaysAgo: 65 });
    const env = r2Env();
    await runRetention(env, ctxFor(admin), new Date());

    await holdAttachment(
      db, ctxFor(admin), admin, a.attachmentId,
      iso(200 * DAY), 'Audit query open on this grant',
    );
    const after = await db
      .prepare(`SELECT retention_notice_sent_at AS at FROM attachments WHERE id = ?`)
      .bind(a.attachmentId)
      .first<{ at: string | null }>();
    expect(after?.at).toBeNull();
  });

  it('never names a file it destroyed the same night', async () => {
    /*
     * THE BUG THIS PREVENTS. If the notice were assembled before the purge,
     * a file already past its date would be inside the 30-day horizon, would
     * be named in tonight's email as "due to be deleted" with a link to open
     * it -- and would be gone by the time anyone read the message. The reader
     * would click through to a refusal on the one night the email said to act.
     *
     * Purge first, then notice.
     */
    const past = await applicationWithFile({ decidedDaysAgo: 200 });
    const soon = await applicationWithFile({ decidedDaysAgo: 87 });
    const env = r2Env();

    const result = await runRetention(env, ctxFor(admin), new Date());
    expect(result.purged).toBe(1);

    const named = await filesDueWithin(db, nowIso(), WARN_HORIZON_DAYS);
    expect(named.some((f) => f.id === past.attachmentId)).toBe(false);
    expect(named.some((f) => f.id === soon.attachmentId)).toBe(true);
    // And the count the run reported is the post-purge one, not the list it
    // would have mailed had it looked first.
    expect(result.dueWithinHorizon).toBe(named.length);
  });

  it('stops naming a file once a download link has been issued for it', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 87 });
    const env = r2Env();
    await recomputeDueDates(db, 90);

    const beforeAsk = await filesDueWithin(db, nowIso(), WARN_HORIZON_DAYS);
    expect(beforeAsk.some((f) => f.id === a.attachmentId && !f.download_url_first_issued_at)).toBe(true);

    await presignDownloadForStaff(env, ctxFor(admin), admin, a.attachmentId);
    const afterAsk = await filesDueWithin(db, nowIso(), WARN_HORIZON_DAYS);
    const mine = afterAsk.find((f) => f.id === a.attachmentId)!;
    expect(mine.download_url_first_issued_at).not.toBeNull();
    expect(noticeIsDue([mine], Date.now())).toEqual([]);
  });
});

describe('configuration', () => {
  it('falls back rather than obeying a typo', async () => {
    // A bad value here would destroy documents on the day of the decision.
    for (const bad of ['', '  ', 'ninety', '0', '-5', '1.5']) {
      expect(retentionDays(r2Env({ RETENTION_DAYS: bad }))).toBe(RETENTION_DAYS_DEFAULT);
    }
    expect(retentionDays(r2Env({ RETENTION_DAYS: '30' }))).toBe(30);
  });
});

describe('the screen', () => {
  it('shows what was destroyed as well as what is coming', async () => {
    // A retention screen that hides what it destroyed cannot answer the only
    // question anyone will ever ask it.
    const a = await applicationWithFile({ decidedDaysAgo: 200 });
    const env = r2Env();
    await runRetention(env, ctxFor(admin), new Date());
    const screen = await retentionScreen(db, nowIso());
    expect(screen.purged.some((r) => r.id === a.attachmentId)).toBe(true);
  });

  it('lists a file due inside the horizon', async () => {
    const a = await applicationWithFile({ decidedDaysAgo: 80 });
    await recomputeDueDates(db, 90);
    const screen = await retentionScreen(db, nowIso());
    expect(screen.upcoming.some((f) => f.id === a.attachmentId)).toBe(true);
    expect((await filesPastDue(db, nowIso())).some((f) => f.id === a.attachmentId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
/*
 * Files attached to a grant REPORT.
 *
 * A different problem from an applicant's financial statements, and the tests
 * are here to keep it a different problem. An audited statement is collected to
 * reach a decision and is exposure once the decision is made. A photograph of
 * the thing the grant paid for IS the deliverable -- destroying it on a
 * ninety-day clock would throw away the reason for asking.
 */
describe('retention for what a grantee sends back', () => {
  async function acceptedReport(opts: { acceptedAt: string | null }) {
    const p = await seedProgram(db, ctxFor(adminSession()), {
      ...INSPIRE_CHANGE, slug: `rep-${newId().slice(0, 8)}`,
    });
    const now = nowIso();
    const orgId = newId();
    const awardId = newId();
    /*
     * A real admin row. accepted_by is a foreign key, so a session object with
     * an id nothing points at is not enough -- somebody accepted this report
     * and the schema wants to know who.
     */
    const adminId = adminSession().userId;
    await db.prepare(
      `INSERT OR IGNORE INTO users (id, email, role, organization_id, is_active,
         created_at, updated_at)
       VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
    ).bind(adminId, `retention-admin-${adminId.slice(0, 8)}@example-invented.org`, now, now).run();
    const periodId = newId();
    const submissionId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Invented Bayou Collective', String(700000000 + Math.floor(Math.random() * 1000)), now, now).run();
    await db.prepare(
      /*
       * An imported historical award: no application behind it. The schema
       * insists an award names either an application or where it came from,
       * which is why this carries source_system -- and it is also the exact
       * shape of the awards the past-grantee claim queue connects people to.
       */
      `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents,
         awarded_at, status, source_system, source_reference, created_at, updated_at)
       VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?)`,
    ).bind(awardId, orgId, p.programId, 2_500_000, now, `RET-${awardId.slice(0, 8)}`, now, now).run();
    await db.prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, created_at, updated_at)
       VALUES (?,?,?,'final',?,?,?)`,
    ).bind(periodId, awardId, 'Final report', '2027-01-31T00:00:00.000Z', now, now).run();
    await db.prepare(
      `INSERT INTO report_submissions (id, report_period_id, submitted_at, accepted_at,
         accepted_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      submissionId, periodId, now, opts.acceptedAt,
      opts.acceptedAt === null ? null : adminId, now, now,
    ).run();

    const attach = async (filename: string, mime: string) => {
      const id = newId();
      await db.prepare(
        `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
           filename, mime_type, size_bytes, uploaded_at)
         VALUES (?, 'report_submission', ?, ?, ?, ?, ?, 10, ?)`,
      ).bind(id, submissionId, orgId, objectKey(orgId, id), filename, mime, now).run();
      return id;
    };

    return {
      orgId, awardId, submissionId,
      pdf: await attach('evaluation.pdf', 'application/pdf'),
      photo: await attach('summer-day.jpg', 'image/jpeg'),
      video: await attach('opening.mp4', 'video/mp4'),
      heic: await attach('IMG_4821.HEIC', 'image/heic'),
    };
  }

  const dueFor = async (id: string) =>
    (await db.prepare(`SELECT purge_due_at AS d FROM attachments WHERE id=?`)
      .bind(id).first<{ d: string | null }>())!.d;

  it('schedules nothing at all when no window is configured', async () => {
    // The Foundation has not chosen a retention period for report documents.
    // Until they do, the correct number of files scheduled for destruction is
    // zero -- not a default somebody has to discover later.
    const r = await acceptedReport({ acceptedAt: nowIso() });
    expect(await recomputeReportDueDates(db, null)).toBe(0);
    expect(await dueFor(r.pdf)).toBeNull();
  });

  it('never schedules a photograph, even when a window IS configured', async () => {
    // The assertion this whole block exists for.
    const r = await acceptedReport({ acceptedAt: nowIso() });
    await recomputeReportDueDates(db, 90);
    expect(await dueFor(r.photo)).toBeNull();
    expect(await dueFor(r.video)).toBeNull();
    expect(await dueFor(r.heic)).toBeNull();
  });

  it('schedules a document from the date the report was ACCEPTED', async () => {
    const acceptedAt = '2026-01-10T00:00:00.000Z';
    const r = await acceptedReport({ acceptedAt });
    await recomputeReportDueDates(db, 30);
    expect(await dueFor(r.pdf)).toBe('2026-02-09T00:00:00.000Z');
  });

  it('leaves a report still under review alone', async () => {
    // A report nobody has accepted is a report somebody may still have to
    // read, and the attachment is part of what they are reading.
    const r = await acceptedReport({ acceptedAt: null });
    await recomputeReportDueDates(db, 30);
    expect(await dueFor(r.pdf)).toBeNull();
  });

  it('warns about a report document before it destroys one', async () => {
    /*
     * The pair that must not disagree. A file eligible for deletion that never
     * appears in a notice is destroyed without anybody being told, which is the
     * single worst outcome this module can produce.
     */
    const r = await acceptedReport({ acceptedAt: '2026-01-10T00:00:00.000Z' });
    await recomputeReportDueDates(db, 30);
    const at = '2026-02-09T01:00:00.000Z';

    const warned = await filesDueWithin(db, at, WARN_HORIZON_DAYS);
    const pastDue = await filesPastDue(db, at);
    expect(warned.map((f) => f.id)).toContain(r.pdf);
    expect(pastDue.map((f) => f.id)).toContain(r.pdf);
    // Every file about to be destroyed was named in the warning list.
    for (const f of pastDue) expect(warned.map((w) => w.id)).toContain(f.id);
  });

  it('names the grantee organization on the notice, not "(unknown)"', async () => {
    // The email says who each file belongs to. A LEFT JOIN that found nothing
    // would still produce a line, and the line would be useless.
    const r = await acceptedReport({ acceptedAt: '2026-01-10T00:00:00.000Z' });
    await recomputeReportDueDates(db, 30);
    const warned = await filesDueWithin(db, '2026-02-09T01:00:00.000Z', WARN_HORIZON_DAYS);
    const line = warned.find((f) => f.id === r.pdf)!;
    expect(line.organization_name).toBe('Invented Bayou Collective');
    expect(line.project_title).toBe('Final report');
    expect(line.parent_type).toBe('report_submission');
    // No application behind a report document, and none invented to fill it.
    expect(line.application_id).toBeNull();
  });

  it('still lists a purged report document on the screen that records deletions', async () => {
    // retentionScreen answers "what happened to the file we had from them".
    // An INNER JOIN to applications drops every report file from that answer.
    const r = await acceptedReport({ acceptedAt: '2026-01-10T00:00:00.000Z' });
    await db.prepare(`UPDATE attachments SET purged_at=? WHERE id=?`)
      .bind(nowIso(), r.pdf).run();
    const screen = await retentionScreen(db, nowIso());
    expect(screen.purged.map((row) => row.id)).toContain(r.pdf);
  });

  it('reads the window from configuration, and refuses nonsense', () => {
    expect(reportRetentionDays({ REPORT_RETENTION_DAYS: '365' } as unknown as Env)).toBe(365);
    expect(reportRetentionDays({} as unknown as Env)).toBeNull();
    expect(reportRetentionDays({ REPORT_RETENTION_DAYS: '' } as unknown as Env)).toBeNull();
    expect(reportRetentionDays({ REPORT_RETENTION_DAYS: '0' } as unknown as Env)).toBeNull();
    expect(reportRetentionDays({ REPORT_RETENTION_DAYS: 'soon' } as unknown as Env)).toBeNull();
    // A negative window would mean "delete files accepted in the future".
    expect(reportRetentionDays({ REPORT_RETENTION_DAYS: '-30' } as unknown as Env)).toBeNull();
  });
});
