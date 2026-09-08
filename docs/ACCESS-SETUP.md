# Cloudflare Access setup

Staff sign in through Cloudflare Access. Applicants and grantees never do —
Access is capped at 50 seats and a seat is consumed by any authentication
event, so user 51 is blocked rather than billed. They get magic links in
Phase 2.

Everything here is done once, by a human, in the Cloudflare dashboard. Until
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, **every staff route returns 401**.
That is deliberate: an unconfigured deployment rejects everything rather than
accepting everything.

## 0. What the two config values actually are

`wrangler.toml` needs `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Both are Cloudflare
terms rather than general ones, so in plain language:

**Team domain.** When you turn on Cloudflare Zero Trust you choose a team name
once -- say `texans`. The team domain is then `texans.cloudflareaccess.com`. It
is the address staff are sent to in order to sign in. There is one per
Cloudflare account, and it is also just the URL you see when you sign in to Zero
Trust yourself.

**AUD tag.** Short for *audience*. Every Access application gets its own
64-character hex string. It is how this Worker knows a sign-in was for THIS
application and not some other application on the same account -- a token minted
for a different app is correctly signed and must still be refused.

Neither is a credential. The team domain is a public hostname and the AUD tag is
an identifier, which is why both live in checked-in config where a missing value
is obvious, rather than in secrets where it would be silently absent.

**If Zero Trust has never been set up on this account:** open the Cloudflare
dashboard and choose Zero Trust in the sidebar. It asks you to pick a team name;
whatever you type becomes the team domain. Choose the free plan -- staff fit well
inside the 50-seat limit, and applicants never touch Access.

## 0b. Deploy the Worker first

Access points at a destination that must already exist. Create the Access
application AFTER the Worker is deployed, not before.

    npm run deploy:preview

Deploying before Access is in front of it is safe by design: `/health` returns a
status and nothing else, and every `/api/*` route returns 401 because the Access
variables below are empty and the code fails closed.

If the deploy uploads the Worker but then fails on
`/workers/scripts/steward/subdomain` with "This Worker does not exist on your
account", either retry (there is a propagation race on a script's first upload)
or check that the account has a workers.dev subdomain at all -- every Cloudflare
account chooses one once, under Workers & Pages, and a Worker cannot get a
hostname until it exists.

## 1. Create the Access application

Zero Trust → Access → Applications → Add an application → Self-hosted.

- **Application type:** "Self-hosted and private", then the **Workers**
  sub-tab. Access protects a Worker directly, so no custom domain is needed to
  get started -- the destination is the `workers.dev` hostname. "Public DNS"
  is the wrong tab here: it wants a hostname in a zone on your account.
- **Session duration:** see the note on identity providers below. 30 days is
  the right answer if you are using One-time PIN.
- **Policy:** Allow → Emails, listing the people who will hold admin accounts.

## 2. Find the two values

**Team domain:** Zero Trust → Settings → Custom Pages (labelled General in some
dashboard versions). Look for "Team domain".

**AUD tag:** open the application you just created; its Overview tab shows
"Application Audience (AUD) Tag" with a copy button. This only exists after the
application is saved.

Put them in `wrangler.toml` as `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.

## 2a. Choosing an identity provider

Access needs an *identity provider* — something that establishes who a person
is. Duo, Google Authenticator and Microsoft Authenticator are MFA factors, not
identity providers: they add a second proof after an IdP has already identified
someone, so they cannot front Access on their own.

The choice is reversible at zero cost. Access verification checks a signed
assertion, and that assertion is identical whichever IdP produced it, so
switching later is a dashboard change with no code change and no migration.

**One-time PIN** is the default and needs no integration. Cloudflare emails a
six-digit code. Two things make it workable if corporate mail filtering has
eaten these before:

- ask IT to allowlist the Cloudflare sender (confirm the exact envelope sender
  from a test send rather than assuming it)
- set the Access session to 30 days, so staff authenticate roughly monthly
  instead of daily -- across two admins that is a couple of dozen emails a year

**Okta, or any SAML/OIDC provider**, removes email from the login path entirely
and lets existing MFA sit behind it. Offboarding someone in the directory also
removes their access here. This is the better long-term answer.

**Microsoft Entra ID** is the least-effort option for an organisation already on
Microsoft 365, but it is not required.

Starting on One-time PIN and moving to a real IdP later is a legitimate
sequence, not technical debt.

## 3. Create the staff accounts

An email that Access authenticates is **not** automatically a staff account.
Access answers "is this a person our policy admits". It does not answer "should
this person see other nonprofits' audited financial statements". Adding a staff
member is deliberately two steps.

    npm run admin:sql -- first.admin@yourdomain.com second.admin@yourdomain.com
    npm run admin:apply

Two from day one is a continuity requirement. A single admin unavailable during
an open cycle means nobody can extend a deadline, answer an applicant, or record
a decision.

The email in the user row must match the email Access asserts, exactly. Both are
lower-cased before comparison.

## 4. Verify

    curl https://<your-worker>/health

`/health` is public and touches D1, so it proves the Worker and database are
both reachable.

    curl https://<your-worker>/api/session

Should be **401** from a plain curl — there is no Access assertion. Open the
same URL in a browser: Access challenges you, and afterwards it returns your
email and role.

If it returns **404** after signing in, Access verified you but there is no
matching user row. Re-check step 3 and the email spelling.

## What is deliberately not trusted

- **`Cf-Access-Authenticated-User-Email`.** A convenience header, forgeable by
  anything that reaches the Worker directly on its `workers.dev` hostname,
  bypassing Access. Only the signed `Cf-Access-Jwt-Assertion` is verified.
- **The JWT payload before its signature is checked.**
- **The `alg` header.** Only RS256 is accepted; `none` and HS256 are refused,
  which is what stops algorithm-confusion attacks.
- **A token minted for a different Access application** in the same account. The
  audience tag is checked against `ACCESS_AUD`.

## Locking down the workers.dev hostname

Access protects the hostname you attach the policy to. The default
`*.workers.dev` hostname is reachable independently. Either disable it
(`workers_dev = false` once a custom domain exists) or add an Access policy
covering it too. Until then the API still rejects unauthenticated requests on
its own — that is the point of verifying the assertion in the Worker rather than
trusting that Access is in front — but the surface should not be left open.
