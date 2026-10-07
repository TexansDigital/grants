import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { buildReportForm } from '../src/lib/reportForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { impact } from '../src/lib/impact';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * What the money did, and how much of the picture we actually have.
 *
 * EVERY TEST BELOW IS ABOUT THE DENOMINATOR, because an impact total without
 * one is the most misleading number this platform can produce. "4,200 people
 * served" is a fact if every grantee has filed and a floor if three of
 * thirteen have, and the figure reads identically either way -- on its way
 * into a board paper where nobody can see behind it.
 */

const day = (s: string) => `${s}T00:00:00.000Z`;
let seq = 0;

async function scenario() {
  const admin = adminSession();
  const adminCtx = ctxFor(admin);
  const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `imp-${++seq}` });
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
          status, promotes_to, created_at, updated_at)
       VALUES (?,?,'individuals_served','Individuals served','integer','people',1,10,
               'active',NULL,?,?)`,
    )
    .bind(newId(), p.programId, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
          status, promotes_to, created_at, updated_at)
       VALUES (?,?,'populations','Populations served','text',NULL,0,20,
               'active',NULL,?,?)`,
    )
    .bind(newId(), p.programId, now, now)
    .run();

  const form = await buildReportForm(db, adminCtx, { programId: p.programId });
  await db
    .prepare(`UPDATE form_definitions SET status='published', published_at=? WHERE id=?`)
    .bind(now, form.formDefinitionId)
    .run();

  return { admin, adminCtx, programId: p.programId };
}

