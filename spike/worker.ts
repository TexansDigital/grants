/**
 * PHASE A SPIKE -- THROWAWAY CODE. Delete `spike/`, `wrangler.spike.toml` and
 * the `spike` script in package.json once this has answered its question.
 *
 * THE QUESTION, and it is the only one:
 *
 *   Can an applicant's BROWSER upload a file straight to Google Drive?
 *
 * It has to, because the file body cannot pass through the Worker. Cloudflare
 * rejects a large request body before our handler ever runs (CLAUDE.md, the R2
 * pattern, learned the hard way), so a design that proxies uploads fails on
 * exactly the files people care about -- a 40 MB audited financial statement.
 * Google's answer is a RESUMABLE SESSION: the Worker asks Drive for a session
 * URI using its service-account credentials, hands that URI to the browser, and
 * the browser PUTs the bytes to it with no credentials of its own.
 *
 * Whether a browser is ALLOWED to make that PUT cross-origin is the thing we
 * cannot look up and be sure of. Unlike R2, there is no CORS configuration we
 * control -- Google sends whatever Google sends. If the answer is no, the whole
 * Drive approach fails and no amount of later work rescues it. Hence a spike,
 * before the schema migration and before the upload path is rewritten.
 *
 * A SECOND QUESTION, answered for free: which OAuth scope is enough. We want
 * `drive.file`, which limits this identity to files it created itself, so that
 * a folder shared more widely later still exposes nothing. It is not certain
 * that `drive.file` permits creating a file inside a folder the app did not
 * create. So this tries `drive.file` first and falls back to `drive` once,
 * and REPORTS which one worked. One run, two findings.
 *
 * SAFETY. This Worker binds no D1, no R2 and no KV -- see wrangler.spike.toml.
 * It cannot read or write any Steward data. It echoes Google's error bodies
 * verbatim, which is the entire point of a diagnostic and also why it must
 * never be deployed anywhere.
 */

export interface SpikeEnv {
  /** The whole service-account JSON, base64 of the file, from .dev.vars. */
  GOOGLE_SERVICE_ACCOUNT_B64?: string;
  GOOGLE_DRIVE_FOLDER_ID?: string;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';

/**
 * Narrowest first. `drive.file` is what we want to ship: per-file access to
 * files this app created, and nothing else in the Drive.
 */
const NARROW_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BROAD_SCOPE = 'https://www.googleapis.com/auth/drive';

// ---------------------------------------------------------------------------
// base64 / base64url, by hand.
//
// Workers have atob/btoa but no Buffer, and the AWS-SDK lesson applies equally
// to google-auth-library: it wants Node APIs that are not here.
// ---------------------------------------------------------------------------

function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

/**
 * PEM (PKCS#8) to DER.
 *
 * JSON.parse has already turned the JSON file's `\n` escapes into real
 * newlines, so the only work is stripping the armour and all whitespace.
 */
function derFromPem(pem: string): Uint8Array {
  const body = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  return bytesFromB64(body);
}

export function readServiceAccount(env: SpikeEnv): ServiceAccount {
  const raw = (env.GOOGLE_SERVICE_ACCOUNT_B64 ?? '').trim();
  if (!raw) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_B64 is not set. Put it in .dev.vars at the repo ' +
        'root -- see spike/README.md.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytesFromB64(raw)));
  } catch {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_B64 did not decode to JSON. It should be the ' +
        'base64 of the whole downloaded key file, on one line.',
    );
  }
  const sa = parsed as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) {
    throw new Error('The decoded JSON has no client_email / private_key.');
  }
  return { client_email: sa.client_email, private_key: sa.private_key };
}

// ---------------------------------------------------------------------------
// Service-account sign-in: a self-signed JWT exchanged for an access token.
// ---------------------------------------------------------------------------

/**
 * Exported so spike/verify-signing.mjs can check it against a throwaway
 * keypair before you spend a round trip discovering that Google says
 * "invalid_grant" -- which it says for a mangled key and for a skewed clock
 * alike, and never tells you which.
 */
