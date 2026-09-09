import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { putToR2, formatBytes, UploadError, asRefs } from '../web/src/uploadFile';

/**
 * A fake XMLHttpRequest, because the rule this module exists to obey is about
 * which HEADERS reach the wire, and no amount of asserting on our own code
 * proves that. This records what a real XHR would have sent.
 */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 200;
  aborted = false;
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  send(body: unknown) {
    this.body = body;
    // The browser sets Content-Type from the body's type, and this is the
    // whole point: a typeless body means no header.
    const type = (body as Blob | null)?.type;
    if (type) this.headers['content-type'] = type;
  }
  /** Completion is explicit, so a test can decide the status first. */
  finish(status = 200) {
    this.status = status;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    this.onload?.();
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

const g = globalThis as unknown as { XMLHttpRequest: unknown };
const original = g.XMLHttpRequest;
beforeEach(() => {
  FakeXhr.last = null;
  g.XMLHttpRequest = FakeXhr;
});
afterEach(() => {
  g.XMLHttpRequest = original;
});

/** A File standing in for an audited financial statement. */
const pdf = (name = 'audit-2025.pdf', bytes = 4096) =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

// ---------------------------------------------------------------------------
describe('the PUT, and the header rule it exists to obey', () => {
  it('sends NO content-type, even though the file has one', async () => {
    // CLAUDE.md, learned the hard way: signQuery signs only the host header, so
    // a Content-Type from the browser produces a 403 that does not reproduce in
    // curl. The file is application/pdf; the request must still carry nothing.
    const file = pdf();
    expect(file.type).toBe('application/pdf');

    const done = putToR2(
      'https://bucket.acct.r2.cloudflarestorage.com/org/o1/a1?X-Amz-Signature=x',
      {}, file, () => {},
    );
    FakeXhr.last!.finish();
    await done;

    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('PUT');
    expect(Object.keys(xhr.headers)).toEqual([]);
    expect(xhr.headers['content-type']).toBeUndefined();
    // A typeless view over the same bytes, not a copy of them.
    expect((xhr.body as Blob).type).toBe('');
    expect((xhr.body as Blob).size).toBe(4096);
  });

  it('sends exactly the headers the server asked for, and no others', async () => {
    // Empty today. Spread rather than assumed-empty, so that if the signing
    // rules change this is not the place that has to change with them.
    const done = putToR2('https://x/y', { 'x-amz-meta-note': 'from-server' }, pdf(), () => {});
    FakeXhr.last!.finish();
    await done;
    expect(FakeXhr.last!.headers).toEqual({ 'x-amz-meta-note': 'from-server' });
  });

  it('is a PUT, never a POST', async () => {
    // R2 presigned URLs do not support an HTML form POST.
    const done = putToR2('https://x/y', {}, pdf(), () => {});
    FakeXhr.last!.finish();
    await done;
    expect(FakeXhr.last!.method).toBe('PUT');
  });

  it('reports progress while the bytes go', async () => {
    const seen: (number | null)[] = [];
    const done = putToR2('https://x/y', {}, pdf(), (f) => seen.push(f));
    FakeXhr.last!.finish();
    await done;
    expect(seen).toEqual([0.5, 1]);
  });

  it('explains a 403 without blaming the applicant', async () => {
    const p = putToR2('https://x/y', {}, pdf(), () => {});
    FakeXhr.last!.finish(403);
    const err = await p.then(() => null, (e: UploadError) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err!.message).toMatch(/refused by storage/);
    expect(err!.message).not.toMatch(/403|Content-Type|signature/);
  });

  it('surfaces a network interruption as retryable', async () => {
    const p = putToR2('https://x/y', {}, pdf(), () => {});
    FakeXhr.last!.onerror!();
    const err = await p.then(() => null, (e: UploadError) => e);
    expect(err!.permanent).toBe(false);
    expect(err!.message).toMatch(/interrupted/);
  });

  it('can be cancelled', async () => {
    const ctl = new AbortController();
    const p = putToR2('https://x/y', {}, pdf(), () => {}, ctl.signal);
    ctl.abort();
    const err = await p.then(() => null, (e: UploadError) => e);
    expect(err!.permanent).toBe(true);
    expect(FakeXhr.last!.aborted).toBe(true);
  });

  it('does not start at all when already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const p = putToR2('https://x/y', {}, pdf(), () => {}, ctl.signal);
    await p.then(() => null, () => null);
    expect(FakeXhr.last!.body, 'nothing was sent').toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('reading a stored answer back', () => {
  it('keeps well-formed refs and drops everything else', () => {
    expect(
      asRefs([
        { attachment_id: 'a1', filename: 'budget.pdf' },
        { attachment_id: 'a2' },
        { filename: 'orphan.pdf' },
        null,
        'a3',
        42,
      ]),
    ).toEqual([{ attachment_id: 'a1', filename: 'budget.pdf' }]);
  });

  it('treats a non-array as no files', () => {
    for (const v of [null, undefined, 'a1', 42, { attachment_id: 'a1', filename: 'x' }]) {
      expect(asRefs(v), String(v)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
describe('file sizes a person reads', () => {
  it('does not make anybody parse bytes', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 1024 * 7.4)).toBe('7.4 MB');
    // Past ten, the decimal stops earning its place.
    expect(formatBytes(1024 * 1024 * 14.6)).toBe('15 MB');
  });
});