async function award(programId: string, cents = 2_500_000, year = '2025'): Promise<string> {
  const now = nowIso();
  const orgId = newId();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Impact Org ${++seq}`, String(920000000 + seq), now, now)
    .run();

  const id = newId();
  await db
    .prepare(
      `INSERT INTO awards (id, application_id, organization_id, program_id,
         awarded_amount_cents, awarded_at, status, source_system, source_reference,
         term_start, term_end, created_at, updated_at)
       VALUES (?,NULL,?,?,?,?,'active','spreadsheet',?,?,?,?,?)`,
    )
    .bind(
      id, orgId, programId, cents, day(`${year}-10-01`), `IMP-${id.slice(0, 8)}`,
      day(`${year}-01-01`), day(`${year}-12-31`), now, now,
    )
    .run();
  return id;
}

/**
 * An accepted report carrying one integer value and one written answer.
 *
 * An acceptance needs an ACCEPTOR: report_submissions carries
 * CHECK ((accepted_at IS NOT NULL) = (accepted_by IS NOT NULL)), so half an
 * acceptance is not a state the database will hold. Right, and worth knowing
 * -- "accepted by nobody" is exactly the row that would let an unreviewed
 * number into a published total.
 */
async function acceptedReport(
  programId: string,
  awardId: string,
  served: number,
  text = 'Youth in Fort Bend County.',
): Promise<void> {
  const now = nowIso();
  const acceptorId = newId();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, is_active, created_at, updated_at)
       VALUES (?,?, 'admin', 1, ?, ?)`,
    )
    .bind(acceptorId, `acceptor-${++seq}@example.org`, now, now)
    .run();
  const period = await db
    .prepare(`SELECT id FROM report_periods WHERE award_id = ? LIMIT 1`)
    .bind(awardId)
    .first<{ id: string }>();

  const subId = newId();
  await db
    .prepare(
      `INSERT INTO report_submissions
         (id, report_period_id, submitted_at, accepted_at, accepted_by,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(subId, period!.id, now, now, acceptorId, now, now)
    .run();
  await db
    .prepare(`UPDATE report_periods SET status = 'accepted' WHERE id = ?`)
    .bind(period!.id)
    .run();

  const defs = await db
    .prepare(`SELECT id, metric_type FROM metric_definitions WHERE program_id = ?`)
    .bind(programId)
    .all<{ id: string; metric_type: string }>();

  for (const d of defs.results ?? []) {
    await db
      .prepare(
        `INSERT INTO metric_values
           (id, report_submission_id, metric_definition_id, value_int, value_real,
            value_text, created_at)
         VALUES (?,?,?,?,NULL,?,?)`,
      )
      .bind(
        newId(), subId, d.id,
        d.metric_type === 'text' ? null : served,
        d.metric_type === 'text' ? text : null,
        now,
      )
      .run();
  }
}

const programOf = (out: Awaited<ReturnType<typeof impact>>, programId: string) =>
  out.programs.find((p) => p.programId === programId)!;

describe('impact', () => {
  it('reports every total with the coverage behind it', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const filed = await award(programId);
    const silent = await award(programId);
    await generateReportPeriods(db, adminCtx, filed);
    await generateReportPeriods(db, adminCtx, silent);
    await acceptedReport(programId, filed, 412);

    const out = await impact(db, admin, nowIso());
    const p = programOf(out, programId);

    /*
     * THE PROPERTY THE SCREEN EXISTS FOR. 412 is true, and it is one of two
     * obligations. Both numbers have to come back together or the first one
     * goes into a board paper on its own.
     */
    const served = p.metrics.find((m) => m.label === 'Individuals served')!;
    expect(served.total).toBe(412);
    expect(served.answered).toBe(1);
    expect(p.obligations).toBe(2);
    expect(p.accepted).toBe(1);
  });

  it('separates the money behind accepted updates from the money in total', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const filed = await award(programId, 2_500_000);
    const silent = await award(programId, 1_000_000);
    await generateReportPeriods(db, adminCtx, filed);
    await generateReportPeriods(db, adminCtx, silent);
    await acceptedReport(programId, filed, 412);

    /*
     * THE NUMERATOR AND THE DENOMINATOR, SEPARATELY. The coverage sentence
     * said "covering $35,000 of grants" when one of two had filed, using the
     * total as though it were the amount the accepted update accounted for --
     * the one figure on a screen built to carry denominators that had none,
     * on its way into a board paper.
     */
    const p = programOf(await impact(db, admin, nowIso()), programId);
    expect(p.acceptedAwardedCents).toBe(2_500_000);
    expect(p.totalAwardedCents).toBe(3_500_000);
    expect(Number.isInteger(p.acceptedAwardedCents)).toBe(true);
  });

  it('never turns an unanswered metric into a zero', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const a = await award(programId);
    await generateReportPeriods(db, adminCtx, a);

    /*
     * "0 people served" and "nobody has told us yet" are different facts, and
     * the first is a libel on the grantees. SUM over no rows is 0 in some
     * readings and NULL in others; this pins which one reaches the screen.
     */
    const p = programOf(await impact(db, admin, nowIso()), programId);
    const served = p.metrics.find((m) => m.label === 'Individuals served')!;
    expect(served.total).toBeNull();
    expect(served.answered).toBe(0);
  });

  it('never aggregates a written answer', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const a = await award(programId);
    await generateReportPeriods(db, adminCtx, a);
    await acceptedReport(programId, a, 412, 'Youth and their families.');

    /*
     * A text metric summed or counted into a figure is a fabrication. It is
     * reported as answered, with no total, so the screen can say "1 grantee
     * answered" and show nothing that looks like a measurement.
     */
    const p = programOf(await impact(db, admin, nowIso()), programId);
    const text = p.metrics.find((m) => m.label === 'Populations served')!;
    expect(text.total).toBeNull();
    expect(text.answered).toBe(1);

    /*
     * AND THIS IS WHY THAT HOLDS. Removing the explicit text branch from the
     * query changes nothing -- a mutation run confirmed it -- because 0012
     * constrains metric_values to at most one populated value column, so a
     * text metric's SUM(value_int) is NULL regardless. The constraint is the
     * real protection, so the constraint is what gets asserted. If this stops
     * throwing, the branch in impact.ts stops being belt-and-braces and the
     * test above starts depending on it.
     */
    const def = await db
      .prepare(`SELECT id FROM metric_definitions WHERE program_id = ? AND metric_type = 'text'`)
      .bind(programId)
      .first<{ id: string }>();
    const sub = await db
      .prepare(`SELECT rs.id FROM report_submissions rs
                  JOIN report_periods rp ON rp.id = rs.report_period_id
                 WHERE rp.award_id = ? LIMIT 1`)
      .bind(a)
      .first<{ id: string }>();
    await expect(
      db
        .prepare(
          `INSERT INTO metric_values (id, report_submission_id, metric_definition_id,
             value_int, value_real, value_text, created_at)
           VALUES (?,?,?, 99, NULL, 'Both at once', ?)`,
        )
        .bind(newId(), sub!.id, def!.id, nowIso())
        .run(),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it('keeps a genuine zero as a zero', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const a = await award(programId);
    await generateReportPeriods(db, adminCtx, a);
    await acceptedReport(programId, a, 0);

    /*
     * THE MIRROR OF THE TEST ABOVE, and the reason the null is computed from
     * SUM rather than from a count. A grantee who ran the program and
     * reached nobody has reported a real figure, and showing it as "nobody has
     * told us yet" would erase an answer they took the trouble to give.
     */
    const p = programOf(await impact(db, admin, nowIso()), programId);
    const served = p.metrics.find((m) => m.label === 'Individuals served')!;
    expect(served.total).toBe(0);
    expect(served.answered).toBe(1);
  });

  it('counts only reports a person has accepted', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const a = await award(programId);
    await generateReportPeriods(db, adminCtx, a);
    await acceptedReport(programId, a, 412);

    const before = programOf(await impact(db, admin, nowIso()), programId);
    expect(before.metrics.find((m) => m.label === 'Individuals served')!.total).toBe(412);

    /*
     * Sending a report back for revision withdraws its numbers. A figure that
     * no member of staff has read must not be in a published total, and one
     * that was read and then questioned must come straight back out.
     */
    await db
      .prepare(`UPDATE report_submissions SET accepted_at = NULL, accepted_by = NULL WHERE id IN
                  (SELECT rs.id FROM report_submissions rs
                     JOIN report_periods rp ON rp.id = rs.report_period_id
                    WHERE rp.award_id = ?)`)
      .bind(a)
      .run();

    const after = programOf(await impact(db, admin, nowIso()), programId);
    const served = after.metrics.find((m) => m.label === 'Individuals served')!;
    expect(served.total).toBeNull();
    expect(served.answered).toBe(0);
  });

  it('counts a grant nobody has asked for an update, separately', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const asked = await award(programId);
    await generateReportPeriods(db, adminCtx, asked);
    await award(programId); // never asked
    await award(programId); // never asked

    /*
     * THE THIRTEEN ARE ALL IN THIS BUCKET TODAY. Without it, a program
     * whose grants have no obligations shows "0 of 0 updates", which reads as
     * complete rather than as nothing having been asked -- the exact
     * misreading that would let an empty year be reported as a finished one.
     */
    const p = programOf(await impact(db, admin, nowIso()), programId);
    expect(p.grantsNeverAsked).toBe(2);
    expect(p.obligations).toBe(1);
  });

  it('files impact under the year it is FOR, not the year it was filed', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const a = await award(programId, 2_500_000, '2025');
    await generateReportPeriods(db, adminCtx, a);
    // Due in the new year, as a final report on a calendar-year grant is.
    await db
      .prepare(`UPDATE report_periods SET due_date = ? WHERE award_id = ?`)
      .bind(day('2026-01-31'), a)
      .run();
    await acceptedReport(programId, a, 412);

    /*
     * A 2025 grant year reported on in January 2026 is 2025 impact. Filing
     * late must not move a grantee's work into the following year's totals --
     * which would both overstate 2026 and leave 2025 looking emptier than it
     * was.
     */
    const y2025 = programOf(await impact(db, admin, nowIso(), 2025), programId);
    expect(y2025.metrics.find((m) => m.label === 'Individuals served')!.total).toBe(412);

    const y2026 = programOf(await impact(db, admin, nowIso(), 2026), programId);
    expect(y2026.metrics.find((m) => m.label === 'Individuals served')!.total).toBeNull();
  });

  it('offers the years that actually have obligations', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const a = await award(programId, 2_500_000, '2025');
    await generateReportPeriods(db, adminCtx, a);

    const out = await impact(db, admin, nowIso());
    expect(out.years).toContain(2025);
    expect(out.years.every((y) => Number.isInteger(y))).toBe(true);
  });

  it('counts a multi-period grant once in the money', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const a = await award(programId, 3_000_000);
    await generateReportPeriods(db, adminCtx, a);
    // A second obligation on the same grant, as a multi-year award carries.
    await db
      .prepare(
        `INSERT INTO report_periods (id, award_id, label, period_type, due_date,
           period_start, period_end, status, created_at, updated_at)
         VALUES (?,?,'Interim','interim',?,?,?, 'open', ?, ?)`,
      )
      .bind(newId(), a, day('2025-06-30'), day('2025-01-01'), day('2025-06-30'),
            nowIso(), nowIso())
      .run();

    /*
     * A grant with three obligations must not have its amount counted three
     * times. The coverage line reads "$30,000 of grants", and a tripled
     * figure there would overstate the money behind every impact number on
     * the screen.
     */
    const p = programOf(await impact(db, admin, nowIso()), programId);
    expect(p.obligations).toBe(2);
    expect(p.totalAwardedCents).toBe(3_000_000);
    // And the accepted sum uses the same EXISTS shape, so it cannot double
    // either once one of those periods is accepted.
    expect(p.acceptedAwardedCents).toBe(0);
  });

  it('counts each grant once, not once per obligation', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const a = await award(programId, 3_000_000);
    await generateReportPeriods(db, adminCtx, a);
    await db
      .prepare(
        `INSERT INTO report_periods (id, award_id, label, period_type, due_date,
           period_start, period_end, status, created_at, updated_at)
         VALUES (?,?,'Interim','interim',?,?,?, 'open', ?, ?)`,
      )
      .bind(newId(), a, day('2025-06-30'), day('2025-01-01'), day('2025-06-30'),
            nowIso(), nowIso())
      .run();

    /*
     * `grants` was asserted by nothing, so dropping the DISTINCT from
     * COUNT(DISTINCT w.id) -- which inflates it to one count per
     * (award, period) pair -- survived. A programme reporting twice as many
     * grants as it made is the denominator of every figure on the screen.
     */
    const p = programOf(await impact(db, admin, nowIso()), programId);
    expect(p.grants).toBe(1);
    expect(p.obligations).toBe(2);
  });

  it('keeps unasked grants out of the money the figures rest on', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const asked = await award(programId, 2_000_000);
    await generateReportPeriods(db, adminCtx, asked);
    await award(programId, 5_000_000); // never asked

    /*
     * The never-asked scenario never asserted the money, so dropping the
     * EXISTS from the denominator -- which would fold unasked grants into it
     * -- survived. The coverage line would then read "covering $0 of $70,000"
     * where $50,000 of that has not been asked for at all.
     */
    const p = programOf(await impact(db, admin, nowIso()), programId);
    expect(p.totalAwardedCents).toBe(2_000_000);
    expect(p.grantsNeverAsked).toBe(1);
  });

  it('does not count a refused grant toward coverage or money', async () => {
    const { admin, adminCtx, programId } = await scenario();
    const taken = await award(programId, 2_000_000);
    const refused = await award(programId, 9_000_000);
    await generateReportPeriods(db, adminCtx, taken);
    await generateReportPeriods(db, adminCtx, refused);
    await db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`).bind(refused).run();

    /*
     * A refused award keeps its generated report periods, so counted they
     * inflate both the obligation count and the money behind every figure --
     * "covering $X of $11,000" where $9,000 is a grant nobody took.
     */
    /*
     * And a refused grant with NO periods must not be counted among the ones
     * "never asked" either -- that figure is the Foundation's own outstanding
     * work, and a grant nobody took is not work.
     */
    await award(programId, 7_000_000).then((id) =>
      db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`).bind(id).run(),
    );

    const p = programOf(await impact(db, admin, nowIso()), programId);
    expect(p.obligations).toBe(1);
    expect(p.totalAwardedCents).toBe(2_000_000);
    expect(p.grantsNeverAsked).toBe(0);
  });

  it('is refused to a reviewer, an applicant and a grantee', async () => {
    for (const s of [reviewerSession(), applicantSession(newId())]) {
      expect((await appErrorFrom(impact(db, s, nowIso()))).code).toBe('FORBIDDEN');
    }
    const grantee = {
      userId: newId(), email: 'g@example.org', role: 'grantee' as const, organizationId: newId(),
    };
    expect((await appErrorFrom(impact(db, grantee, nowIso()))).code).toBe('FORBIDDEN');
  });
});
