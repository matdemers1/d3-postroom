// PST-T-15.11 (PST-REQ-195, PST-ADR-013): the composer's attachments — the upload state (queue,
// progress, done, failure, retry, remove), the limits refused before any request, the total line,
// what blocks Send, what a draft and a send carry, a saved draft's attachments coming back, and the
// XHR upload's request (raw body, headers, CSRF) and its answers. The browser flow — attach, save
// draft, reopen, send, the Sent copy's attachment — is e2e/tests/attachments.spec.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, CSRF_HEADER, type ComposeUpload } from '../../src/api';
import {
  admit,
  announceDone,
  announceFailed,
  announceStart,
  attachmentRefusalText,
  DEFAULT_LIMITS,
  dragHasFiles,
  failed,
  fromSaved,
  newKey,
  percent,
  progressed,
  removed,
  retrying,
  sendBlock,
  started,
  succeeded,
  totalBytes,
  totalLine,
  uploadErrorText,
  uploadIds,
  uploading,
  type AttachmentItem,
} from '../../src/mail/compose/attachments/state';
import { UploadAborted, uploadAttachment, uploadHeaders, type XhrLike } from '../../src/mail/compose/attachments/upload';

const MB = 1024 * 1024;
const LIMITS = { maxAttachmentBytes: 20 * MB, maxAttachments: 3 };
const file = (name: string, size: number, type = 'application/pdf') => ({ name, size, type });
const upload = (id: string, filename: string, size: number, contentType = 'application/pdf'): ComposeUpload => ({ id, filename, size, contentType });

describe('limits, refused before any upload', () => {
  it('admits what fits, in order', () => {
    const { admitted, refusal } = admit([], [file('a.pdf', 1 * MB), file('b.pdf', 2 * MB)], LIMITS);
    expect(admitted.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(refusal).toBeNull();
  });

  it('refuses a single file bigger than the whole limit, saying how big and what the limit is', () => {
    const { admitted, refusal } = admit([], [file('huge.mov', 25 * MB), file('ok.txt', 10)], LIMITS);
    expect(admitted.map((f) => f.name)).toEqual(['ok.txt']);
    expect(refusal).toBe('“huge.mov” is 25.0 MB, more than the 20.0 MB a message can carry, so it was not attached.');
  });

  it('refuses a file that would take the set past the total, counting chips already there (even failed ones)', () => {
    let items: AttachmentItem[] = started([], 'k1', file('a.pdf', 12 * MB));
    items = failed(items, 'k1', 'x');
    const { admitted, refusal } = admit(items, [file('b.pdf', 6 * MB), file('c.pdf', 3 * MB)], LIMITS);
    expect(admitted.map((f) => f.name)).toEqual(['b.pdf']);
    expect(refusal).toBe('“c.pdf” would take this message past its 20.0 MB limit, so it was not attached. Remove something to make room.');
  });

  it('refuses files past the count', () => {
    const { admitted, refusal } = admit([], [file('1', 1), file('2', 1), file('3', 1), file('4', 1), file('5', 1)], LIMITS);
    expect(admitted).toHaveLength(3);
    expect(refusal).toBe('A message can carry at most 3 files, so “4” and “5” were not attached.');
  });

  it('refuses the exact limit plus one byte, and admits the exact limit', () => {
    expect(admit([], [file('edge', 20 * MB)], LIMITS).refusal).toBeNull();
    expect(admit([], [file('edge', 20 * MB + 1)], LIMITS).admitted).toEqual([]);
  });

  it('names several too-big files in one sentence', () => {
    expect(admit([], [file('a', 30 * MB), file('b', 40 * MB)], LIMITS).refusal).toBe('“a” and “b” are each more than the 20.0 MB a message can carry, so they were not attached.');
  });

  it('defaults to the server’s defaults: 20 MiB, 20 files', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxAttachmentBytes: 20 * MB, maxAttachments: 20 });
  });
});

