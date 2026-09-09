import { describe, it, expect } from 'vitest';
import { configProblems } from '../src/lib/configCheck';
import WRANGLER from '../wrangler.toml?raw';

/**
 * These tests exist because this project has twice shipped a wrangler.toml
 * guard that silently matched nothing, and both times it was found by accident.
 * A guard verified by running it once by hand is not verified.
 *
 * Every case below mutates the REAL wrangler.toml rather than a hand-written
 * fixture, so a check cannot pass by asserting against a file shaped to suit
 * it, and a restructure of the real config surfaces here.
 */
const real = WRANGLER as unknown as string;

/** Replace the first occurrence, failing loudly if the anchor has moved. */
function edit(from: string, to: string, src = real): string {
  if (!src.includes(from)) throw new Error(`anchor no longer present: ${from}`);
  return src.replace(from, to);
}

const failsWith = (src: string, pattern: RegExp) => {
  const problems = configProblems(src);
  expect(problems.join('\n')).toMatch(pattern);
};

describe('the real wrangler.toml', () => {
  it('passes its own guards', () => {
    expect(configProblems(real)).toEqual([]);
  });
});

describe('non-negotiable #2: preview bindings only', () => {
  it('catches a default D1 binding pointed at a different database', () => {
    failsWith(
      edit('preview_database_id = "f5be3d5c-642c-4706-b9e6-bdd8e0c9858e"',
           'preview_database_id = "00000000-0000-0000-0000-000000000000"'),
      /database_id/i,
    );
  });

  it('catches staging reusing a preview resource', () => {
    failsWith(
      edit('database_name = "steward-staging"\ndatabase_id = ',
           'database_name = "steward-staging"\ndatabase_id2 = ')
        .replace('bucket_name = "steward-staging-files"', 'bucket_name = "steward-preview-files"'),
      /staging reuses the preview resource/,
    );
  });
});

describe('non-negotiable #8: no secrets in the repo', () => {
  it('catches a named secret assigned in the file', () => {
    failsWith(edit('[vars]', '[vars]\nRESEND_API_KEY = "abc"'), /RESEND_API_KEY/);
  });

  it('catches a credential-shaped value under a name nobody listed', () => {
    // The four-name list cannot know a name nobody has thought of yet.
    failsWith(edit('[vars]', '[vars]\nMAILER_TOKEN = "re_livekey_9f2c41d9b7e6"'), /shaped like a credential/);
  });

  it('does not fire on the public Access audience tag, which is 64 hex chars', () => {
    // The guard that would flag this is the reason for the allowlist. If this
    // test starts failing, the allowlist has been dropped, not fixed.
    expect(configProblems(real)).toEqual([]);
  });

  it('still refuses a provider-prefixed value even on an allowlisted key', () => {
    failsWith(edit('ACCESS_AUD = "', 'ACCESS_AUD = "re_livekey_'), /shaped like a credential/);
  });
});

describe('the staging email guard', () => {
  it('catches a real EMAIL_FROM on staging', () => {
    failsWith(
      edit('EMAIL_FROM = ""', 'EMAIL_FROM = "grants@houstontexansfoundation.org"'),
      /staging sets EMAIL_FROM/,
    );
  });

  it('is not satisfied by a comment that merely contains the string', () => {
    // The earlier version was a presence check over the raw text, so a comment
    // reading `# was: EMAIL_FROM = ""` made a real address pass.
    failsWith(
      edit('EMAIL_FROM = ""', '# was: EMAIL_FROM = ""\nEMAIL_FROM = "grants@real.org"'),
      /staging sets EMAIL_FROM/,
    );
  });

  it('catches EMAIL_FROM being removed from staging entirely', () => {
    failsWith(edit('EMAIL_FROM = ""\nEMAIL_REPLY_TO = ""', 'EMAIL_REPLY_TO = ""'),
      /staging does not set EMAIL_FROM/);
  });

  it('fails loudly rather than silently when [env.staging] is renamed', () => {
    // The old guard skipped itself when the section was not found, so renaming
    // the section disabled it. That is the failure mode this file exists for.
    failsWith(
      real.replace('[env.staging]', '[env.stage]').replace(/\[env\.staging\./g, '[env.stage.'),
      /no \[env\.staging\] section found/,
    );
  });
});

describe('the hostname surface', () => {
  it('catches workers_dev being turned back on', () => {
    failsWith(edit('workers_dev = false', 'workers_dev = true'), /workers_dev/);
  });

  it('catches a top-level key pushed below a [table] header', () => {
    // The original bug: TOML assigns it to the table and wrangler ignores it.
    failsWith(
      edit('workers_dev = false\npreview_urls = false', 'preview_urls = false')
        .replace('[observability]\nenabled = true', '[observability]\nenabled = true\nworkers_dev = false'),
      /workers_dev/,
    );
  });

  it('catches a named environment that would inherit the live hostname', () => {
    failsWith(edit('[env.staging]\nname = "steward-staging"\n', '[env.staging]\nname = "steward-staging"\nXX = 1\n')
      .replace('routes = []\n\n[env.staging.vars]', '\n[env.staging.vars]'), /routes/);
  });
});

describe('production stays un-deployable from a checkout', () => {
  it('catches a real production id committed to the file', () => {
    failsWith(
      edit('database_id = "FILL_IN_AT_DEPLOY_TIME_DO_NOT_COMMIT"',
           'database_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"'),
      /placeholder/i,
    );
  });
});
