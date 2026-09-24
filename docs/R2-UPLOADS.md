# Letting users upload files to R2, from a Cloudflare Worker

Everything Steward does to accept a file from a browser and give it back later,
written so it can be lifted into another project. The data model here is
Steward's; the *pattern* is not, and the parts that are ours are marked.

Nothing in this document is theoretical. Every rule in it is either enforced by
code in this repository or was learned by something failing in a way that did
not reproduce from the command line.

---

## The shape

```
browser                    worker                     R2
   |                          |                        |
   |-- POST /uploads -------->|                        |
   |   {filename, type, size} |                        |
   |                          |-- validate, authorize  |
   |                          |-- INSERT attachment    |
   |                          |-- sign a PUT URL       |
   |<-- {id, uploadUrl, {} } -|                        |
   |                                                   |
   |-- PUT the bytes --------------------------------->|
   |   (no Content-Type header)                        |
   |<-------------------------------------------- 200 -|
   |                          |                        |
   |-- POST /submit --------->|                        |
   |   {..., attachmentId}    |-- claim the attachment |
```

**The file never touches the Worker.** That is not an optimisation, it is the
only design that works. Cloudflare's edge rejects a request body over 100 MB
(Free and Pro) *before your handler runs*, so a Worker that proxies uploads
fails on exactly the files people care about, and fails somewhere you cannot
catch it.

The Worker's job is to answer one question — *may this person put this file
here?* — and to hand back a credential scoped to one object and one operation.

---

## The four rules

These are in `CLAUDE.md` as "learned the hard way, do not deviate". Each one
produces a failure that looks like something else.

### 1. Direct PUT from the browser, always

See above. The Worker authorizes; it does not carry bytes.

### 2. `aws4fetch`, never the AWS SDK

The AWS SDK reaches for Node APIs that Workers do not have. `aws4fetch` is
about 4 KB and does exactly one thing: SigV4.

```
npm install aws4fetch
```

### 3. Do not sign `Content-Type`, and do not let the browser send it

**This is the one that costs a day.**

With `signQuery: true`, aws4fetch signs the URL and **only the host header**.
If the browser then sends `Content-Type`, that header is outside the signature
and R2 answers **403** — while the identical request made with `curl` succeeds,
because curl was never adding the header.

Both obvious ways of sending a file add it for you. `fetch(url, {body: file})`
sets `Content-Type` from the Blob's type, and so does `xhr.send(file)`. Neither
can be talked out of it by deleting the header afterwards.

What works is giving them a body whose type is the empty string:

```js
file.slice(0, file.size, '')
```

A typeless Blob produces no `Content-Type` at all. It is a *view* over the same
bytes, not a copy, so a 200 MB video is not duplicated in memory to satisfy a
header rule.

R2 records the correct content type regardless — it infers from the key and
from what you stored. You do not lose anything by not sending it.

### 4. PUT, not an HTML form POST

R2 presigned URLs support `PUT`. They do not support browser form `POST`
(the S3 POST-policy flow). If you find a tutorial using a `<form>` with hidden
policy fields, it is about S3, not R2.

---

## Setup, once per environment

### The bucket

Declare it as a binding in `wrangler.toml` and Wrangler creates it at deploy.
You do **not** need R2 scope on your token for this — which matters, because
`wrangler login` does not request R2 scope and `wrangler r2 bucket create`
therefore fails.

```toml
[[r2_buckets]]
binding = "FILES"
bucket_name = "yourproject-preview-files"
preview_bucket_name = "yourproject-preview-files"
```

The binding is enough for a Worker reading or writing objects directly. It is
**not** enough to presign, which is a separate credential — see next.

### An API token for signing

Presigning is SigV4 against R2's S3 endpoint. The Worker binding cannot do it;
it needs an access key pair.

Cloudflare dashboard -> R2 -> **API** -> *Manage API tokens* -> **Create API
token**.

| Setting | Value | Why |
|---|---|---|
| Name | `yourproject-preview-presign` | Names the environment, so production's is obviously different |
| Permission | **Object Read & Write** | Presigning needs both: users PUT, staff GET. *Admin* Read & Write would also let this key create and delete buckets, which nothing needs |
| Specify bucket | the uploads bucket **only** | Not "all buckets". If you also have a backups bucket, a presigning key that can read it turns one leaked URL into your whole dataset |
| TTL | Forever, or a date you will remember | A token that expires silently looks exactly like a broken upload |
| Client IP filtering | empty | Signing happens in a Worker; its egress IP is not stable |

