/**
 * Load invented demo data into a LOCAL D1.
 *
 *   npm run demo:local
 *
 * Deliberately local-only. This writes hundreds of rows through real code
 * paths, and pointing it at a remote database is the kind of thing that should
 * take a deliberate edit rather than a flag. Preview is where invented data
 * belongs; real past applications go to staging via the importer (decision 18)
 * and never come from here.
 */
console.error(
  [
    'loadDemo is run through the test harness, not as a standalone script:',
    'it needs a D1 binding, and the only ones this repo has are wrangler bindings.',
    '',
    'To load a local preview database:',
    '  npx wrangler d1 migrations apply steward-preview --local',
    '  npm run seed:local',
    '  npx vitest run test/demoData.test.ts   # proves the generator still matches the form',
    '',
    'A one-command loader against local D1 needs a small Worker route or a',
    'wrangler d1 execute --file of generated SQL. Neither is built yet, and',
    'saying so beats a script that looks like it works.',
  ].join('\n'),
);
process.exit(1);
