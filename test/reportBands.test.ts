/**
 * The compliance desk's banding.
 *
 * The thing worth pinning is not the ordering, which is obvious, but the
 * promise: every row the server sends appears exactly once. The desk tells a
 * person "this is every obligation", and a status nobody anticipated must not
 * be able to quietly delete a nonprofit's report from it.
 */

import { describe, expect, it } from 'vitest';
import { bandsFor } from '../web/src/reportBands';
import type { PortfolioRow } from '../web/src/api';

function row(over: Partial<PortfolioRow> & { organizationName: string }): PortfolioRow {
  return {
    reportPeriodId: `rp-${over.organizationName}`,
    awardId: 'aw1',
    organizationId: 'og1',
    programName: 'Inspire Change',
    label: 'Final report',
    periodType: 'final',
    dueDate: '2026-12-03',
    status: 'scheduled',
    awardedAmountCents: 2_500_000,
    submittedAt: null,
    fundsSpentCents: null,
    daysUntilDue: 57,
    overdue: false,
    reminderCount: 0,
    reminderLastSentAt: null,
    ...over,
  };
}

const keys = (rows: PortfolioRow[]): string[] => bandsFor(rows).map((b) => b.key);

/** The first band, insisting there is one. `noUncheckedIndexedAccess` is on. */
function first(rows: PortfolioRow[]) {
  const bands = bandsFor(rows);
  const band = bands[0];
  if (!band) throw new Error('expected at least one band');
  return band;
}

function namesIn(rows: PortfolioRow[]): string[] {
  return first(rows).rows.map((r) => r.organizationName);
}

describe('bandsFor', () => {
  it('puts a filed report in our queue, not the grantee`s', () => {
    const rows = [row({ organizationName: 'A', status: 'submitted', submittedAt: '2026-09-20' })];
    const band = first(rows);
    expect(band.key).toBe('ours');
    expect(band.heading).toBe('Waiting on us');
  });

  /*
   * The server never marks a filed report overdue -- isOverdue returns false
   * for anything outside GRANTEE_OWES -- but if that ever changed, a report
   * already sitting with staff must not reappear as the nonprofit's failure.
   */
  it('keeps a filed report with us even if it arrives flagged overdue', () => {
    const rows = [row({ organizationName: 'A', status: 'submitted', overdue: true, daysUntilDue: -8 })];
    expect(keys(rows)).toEqual(['ours']);
  });

  it('separates late from merely owed', () => {
    const rows = [
      row({ organizationName: 'Soon', status: 'open', daysUntilDue: 10 }),
      row({ organizationName: 'Late', status: 'open', overdue: true, daysUntilDue: -4 }),
    ];
    expect(keys(rows)).toEqual(['late', 'coming']);
  });

  it('counts a sent-back report as the grantee`s again', () => {
    const rows = [row({ organizationName: 'A', status: 'revisions_requested', daysUntilDue: 5 })];
    expect(keys(rows)).toEqual(['coming']);
  });

  it('settles accepted and waived together', () => {
    const rows = [
      row({ organizationName: 'A', status: 'accepted', submittedAt: '2026-08-01' }),
      row({ organizationName: 'B', status: 'waived' }),
    ];
    const band = first(rows);
    expect(band.key).toBe('settled');
    expect(band.rows).toHaveLength(2);
  });

  it('omits a band with nothing in it rather than heading an empty list', () => {
    expect(keys([row({ organizationName: 'A' })])).toEqual(['coming']);
  });

  /* The promise. */
  it('shows every row exactly once, whatever its status', () => {
    const rows = [
      row({ organizationName: 'A', status: 'submitted', submittedAt: '2026-09-01' }),
      row({ organizationName: 'B', status: 'open', overdue: true, daysUntilDue: -2 }),
      row({ organizationName: 'C', status: 'scheduled' }),
      row({ organizationName: 'D', status: 'accepted', submittedAt: '2026-07-01' }),
      row({ organizationName: 'E', status: 'waived' }),
      row({ organizationName: 'F', status: 'invented_later' }),
    ];
    const out = bandsFor(rows).flatMap((b) => b.rows);
    expect(out).toHaveLength(rows.length);
    expect(new Set(out.map((r) => r.reportPeriodId)).size).toBe(rows.length);
  });

  it('names the band that caught an unknown status, rather than hiding it', () => {
    const only = first([row({ organizationName: 'F', status: 'invented_later' })]);
    expect(only.key).toBe('other');
    expect(only.blurb).toContain('incomplete');
  });

  it('puts the most overdue at the top of the late band', () => {
    const rows = [
      row({ organizationName: 'A', status: 'open', overdue: true, daysUntilDue: -2 }),
      row({ organizationName: 'B', status: 'open', overdue: true, daysUntilDue: -30 }),
    ];
    expect(namesIn(rows)).toEqual(['B', 'A']);
  });

  it('puts the longest-waiting at the top of our queue', () => {
    const rows = [
      row({ organizationName: 'Recent', status: 'submitted', submittedAt: '2026-09-20' }),
      row({ organizationName: 'Ancient', status: 'submitted', submittedAt: '2026-06-01' }),
    ];
    expect(namesIn(rows)).toEqual(['Ancient', 'Recent']);
  });

  it('breaks a tie on the organization name, so the order does not wander', () => {
    const rows = [
      row({ organizationName: 'Zed', status: 'scheduled', daysUntilDue: 5 }),
      row({ organizationName: 'Able', status: 'scheduled', daysUntilDue: 5 }),
    ];
    expect(namesIn(rows)).toEqual(['Able', 'Zed']);
  });

  it('does not reorder the caller`s array', () => {
    const rows = [
      row({ organizationName: 'Zed', status: 'scheduled', daysUntilDue: 5 }),
      row({ organizationName: 'Able', status: 'scheduled', daysUntilDue: 1 }),
    ];
    bandsFor(rows);
    expect(rows.map((r) => r.organizationName)).toEqual(['Zed', 'Able']);
  });
});