### Secrets

Never in `wrangler.toml`, never in a committed `.env`. `wrangler secret put`
reads from your terminal and hands the value to Cloudflare directly.

```
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

`R2_ACCOUNT_ID` and `R2_BUCKET_NAME` are not secrets and can be plain vars.
The endpoint is built from them, so you never need the S3 endpoint URL
Cloudflare also shows you.

### CORS on the bucket

The browser is making a cross-origin PUT, so the bucket must allow it.

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://yourapp.example.com"],
        "methods": ["PUT"],
        "headers": []
      },
      "maxAgeSeconds": 3600
    }
  ]
}
```

```
npx wrangler r2 bucket cors set yourproject-preview-files --file=config/r2-cors.json
```

That command **works under a plain `wrangler login`**, even though bucket
*creation* does not. The scopes differ. We predicted it would fail and were
wrong, which is worth knowing before you go hunting for a token you do not
need.

Two things about this file:

- `"headers": []` is correct, not an omission. You are sending no custom
  headers — that is rule 3.
- **`GET` is deliberately absent.** A download is a top-level navigation to the
  signed URL, and navigations are not subject to CORS. Listing `GET` would
  widen the bucket for no behaviour at all.

### Content-Security-Policy — the silent killer

If your Worker serves a CSP (it should), `connect-src 'self'` **refuses every
presigned PUT before the browser makes it.** No network request. No R2 error.
No Worker log. One line in a console nobody is watching.

This shipped in Steward and uploads could not have worked for any user.
It was invisible to the test suite because the browser harness drove Vite's dev
server, which serves no CSP at all — the policy exists only on responses the
Worker writes.

The R2 origin must be named in `connect-src`:

```ts
const R2_ORIGIN = `https://${bucket}.${accountId}.r2.cloudflarestorage.com`;

// connect-src 'self' https://bucket.account.r2.cloudflarestorage.com
```

Define that origin in **one** place and have both the signer and the CSP read
it. Ours is `r2Origin()` in `src/lib/uploads.ts`, for exactly this reason: two
definitions is how they drift, and the drift is invisible.

---

## The Worker: authorize and sign

Portable core. Steward's version adds form-field lookup and tenant scoping;
strip those and this is the whole thing.

```ts
import { AwsClient } from 'aws4fetch';

const client = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
});

const origin = `https://${env.R2_BUCKET_NAME}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const key = `user/${userId}/${attachmentId}`;

const signed = await client.sign(
  new Request(`${origin}/${key}?X-Amz-Expires=${ttlSeconds}`, { method: 'PUT' }),
  { aws: { signQuery: true } },
);

return Response.json({
  attachmentId,
  uploadUrl: signed.url,
  headers: {},            // deliberately empty: see rule 3
  expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
});
```

Returning `headers: {}` explicitly rather than omitting it is a small thing
that pays for itself. A client author asking "what headers do I send?" gets an
answer instead of a guess.

### The object key

```ts
`user/${userId}/${attachmentId}`
```

Two properties worth copying:

- **Scoped by tenant**, so an accidental listing is at least bounded.
- **The id is random, never derived from the filename.** A user's filename can
  contain their own name, a customer's name, a case number. Object keys turn up
  in logs.

### Signature lifetime should scale with the file

A constant does not survive contact with real files. Ten minutes is ample for
an 8 MB PDF and hopeless for a 200 MB video: someone on a rural connection
uploads for twelve minutes and is refused at the very end, with nothing to show
and no way to tell why.

```ts
const MIN_TTL = 600;      // 10 minutes
const MAX_TTL = 1800;     // 30 minutes, hard cap

function presignTtlFor(sizeBytes: number): number {
  const needed = Math.ceil(sizeBytes / (250 * 1024));   // assume 250 KB/s
  return Math.min(MAX_TTL, Math.max(MIN_TTL, needed));
}
```

250 KB/s is a slow-but-real floor. Anything faster finishes early and the
signature expires unused. The cap exists because a presigned URL is a bearer
token and every extra minute is another minute it is live if it leaks.

### Record the row BEFORE the upload