describe('the upload state', () => {
  it('goes uploading → progress → done, holding the server’s id, name and size', () => {
    let items = started([], 'k', file('report.pdf', 1000));
    expect(items[0]).toMatchObject({ kind: 'uploading', loaded: 0, contentType: 'application/pdf' });
    expect(uploading(items)).toBe(true);
    items = progressed(items, 'k', 420);
    expect(percent(items[0] as AttachmentItem)).toBe(42);
    // Never backwards, never past the size.
    expect(progressed(items, 'k', 100)).toBe(items);
    expect(progressed(items, 'k', 5000)[0]).toMatchObject({ loaded: 1000 });
    items = succeeded(items, 'k', upload('u1', 'report.pdf', 1000));
    expect(items[0]).toEqual({ key: 'k', kind: 'done', id: 'u1', name: 'report.pdf', size: 1000, contentType: 'application/pdf' });
    expect(uploading(items)).toBe(false);
    expect(percent(items[0] as AttachmentItem)).toBe(100);
  });

  it('an untyped file is application/octet-stream', () => {
    expect(started([], 'k', file('blob', 3, ''))[0]?.contentType).toBe('application/octet-stream');
  });

  it('fails with a reason, and Retry starts it again from 0', () => {
    let items = progressed(started([], 'k', file('a.pdf', 10)), 'k', 5);
    items = failed(items, 'k', 'Too large for this server.');
    expect(items[0]).toMatchObject({ kind: 'failed', reason: 'Too large for this server.' });
    items = retrying(items, 'k');
    expect(items[0]).toMatchObject({ kind: 'uploading', loaded: 0 });
    // Only a failed chip retries; only an uploading chip succeeds or fails.
    expect(retrying(items, 'k')).toBe(items);
    const done = succeeded(items, 'k', upload('u', 'a.pdf', 10));
    expect(failed(done, 'k', 'late')).toBe(done);
  });

  it('removes a chip in any state, leaving the others in order', () => {
    let items = started(started(started([], 'a', file('a', 1)), 'b', file('b', 1)), 'c', file('c', 1));
    items = succeeded(items, 'a', upload('ua', 'a', 1));
    items = removed(items, 'b');
    expect(items.map((a) => a.key)).toEqual(['a', 'c']);
    expect(removed(items, 'nope')).toEqual(items);
  });

  it('ignores progress and answers for a chip that is gone (removed while it uploaded)', () => {
    const items = started([], 'a', file('a', 10));
    expect(progressed(items, 'zz', 5)).toBe(items);
    expect(succeeded(items, 'zz', upload('u', 'z', 1))).toBe(items);
  });

  it('gives fresh keys', () => {
    expect(newKey()).not.toBe(newKey());
  });
});

describe('what a draft and a send carry', () => {
  it('only held uploads’ ids, in the order shown', () => {
    let items = started(started(started([], 'a', file('a', 1)), 'b', file('b', 1)), 'c', file('c', 1));
    items = succeeded(items, 'c', upload('uc', 'c', 1));
    items = succeeded(items, 'a', upload('ua', 'a', 1));
    expect(uploadIds(items)).toEqual(['ua', 'uc']);
  });

  it('a reopened draft’s attachments come back as held chips, with the same ids', () => {
    const items = fromSaved([upload('u1', 'plan.pdf', 2048), upload('u2', 'photo.jpg', 4096, 'image/jpeg')]);
    expect(items.map((a) => [a.kind, a.name, a.size])).toEqual([
      ['done', 'plan.pdf', 2048],
      ['done', 'photo.jpg', 4096],
    ]);
    expect(uploadIds(items)).toEqual(['u1', 'u2']);
    expect(new Set(items.map((a) => a.key)).size).toBe(2);
    expect(fromSaved(undefined)).toEqual([]);
  });
});

describe('Send waits for uploads', () => {
  it('is blocked while a file uploads, and while one has failed, with words for each', () => {
    expect(sendBlock([])).toBeNull();
    let items = started([], 'a', file('a.pdf', 1));
    expect(sendBlock(items)).toBe('Wait for “a.pdf” to finish uploading.');
    items = started(items, 'b', file('b.pdf', 1));
    expect(sendBlock(items)).toBe('Wait for 2 files to finish uploading.');
    items = failed(succeeded(items, 'a', upload('ua', 'a.pdf', 1)), 'b', 'x');
    expect(sendBlock(items)).toBe('“b.pdf” could not be uploaded. Retry it or remove it before sending.');
    expect(sendBlock(removed(items, 'b'))).toBeNull();
  });
});

describe('the total against the limit', () => {
  it('shows only once past 70% of the limit', () => {
    const limits = { maxAttachmentBytes: 20 * MB, maxAttachments: 20 };
    const under = succeeded(started([], 'a', file('a', 13 * MB)), 'a', upload('u', 'a', 13 * MB));
    expect(totalLine(under, limits)).toBeNull();
    const near = [...under, ...started([], 'b', file('b', 1.5 * MB))];
    expect(totalBytes(near)).toBe(14.5 * MB);
    expect(totalLine(near, limits)).toBe('14.5 MB of 20.0 MB');
    expect(totalLine([], limits)).toBeNull();
  });
});

