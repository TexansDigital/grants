import { env } from 'cloudflare:test';
import type { RequestContext, Session } from '../src/types';
import { AppError } from '../src/lib/errors';
import { nowIso } from '../src/lib/time';

export const db = env.DB as unknown as D1Database;

export function ctxFor(session: Session | null = null): RequestContext {
  return {
    requestId: crypto.randomUUID(),
    session,
    ip: '203.0.113.10',
    userAgent: 'vitest',
    route: '/test',
    method: 'POST',
  };
}

export function applicantSession(organizationId: string, userId = crypto.randomUUID()): Session {
  return { userId, email: 'applicant@example.org', role: 'applicant', organizationId };
}

export function adminSession(userId = crypto.randomUUID()): Session {
  return { userId, email: 'admin@example.org', role: 'admin', organizationId: null };
}

export function reviewerSession(userId = crypto.randomUUID()): Session {
  return { userId, email: 'reviewer@example.org', role: 'reviewer', organizationId: null };
}

/**
 * The AppError a call threw, for asserting on its CLIENT-facing message.
 *
 * Exists because the two obvious ways of doing this are both wrong here:
 *
 *   `rejects.toThrow(/.../)` matches Error.message, which on an AppError is
 *   the INTERNAL message. A test written that way passes while saying nothing
 *   about what the person on the other end was actually told.
 *
 *   `rejects.toMatchObject({ publicMessage: /.../ })` matches NOTHING. Vitest
 *   treats a bare RegExp inside toMatchObject as satisfied by any string, so
 *   the assertion is silently vacuous. Two tests here were written that way and
 *   passed against completely different errors; only a mutant found it. See the
 *   canary in regressions.test.ts.
 */
/**
 * WHY THE RETURN TYPE HIDES `.message`.
 *
 * AppError carries two strings: `publicMessage`, which the client is shown,
 * and `message`, the internal one, which exists so a log line can say
 * something an administrator must never read. They are easy to confuse and the
 * confusion is invisible: a test asserting `.message` when it means the
 * user-facing text passes or fails for reasons unrelated to what the screen
 * says, and goes green the moment the two strings happen to coincide.
 *
 * It happened here on 2026-10-08, writing the reminder tests. A lint would
 * catch it; a type makes it unwritable. `message` is omitted and the internal
 * text is offered under its real name, so a test that genuinely wants it --
 * access.test.ts asserts BOTH, deliberately, to prove the public one is not an
 * oracle -- still can, and has to say so.
 */
export type ThrownAppError = Omit<AppError, 'message' | 'name' | 'stack'> & {
  /** The internal text. Not shown to anybody. Assert on publicMessage instead. */
  internalMessage: string;
};

export async function appErrorFrom(promise: Promise<unknown>): Promise<ThrownAppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) {
      return Object.assign(Object.create(Object.getPrototypeOf(e)) as AppError, e, {
        internalMessage: e.message,
      }) as unknown as ThrownAppError;
    }
    throw e;
  }
  throw new Error('expected this call to fail, and it succeeded');
}

/**
 * Put a report's due date where a fixture needs it, including in the past.
 *
 * WHY THIS EXISTS. 0029 makes `report_periods.due_date` immovable without a
 * matching `report_period_amendments` row stamped at the same instant, because
 * a deadline a nonprofit was told must not change with nobody named on it.
 * Six fixtures used to set the date with a bare UPDATE and the trigger now
 * refuses them -- correctly.
 *
 * SO THIS GOES THROUGH THE SAME DOOR RATHER THAN AROUND IT. It writes the
 * amendment the database asks for. It does NOT go through
 * `moveReportDueDate`, which refuses a past date and a settled report by
 * design; fixtures legitimately need both, to build a report that is already
 * overdue or already accepted. What it must never become is a way to move a
 * date with no record, because then the trigger is only guarding production
 * and the tests prove nothing about it.
 */
export async function forceDueDate(
  reportPeriodId: string,
  dueDate: string,
  opts: { status?: string } = {},
): Promise<void> {
  const now = nowIso();
  // `amended_by` is NOT NULL and references users(id), so a fixture needs a
  // real row. One per suite, reused.
  let actor = await db
    .prepare(`SELECT id FROM users WHERE email = 'fixture@example.test'`)
    .first<{ id: string }>();
  if (!actor) {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO users (id, email, role, is_active, created_at, updated_at)
         VALUES (?, 'fixture@example.test', 'admin', 1, ?, ?)`,
      )
      .bind(id, now, now)
      .run();
    actor = { id };
  }

  const before = await db
    .prepare(`SELECT due_date AS dueDate FROM report_periods WHERE id = ?`)
    .bind(reportPeriodId)
    .first<{ dueDate: string }>();
  if (!before) throw new Error(`no report period ${reportPeriodId}`);
  if (before.dueDate === dueDate) return;

  // INSERT before UPDATE: the trigger looks for the row, so the order is what
  // makes this legal. Reversed, the database refuses the batch.
  await db.batch([
    db
      .prepare(
        `INSERT INTO report_period_amendments
           (id, report_period_id, amended_at, amended_by, field_changed,
            old_value, new_value, reason, created_at)
         VALUES (?,?,?,?, 'due_date', ?,?, 'Fixture setup.', ?)`,
      )
      .bind(crypto.randomUUID(), reportPeriodId, now, actor.id, before.dueDate, dueDate, now),
    opts.status === undefined
      ? db
          .prepare(`UPDATE report_periods SET due_date = ?, updated_at = ? WHERE id = ?`)
          .bind(dueDate, now, reportPeriodId)
      : db
          .prepare(
            `UPDATE report_periods SET due_date = ?, status = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(dueDate, opts.status, now, reportPeriodId),
  ]);
}

/**
 * The same, for every report period on an award.
 *
 * The fixtures this replaces wrote `WHERE award_id = ?`, which on a multi-year
 * term is more than one period. Keeping that behaviour rather than quietly
 * narrowing it to one: a test that was setting two dates must go on setting
 * two, or it stops testing what it was written for.
 */
export async function forceDueDatesForAward(
  awardId: string,
  dueDate: string,
  opts: { status?: string } = {},
): Promise<void> {
  const { results } = await db
    .prepare(`SELECT id FROM report_periods WHERE award_id = ? AND deleted_at IS NULL`)
    .bind(awardId)
    .all<{ id: string }>();
  for (const r of results ?? []) await forceDueDate(r.id, dueDate, opts);
}
