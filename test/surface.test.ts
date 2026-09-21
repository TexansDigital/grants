/**
 * Which hostname may serve a route.
 *
 * Steward answers on two hostnames: `grants.` for staff behind Cloudflare
 * Access, and `apply.` for nonprofits, who must never touch Access because its
 * free tier stops at fifty seats and user fifty-one is blocked rather than
 * billed.
 *
 * Until this existed, the only thing separating those two surfaces was the
 * Access application's list of destinations -- a setting in a dashboard. That
 * setting was scoped to the WORKER rather than to a hostname, so the day a
 * second custom domain was added to the same Worker, Access silently began
 * covering the applicant hostname too. Nothing failed, nothing logged, and the
 * only way to find out was to make one HTTP request and read the redirect.
 *
 * The derivation below is the part worth protecting: a route that declares
 * staff roles is staff WITHOUT anyone having to mark it, so adding a staff
 * route later cannot widen the applicant surface by omission. That is the
 * opposite of how the dashboard behaved, deliberately.
 */

import { describe, it, expect } from 'vitest';
import { surfaceOf, type Route } from '../src/lib/router';
import { routes } from '../src/index';

const route = (over: Partial<Route>): Route => ({
  method: 'GET',
  path: '/whatever',
  roles: [],
  handler: async () => new Response(''),
  ...over,
});

describe('surfaceOf', () => {
  it('defaults a non-public route to staff', () => {
    // THE IMPORTANT ONE. Forgetting to mark a new staff route must fail
    // closed -- refused on the applicant hostname -- not open.
    expect(surfaceOf(route({ roles: ['admin'] }))).toBe('staff');
  });

  it('defaults a route with no roles at all to staff, if it is not public', () => {
    expect(surfaceOf(route({}))).toBe('staff');
  });

  it('treats a magic-link route as the applicant surface', () => {
    expect(surfaceOf(route({ auth: 'applicant', roles: ['grantee'] }))).toBe('applicant');
  });

  it('treats a public route as belonging to both', () => {
    // /health, the open-cycles list, the sign-in endpoints. These belong to no
    // one surface and refusing them on either would break something real.
    expect(surfaceOf(route({ public: true }))).toBe('both');
  });

  it('lets an explicit marker override the derivation', () => {
    // The case derivation cannot get right: a PUBLIC app shell whose every
    // data endpoint is staff-only, such as the form preview.
    expect(surfaceOf(route({ public: true, surface: 'staff' }))).toBe('staff');
  });

  it('honours an explicit marker even against a staff-looking route', () => {
    expect(surfaceOf(route({ roles: ['admin'], surface: 'applicant' }))).toBe('applicant');
  });
});

/*
 * The staff app's deep links.
 *
 * These were missing entirely: every staff screen worked by in-app navigation
 * and 404'd if the address was typed, bookmarked, or followed from an email.
 * The retention notice links to /retention, so the email would have landed on
 * a 404 on the night it said to act.
 */
describe('staff deep links', () => {
  const STAFF_SHELLS = [
    '/pipeline',
    '/configuration',
    '/data-health',
    '/retention',
    '/applications/:id',
    '/programs/:id/rubrics',
    '/my-reviews',
    '/my-reviews/:id/score',
    '/cycles/:id/letters',
  ];

  it('every staff screen has a route, so a typed address reaches the app', () => {
    for (const path of STAFF_SHELLS) {
      const route = routes.find((r) => r.path === path && r.method === 'GET');
      expect(route, `${path} has no route: typing it 404s`).toBeDefined();
    }
  });

  it('and none of them is served on the applicant hostname', () => {
    // A staff-looking page on apply.<domain> renders a frame that then fails,
    // which reads to a nonprofit as a broken system rather than a boundary.
    for (const path of STAFF_SHELLS) {
      const route = routes.find((r) => r.path === path && r.method === 'GET')!;
      expect(surfaceOf(route), `${path} is reachable from apply.`).toBe('staff');
    }
  });
});