Insert the attachment row when you sign, with a null parent:

```sql
INSERT INTO attachments
  (id, parent_type, parent_id, organization_id, r2_key, filename,
   mime_type, size_bytes, uploaded_by, uploaded_at)
VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
```

A file exists from the moment the PUT finishes, which is *before* there is a
form submission to attach it to. The tenant id is what makes it attributable in
the meantime, and what the submit path checks a claimed attachment against.

This also gives you removal for free. When a user removes a file before
submitting, you delete nothing — submit only claims what the answer still
references, so an abandoned upload is simply never claimed. No delete path, and
nothing to get wrong.

### Validate server-side, and know what that buys

Run the same validation on both sides — the client's copy is a courtesy that
fails fast with a clear message, the server's is the one that counts, because
**the presigned URL is a credential**.

Be honest about the limit:

- R2 does **no malware scanning**.
- A declared MIME type is a *claim by the uploader*, not a fact about the bytes.
- Type and size validation is storage hygiene and a good error message. It is
  not safety.

The real control is on the way out: never render an untrusted file inline.

### Empty `file.type` is normal, not an edge case

`file.type` is empty surprisingly often — a `.heic` straight off an iPhone, a
`.mov` from a camera, anything the OS has no mapping for. An empty string
matches no allow-list, so the upload gets refused with "must be an image file"
for a file that is exactly that.

Fill the blank from the extension:

```ts
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

function mimeForUpload(filename: string, declared: string): string {
  if (declared.trim() !== '') return declared;
  return EXTENSION_TYPES[filename.toLowerCase().split('.').pop() ?? ''] ?? '';
}
```

This weakens nothing. The type was already whatever the client said it was.

**Store the resolved type, not the declared one.** Otherwise `mime_type` is an
empty string on the row — technically satisfying a NOT NULL column and useless
to every reader of it afterwards.

### The `accept` attribute must list extensions too

Related, and it bit us on the same day. `accept="image/heic"` **greys out every
HEIC photo on the device** in Chrome on Windows and Android, because the
browser has no mapping from that type to an extension. No error. The file
simply cannot be chosen, and what the user concludes is that their photos are
not allowed.

List both:

```html
accept="image/heic,image/jpeg,video/mp4,video/quicktime,.heic,.jpg,.mp4,.mov"
```

Derive the extension half from the same map `mimeForUpload` reads, so the
picker and the rule cannot disagree.

---

## The browser: XHR and a typeless Blob

`fetch` still cannot report upload progress. Someone on a slow connection
deserves a bar rather than a frozen page, so this is XHR.

```ts
export function putToR2(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);

    // Whatever the server said to send, verbatim. It says to send nothing.
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    xhr.upload.onprogress = (e) =>
      onProgress(e.lengthComputable ? e.loaded / e.total : null);

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      reject(new Error(
        xhr.status === 403
          ? 'Refused by storage — almost always the Content-Type rule.'
          : 'The upload did not finish.',
      ));
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted.'));

    // THE TYPELESS VIEW. This is rule 3, and it is one line.
    xhr.send(file.slice(0, file.size, ''));
  });
}
```

Spreading `headers` rather than assuming empty means that if the signing rules
ever change, this is not the place that has to change with them.

### One UI detail that will cost you an afternoon

After an upload batch, **clear the input**:

```ts
if (inputRef.current) inputRef.current.value = '';
```

Without it, choosing the identical file again fires no `change` event at all —
so a user retrying after a failure, or re-adding a file they removed, gets
silence.

The same fact breaks tests: do **not** poll `input.files.length` to detect a
finished upload, because the component resets it by design. Assert on rendered
state instead — the row with a *Remove* control next to it.

---

## Getting the file back out

A download is a **signed GET**, short-lived, forced to save rather than render.

```ts
const query = new URLSearchParams({
  'X-Amz-Expires': '300',
  'response-content-disposition': contentDisposition(row.filename),
  'response-content-type': 'application/octet-stream',
});

const signed = await client.sign(
  new Request(`${origin}/${row.r2_key}?${query}`, { method: 'GET' }),
  { aws: { signQuery: true } },
);
```

**Five minutes, not an hour.** The window only has to cover the browser
*starting* the transfer; R2 checks expiry on arrival, so a download already in
flight is unaffected by the window closing. The cost of a longer window is
entirely one-sided — a URL pasted into a chat, a ticket, or a browser history
is a live handle on somebody's private documents for as long as it lasts.

