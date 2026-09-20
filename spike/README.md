# Phase A spike — can a browser upload straight to Google Drive?

**This is throwaway code.** It exists to answer one question before anything is
built on top of the answer. When it has answered it, delete `spike/`,
`wrangler.spike.toml`, the `spike` line in `package.json` and the
`spike/**/*.ts` entry in `tsconfig.json`.

## The question

A file body cannot pass through the Worker. Cloudflare rejects a large request
body *before* our handler runs, so a design that proxies uploads fails on
exactly the files people care about — a 40 MB audited financial statement. That
is why R2 uploads go direct from the browser with a presigned PUT, and CLAUDE.md
records it as learned the hard way.

Google's equivalent is a **resumable session**: the Worker asks Drive for a
session URI using its service-account credentials, hands that URI to the
browser, and the browser PUTs the bytes to it carrying no credentials of its
own.

Whether a browser is *allowed* to make that PUT cross-origin is the part we
cannot settle by reading. Unlike R2 there is no CORS configuration we control —
Google sends whatever Google sends.

**First run answered it, and the answer was not the obvious one.** The PUT was
blocked with `TypeError: Failed to fetch`, which reads like Google forbidding
browser uploads outright. It is not that. Probing `googleapis.com` directly:

```
OPTIONS /upload/drive/v3/files?uploadType=resumable
Origin: http://localhost:8788
Access-Control-Request-Method: PUT

200
access-control-allow-origin: http://localhost:8788
access-control-allow-methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT
vary: origin
```

CORS is supported, and PUT is allowed. The same request *without* an `Origin`
header returns **404** — note `vary: origin`. The Worker was opening the session
without one, so Google minted a session URI bound to no browser origin at all.
The Worker now forwards the page's origin on session creation, and runs the
browser's preflight itself beforehand so a failure produces headers rather than
`Failed to fetch`.

A second question comes free: **which OAuth scope is enough.** We want
`drive.file`, which limits this identity to files it created itself, so that a
folder shared more widely later still exposes nothing. It is not certain
`drive.file` permits creating a file inside a folder the app did not create, so
the spike tries it first, falls back to `drive` once, and reports which worked.

## What it cannot touch

`wrangler.spike.toml` binds **no D1, no R2 and no KV**. This Worker cannot read
or write any Steward data. That is what makes it safe for a diagnostic that
echoes Google's error bodies verbatim — and also why it must never be deployed.
It has no routes and `workers_dev = false`.

## Before you run it

Two things, both one-off.

**1. The key, into `.dev.vars`.**

```
node spike/load-key.mjs
```

It finds the key in `~/Downloads`, checks it really is a service-account key,
and writes it base64'd onto one line. If it lives somewhere else, name it:
`node spike/load-key.mjs <path>`.

Base64 rather than a raw paste because the JSON is multi-line and its private
key contains escaped newlines, which dotenv parsing mangles into a bad signature
that reads like an auth bug. The same one-line format works later for the real
Wrangler secret, so there is one thing to get right instead of two.

The script replaces any earlier line rather than stacking another one, and
refuses to write at all if `.dev.vars` is not in `.gitignore`. It prints the
account address and project id so you can check them, and never the key.

Delete the downloaded JSON afterwards.

**2. The folder shared with the service account**, as Editor —
`steward-uploads@steward-grants.iam.gserviceaccount.com`. The folder id is in
`wrangler.spike.toml`, and is not a secret.

## Run it

```
node spike/verify-signing.mjs
npm run spike
```

Then open `http://127.0.0.1:8788`.

Do not paste a `#` comment onto the end of an `npm run` line. zsh passes it
through as arguments and wrangler rejects the lot with `Unknown arguments`.

Open the page, pick any file, press the button. It uploads into the
`houstontexansfoundation` folder, and you can delete the file afterwards.

`verify-signing.mjs` checks the one part that can be checked offline: that the
JWT we hand Google is well formed and verifies against the key that signed it.
Worth running first, because Google answers a mangled key and a clock two
minutes fast with the same opaque `invalid_grant` and never says which.

## Reading the result

The page ends on one of four verdicts. They mean quite different things.

| Verdict | What it means | What happens next |
|---|---|---|
| **It works** | The browser uploaded direct, with no credentials of its own | Phase B starts. Note which scope it used. |
| **The browser refused to send it** | Something blocked the PUT. The **preflight** row says whether it was Google | Read the preflight row first. `allow-origin` empty means the session is not origin-bound; populated means look elsewhere. |
| **Google answered, and said no** | CORS is fine; Drive rejected the request | Much better problem. Send the status and body. |
| **Stopped before the real test** | Drive would not open a session at all | Credentials, folder sharing, or scope. The detail says which. |

Every run now also prints a **preflight** row: the exact `OPTIONS` the browser
is about to send, already sent from the Worker where the response is readable.
A browser tells you nothing when a preflight fails — `Failed to fetch` and an
opaque network row — so this is the difference between a diagnosis and a guess.

## What it deliberately does not do

It does not prove anything about `apply.houstontexansfoundation.org`, because
that hostname does not exist yet — it runs against `localhost`. That is strong
evidence Google permits browser-direct uploads at all, and the production origin
gets re-confirmed at deploy.

It is not a security review, it touches no database, and none of this code
survives into Phase B except the knowledge that the approach works.