export async function signAssertion(sa: ServiceAccount, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlFromString(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: TOKEN_URL,
      iat: now,
      // Google caps the assertion lifetime at an hour. The token we get back
      // is separately an hour; Phase B caches it. Nothing is cached here.
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    derFromPem(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${b64urlFromBytes(signature)}`;
}

async function accessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await signAssertion(sa, scope),
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    // Verbatim. "invalid_grant" here almost always means the key is wrong or
    // the machine's clock is skewed, and paraphrasing hides which.
    throw new Error(`Google refused the sign-in (${res.status}): ${body}`);
  }
  const token = (JSON.parse(body) as { access_token?: string }).access_token;
  if (!token) throw new Error(`No access_token in the response: ${body}`);
  return token;
}

// ---------------------------------------------------------------------------
// Ask Drive to open a resumable session and hand back its URI.
// ---------------------------------------------------------------------------

interface SessionRequest {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * The browser origin that will do the PUT.
   *
   * THIS IS THE WHOLE BALLGAME. Google's upload endpoint varies its CORS
   * response on Origin -- literally `vary: origin` in the response headers --
   * and a session opened WITHOUT one is not bound to any browser origin, so
   * the eventual cross-origin PUT is refused before it leaves the machine.
   * The first run of this spike failed exactly that way: `TypeError: Failed to
   * fetch`, no response, which reads like Google forbidding browser uploads
   * outright and is not that at all.
   *
   * Probed directly against googleapis.com to confirm: an OPTIONS carrying
   * Origin comes back 200 with access-control-allow-origin echoing it and PUT
   * in the allowed methods; the identical OPTIONS without one comes back 404.
   */
  origin: string;
}

/** What Google says about cross-origin access to a session URI. */
interface CorsProbe {
  status: number;
  allowOrigin: string | null;
  allowMethods: string | null;
  allowHeaders: string | null;
  /** True when this URI would accept a PUT from the origin we asked about. */
  wouldAllowPut: boolean;
}

/**
 * Run, server side, the exact preflight the browser is about to run.
 *
 * A browser tells you nothing when a preflight fails -- `Failed to fetch` and
 * an opaque network row. Asking the same question from the Worker, where the
 * response is fully readable, turns that into the actual headers.
 */
async function probeCors(uploadUrl: string, origin: string): Promise<CorsProbe> {
  const res = await fetch(uploadUrl, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'PUT',
    },
  });
  const allowOrigin = res.headers.get('access-control-allow-origin');
  const allowMethods = res.headers.get('access-control-allow-methods');
  return {
    status: res.status,
    allowOrigin,
    allowMethods,
    allowHeaders: res.headers.get('access-control-allow-headers'),
    wouldAllowPut:
      res.ok &&
      (allowOrigin === '*' || allowOrigin === origin) &&
      (allowMethods ?? '').toUpperCase().includes('PUT'),
  };
}

async function openSession(
  sa: ServiceAccount,
  folderId: string,
  req: SessionRequest,
  scope: string,
): Promise<{ ok: true; uploadUrl: string } | { ok: false; status: number; detail: string }> {
  const token = await accessToken(sa, scope);
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      // The origin the browser will PUT from. Without it Google returns a
      // session URI that refuses cross-origin requests -- see SessionRequest.
      origin: req.origin,
      // Declared HERE, server side, so the browser never has to send a
      // Content-Type of its own. That matters: see the note in the harness.
      'x-upload-content-type': req.mimeType,
      'x-upload-content-length': String(req.sizeBytes),
    },
    body: JSON.stringify({ name: req.filename, parents: [folderId] }),
  });

  if (!res.ok) {
    return { ok: false, status: res.status, detail: await res.text() };
  }
  const location = res.headers.get('location');
  if (!location) {
    return {
      ok: false,
      status: res.status,
      detail: 'Drive accepted the request but sent no Location header.',
    };
  }
  return { ok: true, uploadUrl: location };
}

// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export default {
  async fetch(request: Request, env: SpikeEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(HARNESS, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/session' && request.method === 'POST') {
      try {
        const sa = readServiceAccount(env);
        const folderId = (env.GOOGLE_DRIVE_FOLDER_ID ?? '').trim();
        if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set.');

        const req = (await request.json()) as SessionRequest;

        // Narrow scope first. A failure here is itself a finding.
        const narrow = await openSession(sa, folderId, req, NARROW_SCOPE);
        if (narrow.ok) {
          return json({
            uploadUrl: narrow.uploadUrl,
            scopeUsed: 'drive.file',
            cors: await probeCors(narrow.uploadUrl, req.origin),
          });
        }

        const broad = await openSession(sa, folderId, req, BROAD_SCOPE);
        if (broad.ok) {
          return json({
            uploadUrl: broad.uploadUrl,
            scopeUsed: 'drive',
            cors: await probeCors(broad.uploadUrl, req.origin),
            narrowScopeFailed: { status: narrow.status, detail: narrow.detail },
          });
        }

        return json(
          {
            error: 'Drive refused to open a session under either scope.',
            driveFile: { status: narrow.status, detail: narrow.detail },
            drive: { status: broad.status, detail: broad.detail },
          },
          502,
        );
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// The harness. Inlined so the spike is one file with no asset binding and no
// build step -- it is not a design exercise, it is an instrument.
// ---------------------------------------------------------------------------

const HARNESS = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drive upload spike</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 2rem 1rem; background: #021018; color: #eef1f3;
    font: 16px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p.sub { color: #a9b4bd; margin: 0 0 2rem; }
  fieldset { border: 1px solid #1d2a33; border-radius: 8px; padding: 1.25rem; margin: 0 0 1.5rem; }
  legend { padding: 0 .5rem; color: #7b868f; font-size: .8125rem; text-transform: uppercase; letter-spacing: .08em; }
  input[type=file] { width: 100%; margin-bottom: 1rem; color: #a9b4bd; }
  button {
    font: inherit; font-weight: 600; background: #0080c6; color: #fff;
    border: 0; border-radius: 6px; padding: .6rem 1.1rem; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: default; }
  #log { margin: 0; padding: 0; list-style: none; display: grid; gap: .5rem; }
  #log li {
    display: grid; grid-template-columns: 5.5rem 1fr; gap: .75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem;
    align-items: start;
  }
  #log b { font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
  .step b { color: #7b868f; }
  .ok b { color: #3fbd85; }
  .bad b { color: #ff6b7f; }
  #log span { white-space: pre-wrap; word-break: break-word; color: #a9b4bd; }
  .ok span, .bad span { color: #eef1f3; }
  .verdict { margin-top: 1.5rem; padding: 1rem; border-radius: 8px; border: 1px solid #1d2a33; display: none; }
  .verdict.show { display: block; }
  .verdict.pass { border-color: #3fbd85; }
  .verdict.fail { border-color: #ed0028; }
  .verdict h2 { margin: 0 0 .5rem; font-size: 1rem; }
</style>
</head>
<body>
<main>
  <h1>Drive upload spike</h1>
  <p class="sub">
    Pick any file. Nothing here touches Steward &mdash; this Worker has no database
    and no bucket bound. The file goes into the Foundation&rsquo;s Drive folder and
    you can delete it afterwards.
  </p>

  <fieldset>
    <legend>Run it</legend>
    <input type="file" id="file">
    <button type="button" id="go">Upload to Drive</button>
  </fieldset>

  <fieldset>
    <legend>What happened</legend>
    <ul id="log"><li class="step"><b>waiting</b><span>Pick a file and press the button.</span></li></ul>
  </fieldset>

  <div class="verdict" id="verdict"><h2 id="vh"></h2><p id="vp" style="margin:0;color:#a9b4bd"></p></div>
</main>

<script>
(function () {
  var log = document.getElementById('log');
  var verdict = document.getElementById('verdict');
  var started = false;

  function say(kind, label, text) {
    if (!started) { log.innerHTML = ''; started = true; }
    var li = document.createElement('li');
    li.className = kind;
    var b = document.createElement('b'); b.textContent = label;
    var s = document.createElement('span'); s.textContent = text;
    li.appendChild(b); li.appendChild(s); log.appendChild(li);
  }

  function verdictIs(pass, head, body) {
    verdict.className = 'verdict show ' + (pass ? 'pass' : 'fail');
    document.getElementById('vh').textContent = head;
    document.getElementById('vp').textContent = body;
  }

  document.getElementById('go').addEventListener('click', async function () {
    var input = document.getElementById('file');
    var btn = this;
    var file = input.files && input.files[0];
    if (!file) { say('bad', 'no file', 'Pick one first.'); return; }

    btn.disabled = true;
    log.innerHTML = ''; started = true;
    verdict.className = 'verdict';

    say('step', 'file', file.name + '  ' + file.size + ' bytes  ' + (file.type || 'no type'));

    // ---- 1. the Worker opens a session -------------------------------
    var out;
    try {
      var r = await fetch('/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: 'spike-' + Date.now() + '-' + file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          // Google varies its CORS answer on Origin. A session opened without
          // one is not bound to this page and the PUT is refused before it
          // leaves the browser.
          origin: window.location.origin
        })
      });
      out = await r.json();
      if (!r.ok) {
        say('bad', 'session', JSON.stringify(out, null, 2));
        verdictIs(false, 'Stopped before the real test.',
          'Drive would not open a session, so the browser question was never asked. This is a credentials, folder-sharing or scope problem -- the detail above says which. Send it over.');
        btn.disabled = false; return;
      }
    } catch (e) {
      say('bad', 'session', String(e));
      verdictIs(false, 'The Worker itself failed.', 'Is npm run spike still running?');
      btn.disabled = false; return;
    }

    say('ok', 'session', 'opened, scope = ' + out.scopeUsed);
    if (out.narrowScopeFailed) {
      say('bad', 'scope', 'drive.file was refused (' + out.narrowScopeFailed.status + '). Falling back to drive.\\n' + out.narrowScopeFailed.detail);
    }

    // The same preflight the browser is about to run, already run from the
    // Worker where the response is readable. If the PUT below fails, this row
    // says whether Google refused it or something else did.
    var c = out.cors || {};
    say(c.wouldAllowPut ? 'ok' : 'bad', 'preflight',
      'OPTIONS -> ' + c.status +
      '\\nallow-origin:  ' + (c.allowOrigin || '(none)') +
      '\\nallow-methods: ' + (c.allowMethods || '(none)'));

    // ---- 2. THE ACTUAL QUESTION --------------------------------------
    // An ArrayBuffer, deliberately NOT the File. A File/Blob body makes fetch
    // set Content-Type from the blob, which is not a CORS-safelisted value and
    // so forces a preflight. This is the same trap as signing Content-Type on
    // an R2 presigned PUT: a 403 that never reproduces from the command line.
    var bytes = await file.arrayBuffer();
    say('step', 'browser', 'PUT ' + bytes.byteLength + ' bytes direct to Google, no auth header, no content-type');

    var put;
    try {
      put = await fetch(out.uploadUrl, { method: 'PUT', body: bytes });
    } catch (e) {
      say('bad', 'blocked', String(e));
      verdictIs(false, 'The browser refused to send it.',
        c.wouldAllowPut
          ? 'Google DID say this origin may PUT -- see the preflight row above -- so the block came from somewhere else. Open DevTools, Network tab, and send me the OPTIONS and PUT rows.'
          : 'No response came back, and the preflight row above shows why: Google did not grant this origin permission on the session URI. Send me both rows.');
      btn.disabled = false; return;
    }

    var text = await put.text();
    if (!put.ok) {
      say('bad', 'refused', put.status + '  ' + text);
      verdictIs(false, 'Google answered, and said no.',
        'The browser was allowed to make the request -- so CORS is fine -- but Drive rejected it. That is a much better problem to have. Send the status and body above.');
      btn.disabled = false; return;
    }

    var id = '';
    try { id = JSON.parse(text).id || ''; } catch (e) { /* not JSON, fine */ }
    say('ok', 'uploaded', id ? 'Drive file id ' + id : text.slice(0, 400));
    verdictIs(true, 'It works.',
      'The browser uploaded straight to Google Drive with no credentials of its own, using scope ' + out.scopeUsed + '. Check the folder -- the file should be there. The Drive approach is viable and Phase B can start.');
    btn.disabled = false;
  });
})();
</script>
</body>
</html>`;
