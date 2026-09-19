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
Google sends whatever Google sends. If the answer is no, the Drive approach
fails and no later work rescues it.

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

**1. The key, base64'd into `.dev.vars`.** Not pasted raw: the JSON is multi-line
and its private key contains escaped newlines, which dotenv parsing mangles into
a bad signature that looks like an auth bug. One line, no escaping, and the same
format works later for the real Wrangler secret.

```
printf 'GOOGLE_SERVICE_ACCOUNT_B64=%s\n' \
  "$(base64 < ~/Downloads/steward-grants-XXXXXX.json | tr -d '\n')" >> .dev.vars
```

`.dev.vars` is gitignored. Delete the JSON from Downloads afterwards.

**2. The folder shared with the service account**, as Editor —
`steward-uploads@steward-grants.iam.gserviceaccount.com`. The folder id is in
`wrangler.spike.toml`, and is not a secret.

## Run it

```
npm run spike            # http://127.0.0.1:8788
node spike/verify-signing.mjs   # optional, needs no credentials
```

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
| **The browser refused to send it** | CORS. Google would not permit a cross-origin PUT | The approach fails. Send me the DevTools console message. |
| **Google answered, and said no** | CORS is fine; Drive rejected the request | Much better problem. Send the status and body. |
| **Stopped before the real test** | Drive would not open a session at all | Credentials, folder sharing, or scope. The detail says which. |

The second row is the one that kills the design, which is why this ran before
the schema migration and before the upload path was rewritten.

## What it deliberately does not do

It does not prove anything about `apply.houstontexansfoundation.org`, because
that hostname does not exist yet — it runs against `localhost`. That is strong
evidence Google permits browser-direct uploads at all, and the production origin
gets re-confirmed at deploy.

It is not a security review, it touches no database, and none of this code
survives into Phase B except the knowledge that the approach works.