describe('words', () => {
  it('says why an upload failed', () => {
    expect(uploadErrorText(new ApiError(413, 'attachment_too_large', null))).toBe('Too large for this server.');
    expect(uploadErrorText(new ApiError(400, 'invalid_filename', null))).toMatch(/file name/);
    expect(uploadErrorText(new ApiError(401, 'http_401', null))).toMatch(/signed out/);
    expect(uploadErrorText(new ApiError(500, 'http_500', null))).toBe('The upload failed (http_500).');
    expect(uploadErrorText(new Error('network'))).toMatch(/^Postroom didn’t answer\./);
  });

  it('turns a send’s attachment refusals into sentences, and leaves other refusals alone', () => {
    expect(attachmentRefusalText(new ApiError(413, 'attachments_too_large', null), LIMITS)).toMatch(/more than the 20\.0 MB/);
    expect(attachmentRefusalText(new ApiError(400, 'too_many_attachments', null), LIMITS)).toMatch(/at most 3 files/);
    expect(attachmentRefusalText(new ApiError(400, 'no_recipients', null), LIMITS)).toBeNull();
    expect(attachmentRefusalText(new Error('x'), LIMITS)).toBeNull();
  });

  it('announces a start and an end, not each percent', () => {
    expect(announceStart([file('a.pdf', 1)])).toBe('Uploading a.pdf.');
    expect(announceStart([file('a', 1), file('b', 1)])).toBe('Uploading 2 files.');
    expect(announceStart([])).toBe('');
    expect(announceDone('a.pdf')).toBe('a.pdf attached.');
    expect(announceFailed('a.pdf', 'Too large for this server.')).toBe('a.pdf could not be uploaded. Too large for this server.');
  });

  it('knows a drag of files from a drag of text', () => {
    expect(dragHasFiles(['Files'])).toBe(true);
    expect(dragHasFiles(['text/plain', 'text/html'])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});

/** A scripted XMLHttpRequest. */
class FakeXhr implements XhrLike {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: Blob | null = null;
  aborted = false;
  status = 0;
  responseText = '';
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload: XhrLike['upload'] = { onprogress: null };
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: Blob) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = body === null ? '' : JSON.stringify(body);
    this.onload?.();
  }
}

describe('the upload request (PST-ADR-013)', () => {
  const blob = () => new File(['hello attachment'], 'Q3 report (final).pdf', { type: 'application/pdf' });

  it('posts the raw bytes with the type, the URI-encoded name and the CSRF header call() sends', () => {
    const xhr = new FakeXhr();
    const f = blob();
    void uploadAttachment(f, () => undefined, () => xhr).done.catch(() => undefined);
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/compose/uploads');
    expect(xhr.body).toBe(f);
    expect(xhr.headers).toEqual({
      accept: 'application/json',
      'x-postroom-csrf': '1',
      'content-type': 'application/pdf',
      'x-postroom-filename': 'Q3%20report%20(final).pdf',
    });
    expect(xhr.headers[CSRF_HEADER.name]).toBe(CSRF_HEADER.value);
  });

  it('sends an untyped file as application/octet-stream, and encodes a non-ASCII name', () => {
    expect(uploadHeaders({ name: 'naïve résumé.docx', type: '' })).toMatchObject({
      'content-type': 'application/octet-stream',
      'x-postroom-filename': 'na%C3%AFve%20r%C3%A9sum%C3%A9.docx',
    });
  });

  it('reports progress and resolves with the 201 body', async () => {
    const xhr = new FakeXhr();
    const seen: number[] = [];
    const handle = uploadAttachment(blob(), (loaded) => seen.push(loaded), () => xhr);
    xhr.upload.onprogress?.({ loaded: 4, total: 16, lengthComputable: true });
    xhr.upload.onprogress?.({ loaded: 16, total: 16, lengthComputable: true });
    xhr.answer(201, { id: 'u1', filename: 'Q3 report (final).pdf', contentType: 'application/pdf', size: 16 });
    await expect(handle.done).resolves.toEqual({ id: 'u1', filename: 'Q3 report (final).pdf', contentType: 'application/pdf', size: 16 });
    expect(seen).toEqual([4, 16]);
  });

  it('rejects a refusal as the same ApiError call() throws', async () => {
    const xhr = new FakeXhr();
    const handle = uploadAttachment(blob(), () => undefined, () => xhr);
    xhr.answer(413, { error: 'attachment_too_large' });
    const e = await handle.done.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(413);
    expect((e as ApiError).code).toBe('attachment_too_large');
    expect(uploadErrorText(e)).toBe('Too large for this server.');
  });

  it('rejects a lost connection as a network error, and an abort as UploadAborted', async () => {
    const lost = new FakeXhr();
    const a = uploadAttachment(blob(), () => undefined, () => lost);
    lost.onerror?.();
    await expect(a.done).rejects.toThrow('network');
    const cut = new FakeXhr();
    const b = uploadAttachment(blob(), () => undefined, () => cut);
    b.abort();
    expect(cut.aborted).toBe(true);
    await expect(b.done).rejects.toBeInstanceOf(UploadAborted);
  });
});

describe('the composer wires it in', () => {
  const composer = readFileSync(join(import.meta.dirname, '../../src/mail/Composer.tsx'), 'utf8');

  it('has Attach files before Formatting, a multi-file picker, drop and paste', () => {
    const attach = composer.indexOf('label="Attach files"');
    expect(attach).toBeGreaterThan(0);
    expect(attach).toBeLessThan(composer.indexOf('variant="ghost" label="Formatting"'));
    expect(composer).toMatch(/type="file"\s+multiple/);
    expect(composer).toContain('onDrop={onDrop}');
    expect(composer).toContain('onPaste={onBodyPaste}');
    expect(composer).toContain('Drop to attach');
  });

  it('saves and sends the held ids, and Send waits for uploads', () => {
    expect(composer).toContain('attachments: uploadIds(attachmentsRef.current)');
    expect(composer.match(/disabled=\{loadingDraft \|\| busyUploading\}/g)).toHaveLength(2);
    expect(composer).toContain('sendBlock(attachmentsRef.current)');
  });
});
