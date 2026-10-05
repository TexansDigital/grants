# Running every check

Written after a full sweep found ten suites "failing" and nine of them were
the harness, not the product. A red suite that is red for the wrong reason
costs more than no suite at all: it teaches people to ignore the colour.

## The short version

    npm run verify

`check:config`, `typecheck` and the unit suite. No browser, no server, no
database. This is the one to run before every commit, and the one a CI job
should run.

## The whole thing

Three groups, and the group decides which server has to be running. Getting
this wrong is what produced nine false failures.

### 1. Self-contained — need nothing

Each starts its own static server and stubs the API in the browser.

    npm run build:web
    npm run e2e:staff e2e:claims e2e:rubric e2e:coverage
    npm run e2e:letters e2e:scorecards e2e:dashboard e2e:scoring e2e:offer

(Run them one at a time; the names above are a list, not a command.)

### 2. Against the staff Worker — need `npm run dev` on 8787

    npm run migrate:local && npm run seed:local
    npm run dev

then, in another terminal: `e2e:applicant`, `e2e:grantee`, `e2e:apply`,
`e2e:media`, `e2e:reminders`, `e2e:stages`, `e2e:pastgrantee`.

`e2e:applicant` additionally needs `npm run dev:web` on 5173.

### 3. Against the applicant hostname — needs `npm run dev:applicant`

    npm run dev:applicant

then `e2e:signin`. **Not `npm run dev`.** The two differ only in
APPLICANT_BASE_URL, and that one variable is what decides whether the Worker
serves the applicant surface or the staff one. Run this suite against plain
`dev` and it reports the hostname guard broken while the guard is fine.

### Not in any group

`e2e:a11y` needs a dev server on 5173 AND seeded ids passed in; see the script.
It covers the public and grantee pages only.

## What a failure here does and does not mean

**`e2e:apply` fails on "no console errors" behind a restrictive network.** The
page loads Turnstile from challenges.cloudflare.com; where that host is
blocked the browser logs ERR_TUNNEL_CONNECTION_FAILED and the check trips.
Nothing about the product. That suite's own header already says it proves
nothing about Turnstile either way.

**A timeout waiting for text is usually a stale stub, not a missing feature.**
Two of these were: a scoring stub that omitted `conflictClearedAt`, and an
offer stub whose catch-all `{}` exposed an undefined list. Both times the
server was right and the fixture had drifted from it. Before concluding the
product is broken, print the page body — the error boundary says what threw.

## What none of it covers

Email delivery, Turnstile actually issuing a token, R2 holding the objects the
database points at, screen readers, and security. Each needs its own
verification, and docs/STATUS.md tracks which have had one.
