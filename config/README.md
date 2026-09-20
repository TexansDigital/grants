# config/

Files handed to a Cloudflare CLI, kept in git so the settings they carry are
reviewable rather than living only in a dashboard.

## `r2-cors.json`

What the uploads bucket will accept from a browser.

    npx wrangler r2 bucket cors set steward-preview-files --file=config/r2-cors.json
    npx wrangler r2 bucket cors list steward-preview-files

**`methods` is `PUT` and nothing else, and `headers` is EMPTY.** Both are
deliberate and both follow the R2 rule in CLAUDE.md that was learned the hard
way: the browser PUTs to a presigned URL and sends no `Content-Type`, because
signing with `signQuery: true` signs only the host header and any extra header
the browser adds produces a 403 that does not reproduce in curl. R2 records the
correct content type from the presign regardless. Widening `headers` here would
not fix such a 403 — it would only hide which layer refused.

A `PUT` is not a CORS-safelisted method, so the browser always sends an
`OPTIONS` preflight first. That is what these rules answer.

**The localhost rule is for testing and should come out before the first real
cycle.** It is low risk rather than no risk: a presigned URL is a bearer token
for one object and one operation, so an attacker would already need the URL.
But nothing in production needs it.

**If wrangler rejects the shape**, the dashboard has the same settings under
R2 → the bucket → Settings → CORS Policy. Paste the same origins, method and
empty header list. Tell me if that happens and I will fix this file.
