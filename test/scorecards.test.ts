/**
 * The offline scorecard.
 *
 * WHAT CLAUDE.MD SAYS THIS IS: a fallback so a consultant does not block a
 * decision, and explicitly NOT the normal path, because uploaded scorecards
 * "drift from the rubric, carry no conflict declaration, and produce no audit
 * trail".
 *
 * Two of those three are fixable and these tests are mostly about them. The
 * drift is the dangerous one: a file filled in against last year's rubric
 * looks exactly like one filled in against this year's, right up to the point
 * where the scores land against the wrong criteria and the totals are wrong in
 * a way nobody can see.
 *
 * The third is not fixable. A spreadsheet emailed back carries no evidence
 * that the person who filled it in was the person it was sent to, and no
 * moment at which they were asked about a conflict. That is why this stays the
 * exception, and no test can change it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { createRubric, replaceCriteria, publishRubric, attachRubricToCycle, newDraftFrom } from '../src/lib/rubrics';
import { assignReviewer, declareConflict, recuse } from '../src/lib/reviewAssign';
import { loadScoringSheet, saveScores, completeReview } from '../src/lib/scoring';
import { decideApplication } from '../src/lib/decisions';
import { exportScorecard, planScorecardImport, applyScorecardImport } from '../src/lib/scorecards';
import type { Session } from '../src/types';

let n = 0;
let admin: Session;

async function user(role: 'admin' | 'reviewer'): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?,?, NULL, 1, ?, ?)`,
    )
    .bind(id, `${role}-${crypto.randomUUID().slice(0, 8)}@example.org`, role, now, now)
    .run();
  return id;
}

beforeEach(async () => {
  admin = adminSession(await user('admin'));
});

const ctx = () => ctxFor(admin);

const CRITERIA = [
  { criterionKey: 'community_need', label: 'Critical community need', weightBp: 30000, maxScore: 10 },
  { criterionKey: 'measurable_outcomes', label: 'Measurable outcomes', weightBp: 20000, maxScore: 10 },
  { criterionKey: 'capacity', label: 'Capacity to deliver', weightBp: 10000, maxScore: 5 },
];

/** A cycle with a published rubric, two applications, and one reviewer on both. */
async function cycleWithReviewer() {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `card-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;

  const { rubricId } = await createRubric(db, ctx(), admin, {
    programId: p.programId, name: 'Scoring', rubricKey: 'scoring',
  });
  await replaceCriteria(db, ctx(), admin, rubricId, CRITERIA);
  await publishRubric(db, ctx(), admin, rubricId);
  await attachRubricToCycle(db, ctx(), admin, cycleId, rubricId);

  const reviewerId = await user('reviewer');
  const apps = [];
  for (const label of ['Alpha', 'Beta']) {
    const orgId = newId();
    const applicationId = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?,'active',?,?)`,
      )
      .bind(orgId, `Invented ${label} ${n}`, String(930000000 + ++n), now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, submitted_at, project_title, created_at, updated_at)
         SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?, ?
           FROM form_definitions fd WHERE fd.id = ?`,
      )
      .bind(applicationId, cycleId, orgId, now, `${label}, a "quoted" project`, now, now, p.formDefinitionIds.application!)
      .run();
    const assignment = await assignReviewer(db, ctx(), admin, applicationId, reviewerId);
    apps.push({ applicationId, orgId, assignmentId: assignment.id });
  }

  return {
    programId: p.programId, cycleId, rubricId, reviewerId,
    reviewer: reviewerSession(reviewerId), apps,
  };
}

/** Fill every score column in an exported scorecard with the same value. */
function fill(csv: string, score: string | ((row: string[]) => string)): string {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]!.split(',');
  const scoreAt = header.indexOf('score');
  return [
    lines[0]!,
    ...lines.slice(1).map((line) => {
      // Naive split is fine for these fixtures except where a quoted field
      // contains a comma, which the project titles deliberately do -- so parse
      // with the same rules the importer uses.
      const cells = parseLine(line);
      cells[scoreAt] = typeof score === 'string' ? score : score(cells);
      return cells
        .map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
        .join(',');
    }),
  ].join('\r\n');
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------

describe('the export', () => {
  it('is one row per application per criterion, stamped with the rubric version', async () => {
    /*
     * NOT A GRID with criteria as columns. A grid is nicer to look at and
     * impossible to validate: a reviewer who inserts a column, or whose
     * spreadsheet reorders them, produces a file whose scores are silently
     * against the wrong criteria. A long file carries the key on every row.
     */
    const s = await cycleWithReviewer();
    const out = await exportScorecard(db, s.reviewer, s.cycleId, s.reviewerId);
    const lines = out.csv.trim().split(/\r?\n/);
    expect(lines.length).toBe(1 + 2 * CRITERIA.length);
    expect(lines[0]).toContain('rubric_version');
    expect(out.filename).toMatch(/^scorecard-.*-v1\.csv$/);

    const first = parseLine(lines[1]!);
    const header = lines[0]!.split(',');
    expect(first[header.indexOf('rubric_version')]).toBe('1');
    expect(first[header.indexOf('rubric_id')]).toBe(s.rubricId);
  });

  it('quotes a project title containing a comma and a quote', async () => {
    // An applicant chooses that string. A naive join turns one field into two
    // and every column after it shifts, silently.
    const s = await cycleWithReviewer();
    const out = await exportScorecard(db, s.reviewer, s.cycleId, s.reviewerId);
    const lines = out.csv.trim().split(/\r?\n/);
    expect(lines[1]).toContain('""quoted""');
    for (const line of lines.slice(1)) {
      expect(parseLine(line).length).toBe(lines[0]!.split(',').length);
    }
  });

  it('carries scores already entered in the app', async () => {
    // A reviewer who scored three in the app and takes the rest offline
    // should not have to retype the three.
    const s = await cycleWithReviewer();
    const ids = (await loadScoringSheet(db, s.reviewer, s.apps[0]!.assignmentId)).criteria;
    await saveScores(db, ctx(), s.reviewer, s.apps[0]!.assignmentId, [
      { criterionId: ids[0]!.id, score: 7, comment: 'solid' },
    ]);
    const out = await exportScorecard(db, s.reviewer, s.cycleId, s.reviewerId);
    expect(out.csv).toContain('solid');
    expect(out.csv).toMatch(/,7,solid/);
  });

  it('leaves out an application the reviewer declared a conflict on', async () => {
    const s = await cycleWithReviewer();
    await declareConflict(db, ctx(), s.reviewer, s.apps[0]!.assignmentId, 'I sit on their board');
    const out = await exportScorecard(db, s.reviewer, s.cycleId, s.reviewerId);
    expect(out.rows).toBe(CRITERIA.length);
    expect(out.csv).not.toContain(s.apps[0]!.assignmentId);
  });

  it('refuses to export a scorecard belonging to somebody else', async () => {
    const s = await cycleWithReviewer();
    const stranger = reviewerSession(await user('reviewer'));
    expect(
      (await appErrorFrom(exportScorecard(db, stranger, s.cycleId, s.reviewerId))).code,
    ).toBe('NOT_FOUND');
    // An admin may: sending a consultant their scorecard is the whole point.
    expect((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).rows).toBeGreaterThan(0);
  });
});

describe('the rubric stamp', () => {
  it('refuses a file made for a different rubric version, before reading any score', async () => {
    /*
     * THE BUG THIS PREVENTS, and the reason the stamp exists at all. A file
     * filled in against version 1 looks exactly like one for version 2. The
     * scores land against whatever criterion keys happen to match, the rest
     * are dropped, and the totals are wrong invisibly.
     *
     * ONE fatal issue, not sixty row errors that all trace back to it.
     */
    const s = await cycleWithReviewer();
    const stale = fill(await (await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '5');

    const next = await newDraftFrom(db, ctx(), admin, s.rubricId);
    await publishRubric(db, ctx(), admin, next.rubricId);
    await attachRubricToCycle(db, ctx(), admin, s.cycleId, next.rubricId);

    const plan = await planScorecardImport(db, admin, s.cycleId, stale);
    expect(plan.ok).toBe(false);
    expect(plan.issues.length).toBe(1);
    expect(plan.issues[0]!.message).toMatch(/different rubric \(version 1\)/);
    expect(plan.issues[0]!.message).toMatch(/version 2/);
  });

  it('refuses a file that mixes two rubric versions', async () => {
    const s = await cycleWithReviewer();
    const csv = fill(await (await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '5');
    const lines = csv.split(/\r?\n/);
    const header = lines[0]!.split(',');
    const at = header.indexOf('rubric_version');
    const cells = parseLine(lines[2]!);
    cells[at] = '9';
    lines[2] = cells.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');

    const plan = await planScorecardImport(db, admin, s.cycleId, lines.join('\r\n'));
    expect(plan.ok).toBe(false);
    expect(plan.issues[0]!.message).toMatch(/more than one rubric version/i);
  });

  it('refuses a hand-built file missing the stamp', async () => {
    const s = await cycleWithReviewer();
    const plan = await planScorecardImport(
      db, admin, s.cycleId,
      'assignment_id,criterion_key,score\r\nx,community_need,5\r\n',
    );
    expect(plan.ok).toBe(false);
    expect(plan.issues[0]!.message).toMatch(/rubric_id, rubric_version/);
    expect(plan.issues[0]!.message).toMatch(/Export a fresh scorecard/);
  });
});

describe('what the plan refuses, row by row', () => {
  it('refuses a score outside the criterion ceiling', async () => {
    const s = await cycleWithReviewer();
    const csv = fill(
      (await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv,
      (cells) => (cells[6] === 'capacity' ? '9' : '5'),
    );
    const plan = await planScorecardImport(db, admin, s.cycleId, csv);
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => /between 0 and 5/.test(i.message))).toBe(true);
  });

  it('refuses a fractional score', async () => {
    const s = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '4.5');
    const plan = await planScorecardImport(db, admin, s.cycleId, csv);
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => /whole number/.test(i.message))).toBe(true);
  });

  it('refuses a conflict declared after the file went out', async () => {
    /*
     * THE CASE THIS IS REALLY FOR. The scorecard was emailed on Monday; on
     * Wednesday the consultant realised they know the executive director and
     * said so. Importing the file anyway writes a score from somebody who has
     * since said they should not be scoring it.
     */
    const s = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '5');
    await declareConflict(db, ctx(), s.reviewer, s.apps[0]!.assignmentId, 'I know the ED');

    const plan = await planScorecardImport(db, admin, s.cycleId, csv);
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => /declared a conflict/.test(i.message))).toBe(true);
  });

  it('refuses a recused reviewer and a decided application', async () => {
    const s = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '5');
    await recuse(db, ctx(), admin, s.apps[0]!.assignmentId, 'board member');
    await decideApplication(db, ctx(), admin, s.apps[1]!.applicationId, {
      status: 'declined', notes: 'Outside the focus area.',
    });

    const plan = await planScorecardImport(db, admin, s.cycleId, csv);
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => /was recused/.test(i.message))).toBe(true);
    expect(plan.issues.some((i) => /already been decided/.test(i.message))).toBe(true);
  });

  it('refuses a criterion repeated for the same application', async () => {
    // A copy-paste. Picking one silently is how the wrong number wins.
    const s = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '5');
    const lines = csv.split(/\r?\n/);
    const plan = await planScorecardImport(
      db, admin, s.cycleId, [...lines, lines[1]!].join('\r\n'),
    );
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => /appears twice/.test(i.message))).toBe(true);
  });

  it('refuses an assignment from another cycle', async () => {
    const a = await cycleWithReviewer();
    const b = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, a.cycleId, a.reviewerId)).csv, '5');
    // Point the file at cycle b, whose rubric happens to share the same keys.
    const plan = await planScorecardImport(db, admin, b.cycleId, csv);
    expect(plan.ok).toBe(false);
  });

  it('refuses a reviewer entirely', async () => {
    const s = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '5');
    expect(
      (await appErrorFrom(planScorecardImport(db, s.reviewer, s.cycleId, csv))).code,
    ).toBe('NOT_FOUND');
  });
});

describe('applying a clean file', () => {
  it('writes the scores and the same audit rows as in-app scoring', async () => {
    /*
     * CLAUDE.md's third objection to offline scorecards is that they "produce
     * no audit trail". The import writes through saveScores, the same function
     * the in-app sheet uses, so it gets the same range checks, the same
     * update-rather-than-replace, and the same audit row -- naming the admin
     * who imported it AND the reviewer it belongs to.
     */
    const s = await cycleWithReviewer();
    const csv = fill(
      (await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv,
      (cells) => (cells[6] === 'capacity' ? '3' : '8'),
    );

    const plan = await planScorecardImport(db, admin, s.cycleId, csv);
    expect(plan.ok).toBe(true);
    expect(plan.assignments.length).toBe(2);
    expect(plan.totalScores).toBe(6);

    const result = await applyScorecardImport(db, ctx(), admin, s.cycleId, csv);
    expect(result.assignments).toBe(2);

    const sheet = await loadScoringSheet(db, s.reviewer, s.apps[0]!.assignmentId);
    expect(sheet.criteria.map((c) => c.score)).toEqual([8, 8, 3]);
    // 8*30000 + 8*20000 + 3*10000
    expect(sheet.totalSoFarBp).toBe(430_000);

    const audited = await db
      .prepare(
        `SELECT after_json FROM audit_log
          WHERE action = 'review.score_saved' AND entity_id = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(s.apps[0]!.assignmentId)
      .first<{ after_json: string }>();
    const after = JSON.parse(audited!.after_json) as Record<string, string>;
    expect(after.actor_user_id).toBe(admin.userId);
    expect(after.reviewer_user_id).toBe(s.reviewerId);
  });

  it('counts an unchanged row as unchanged rather than as a write', async () => {
    const s = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '4');
    await applyScorecardImport(db, ctx(), admin, s.cycleId, csv);

    const second = await planScorecardImport(db, admin, s.cycleId, csv);
    expect(second.totalScores).toBe(0);
    expect(second.assignments.every((a) => a.scored === 0 && a.unchanged > 0)).toBe(true);
  });

  it('applies the number the preview promised, not every cell in the file', async () => {
    /*
     * THE BUG THIS PREVENTS. `applied` was the sum of what saveScores reported
     * saving, which is every cell sent -- including the ones the plan had
     * already worked out were identical to what was there. So the preview said
     * "8 scores to import", the confirmation afterwards said "23 applied", and
     * the two numbers describing the same file disagreed by the number of
     * unchanged rows. Somebody reconciling a consultant's scorecard against
     * what landed has to assume one of them is wrong, and the larger one reads
     * like a mistake was made with their reviewer's scores.
     */
    const s = await cycleWithReviewer();
    const first = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '4');
    await applyScorecardImport(db, ctx(), admin, s.cycleId, first);

    // Re-export so the file carries what is now stored, then change exactly
    // one cell. Every other row in it is unchanged.
    const exported = (await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv;
    const scoreAt = exported.trim().split(/\r?\n/)[0]!.split(',').indexOf('score');
    const second = fill(exported, (cells) =>
      cells[6] === 'capacity' ? '2' : cells[scoreAt]!,
    );
    const plan = await planScorecardImport(db, admin, s.cycleId, second);
    expect(plan.totalScores).toBeGreaterThan(0);

    const result = await applyScorecardImport(db, ctx(), admin, s.cycleId, second);
    expect(result.applied).toBe(plan.totalScores);
    expect(result.applied).toBe(result.plan.totalScores);
  });

  it('treats an emptied score cell as cleared, not as zero', async () => {
    // The same rule as the in-app sheet. Zero is a judgement; blank is the
    // absence of one, and a scorecard returned with one cell blank must not
    // silently enter a nought.
    const s = await cycleWithReviewer();
    // 4, not 6: the capacity criterion is out of 5, and a fixture that
    // exceeds a ceiling tests the ceiling rather than the blank.
    await applyScorecardImport(
      db, ctx(), admin, s.cycleId,
      fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '4'),
    );
    await applyScorecardImport(
      db, ctx(), admin, s.cycleId,
      fill(
        (await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv,
        (cells) => (cells[6] === 'capacity' ? '' : '4'),
      ),
    );
    const sheet = await loadScoringSheet(db, s.reviewer, s.apps[0]!.assignmentId);
    expect(sheet.criteria.map((c) => c.score)).toEqual([4, 4, null]);
  });

  it('refuses to apply a file with ANY issue', async () => {
    /*
     * A partial import leaves a review that is neither what the reviewer sent
     * nor what was there before, and nobody can tell which rows landed.
     */
    const s = await cycleWithReviewer();
    const csv = fill(
      (await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv,
      (cells) => (cells[6] === 'capacity' ? '99' : '5'),
    );
    const err = await appErrorFrom(applyScorecardImport(db, ctx(), admin, s.cycleId, csv));
    expect(err.code).toBe('VALIDATION_FAILED');

    const sheet = await loadScoringSheet(db, s.reviewer, s.apps[0]!.assignmentId);
    expect(sheet.criteria.every((c) => c.score === null)).toBe(true);
  });

  it('refuses to overwrite a review the reviewer has already submitted', async () => {
    /*
     * THE SAME HOLE, BY THE OTHER DOOR. The import writes through saveScores,
     * so an admin uploading a CSV could silently replace a consultant's
     * submitted scores and the review would still read as completed. Fixing
     * saveScores closed both; this is the test that says so for the import
     * path, which is the one somebody would not think to check.
     */
    const s = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '4');
    const ids = (await loadScoringSheet(db, s.reviewer, s.apps[0]!.assignmentId)).criteria;
    for (const c of ids) {
      await saveScores(db, ctx(), s.reviewer, s.apps[0]!.assignmentId, [
        { criterionId: c.id, score: 1 },
      ]);
    }
    await completeReview(db, ctx(), s.reviewer, s.apps[0]!.assignmentId);

    const err = await appErrorFrom(applyScorecardImport(db, ctx(), admin, s.cycleId, csv));
    expect(err.code).toBe('VALIDATION_FAILED');

    // The submitted scores are untouched.
    const sheet = await loadScoringSheet(db, s.reviewer, s.apps[0]!.assignmentId);
    expect(sheet.criteria.map((c) => c.score)).toEqual([1, 1, 1]);
  });

  it('re-checks at apply time rather than trusting the preview', async () => {
    /*
     * The plan is a description, not a token. Between the preview and the
     * click somebody may declare a conflict, decide the application, or give
     * the cycle a new rubric -- all of which make the file wrong, and all of
     * which are cheap to re-check.
     */
    const s = await cycleWithReviewer();
    const csv = fill((await exportScorecard(db, admin, s.cycleId, s.reviewerId)).csv, '5');
    expect((await planScorecardImport(db, admin, s.cycleId, csv)).ok).toBe(true);

    await declareConflict(db, ctx(), s.reviewer, s.apps[0]!.assignmentId, 'I know the ED');
    expect(
      (await appErrorFrom(applyScorecardImport(db, ctx(), admin, s.cycleId, csv))).code,
    ).toBe('VALIDATION_FAILED');
  });
});
