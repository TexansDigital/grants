# Cloudflare Access setup

Staff sign in through Cloudflare Access. Applicants and grantees never do —
Access is capped at 50 seats and a seat is consumed by any authentication
event, so user 51 is blocked rather than billed. They get magic links in
Phase 2.

Everything here is done once, by a human, in the Cloudflare dashboard. Until
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, **every staff route returns 401**.
That is deliberate: an unconfigured deployment rejects everything rather than
accepting everything.

## 1. Create the Access application

Zero Trust → Access → Applications → Add an application → Self-hosted.

- **Application domain:** the hostname the Worker serves on.
- **Session duration:** 24 hours is reasonable for staff.
- **Policy:** Allow → Emails, or Emails ending in your domain. Start with the
  two people who will hold admin accounts.

## 2. Copy two values into `wrangler.toml`

After creating the application, Cloudflare shows:

- **Team domain**, e.g. `yourteam.cloudflareaccess.com` → `ACCESS_TEAM_DOMAIN`
- **Application Audience (AUD) tag**, a 64-character hex string → `ACCESS_AUD`

Neither is a secret. The team domain is a public hostname and the AUD tag is an
application identifier, not a credential — which is why they live in config,
where a missing value is visible, rather than in secrets, where it is silently
absent.

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