**`response-content-type: application/octet-stream` overrides what R2 stored.**
The stored type is the uploader's claim. Serving everything as an opaque stream
means a mislabelled — or deliberately labelled — HTML or SVG document cannot be
talked into rendering in your users' browsers. This is the control that makes
"we do not scan for malware" survivable.

### `Content-Disposition` is attacker-controlled input

The filename came from the user. A filename containing a double quote closes
the quoted form early and everything after it becomes header syntax — a header
injection into a response served by *R2*, not by you.

```ts
export function contentDisposition(filename: string): string {
  const ascii =
    filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\;]/g, '_').trim() || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
```

Two filename forms, because one is not enough. The quoted ASCII form is what
every client understands; `filename*` carries the real name for clients
implementing RFC 5987 — which is how someone whose budget is called
`Presupuesto anual.pdf` gets that name back instead of `Presupuesto_anual.pdf`.

`encodeURIComponent` leaves `!'()*` alone and RFC 5987's attr-char excludes all
of them, so percent-encode those by hand rather than hoping no filename ever
contains an apostrophe. Plenty do.

### One signer, used by every caller

Steward has a staff download path and an applicant download path. They differ
in *who may ask* and in *what gets recorded*. They do **not** differ in how the
URL is built — that is one function, `signOneRead`, called by both.

The way a rule labelled "do not deviate" gets deviated from is a second signer
written six months later that omits one line of it.

### Authorize, record, THEN return the URL

D1 has no interactive transactions, so ordering is the guarantee: write the
audit row **before** handing back the URL. If the write fails, the caller gets
an error and no URL. There is no path on which a credential is issued without a
record that it was issued.

Stamp `download_url_first_issued_at` on the attachment the first time one is
requested. It is what a retention screen reads before anyone decides a
document can be destroyed — and note carefully what it means: **a URL was
issued**, not that bytes were fetched. Downloads go straight from browser to
R2 and your Worker never sees them. Word any UI accordingly; do not tell
somebody "you have a copy" when the system cannot know that.

---

## Failure guide

| Symptom | Cause |
|---|---|
| 403 from R2, but `curl` with the same URL works | The browser sent `Content-Type`. Rule 3 |
| PUT never appears in the network tab at all | CSP `connect-src` does not name the R2 origin |
| CORS error on the PUT | Bucket CORS missing, or origin not listed |
| Upload works locally, fails deployed | Dev server serves no CSP; the Worker does |
| 403 near the end of a large upload only | Signature expired mid-transfer. Scale the TTL |
| "must be an image file" for an obvious image | Empty `file.type`; needs the extension fallback |
| File greyed out in the picker, no error | `accept` lists MIME types with no extensions |
| Choosing the same file twice does nothing | Input not cleared after the batch |
| Worker 413 / request rejected before your code | You are proxying bytes. Rule 1 |

---

## What you must test in a real browser

None of the following is visible to a unit test, and each one shipped broken in
this project at some point:

1. The PUT is a **PUT** and carries **no** `content-type`. Intercept the
   request and assert on its shape.
2. The CSP on a **Worker-served** response admits the R2 origin. A dev server
   will not tell you.
3. The `accept` attribute contains the extensions, not only the types.
4. A finished upload is distinguishable from an in-flight one. Count rows that
   have a *Remove* control, not rows.

And what no test in your repository can tell you: **whether R2 accepts the
PUT.** That needs real credentials and a real bucket. Do it by hand once,
early, and read the object back:

```
npx wrangler r2 object get yourproject-preview-files/user/<id>/<attachment-id> --file=/tmp/check.pdf
file /tmp/check.pdf
```

Match the byte count against what you stored. Until you have done that, you
have a design, not a working upload path.

---

## Cost

R2 storage is $0.015 per GB-month and **egress is free**, which is the whole
reason to use it over S3 for user-facing files.

$5 a month is roughly 333 GB. At six 200 MB videos per submission that is
around 280 submissions — so if you accept video, cost arrives gradually and
only if nothing is ever deleted.

Decide the retention question before there is real data attached to it.
Deleting a user's only copy of something is not a decision to take quickly, and
"we never decided" is the same as "never delete".
