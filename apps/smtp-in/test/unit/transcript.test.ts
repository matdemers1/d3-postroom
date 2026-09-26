// PST-T-6.3, PST-REQ-117, PST-REQ-118: AUTH credentials are redacted before anything is buffered or
// published, DATA's body octets are never recorded, and a transcript round-trips byte for byte
// (minus the redactions) through gzip.
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import {
  attachTranscriptTap,
  decompressTranscript,
  parseTranscriptText,
  TranscriptRecorder,
} from '../../src/transcript.js';

// publishLive: false means the recorder never touches `db`, so a stub with no real methods is fine.
const fakeDb = {} as unknown as Db;

function recorder(): TranscriptRecorder {
  const r = new TranscriptRecorder({
    daemon: 'smtp-in',
    sessionId: 'sess-1',
    clientIp: '203.0.113.9',
    db: fakeDb,
    publishLive: false,
    now: () => new Date('2026-09-26T00:00:00.000Z'),
  });
  // Every real session starts with the greeting, which answers no client line.
  r.recordOutgoingRaw(Buffer.from('220 mx.d3cloud.io ESMTP Postroom\r\n'));
  return r;
}

function feed(r: TranscriptRecorder, dir: 'C' | 'S', line: string): void {
  const buf = Buffer.from(`${line}\r\n`, 'utf8');
  if (dir === 'C') r.recordIncomingRaw(buf);
  else r.recordOutgoingRaw(buf);
}

describe('TranscriptRecorder (PST-T-6.3)', () => {
  it('never stores or would publish the password, for AUTH PLAIN with an initial response', () => {
    const r = recorder();
    feed(r, 'C', 'EHLO client.example');
    feed(r, 'S', '250-mx.d3cloud.io greets client.example');
    feed(r, 'C', 'AUTH PLAIN AGFsaWNlAHN1cGVyc2VjcmV0');
    feed(r, 'S', '235 2.7.0 Authentication successful');
    const text = r.snapshotText();
    expect(text).not.toContain('AGFsaWNlAHN1cGVyc2VjcmV0');
    expect(text).toContain('AUTH PLAIN [redacted]');
  });

  it('never stores the password for AUTH PLAIN without an initial response', () => {
    const r = recorder();
    feed(r, 'C', 'AUTH PLAIN');
    feed(r, 'S', '334 ');
    feed(r, 'C', 'AGFsaWNlAHN1cGVyc2VjcmV0');
    feed(r, 'S', '235 2.7.0 Authentication successful');
    const text = r.snapshotText();
    expect(text).not.toContain('AGFsaWNlAHN1cGVyc2VjcmV0');
    expect(text).toContain('[redacted]');
  });

  it('never stores either line of AUTH LOGIN', () => {
    const r = recorder();
    feed(r, 'C', 'AUTH LOGIN');
    feed(r, 'S', '334 VXNlcm5hbWU6');
    feed(r, 'C', 'YWxpY2U=');
    feed(r, 'S', '334 UGFzc3dvcmQ6');
    feed(r, 'C', 'c3VwZXJzZWNyZXQ=');
    feed(r, 'S', '235 2.7.0 Authentication successful');
    const text = r.snapshotText();
    expect(text).not.toContain('YWxpY2U=');
    expect(text).not.toContain('c3VwZXJzZWNyZXQ=');
    expect((text.match(/\[redacted\]/g) ?? []).length).toBe(2);
  });

  it('never buffers or summarizes-into-content the DATA body, only its byte count', () => {
    const r = recorder();
    feed(r, 'C', 'MAIL FROM:<a@example.org>');
    feed(r, 'S', '250 2.1.0 OK');
    feed(r, 'C', 'DATA');
    feed(r, 'S', '354 Start mail input');
    r.beginBody();
    r.recordIncomingRaw(Buffer.from('Subject: secret plans\r\n\r\nthe body\r\n.\r\n', 'utf8'));
    r.endBody(1234);
    feed(r, 'S', '250 2.0.0 Accepted');
    const text = r.snapshotText();
    expect(text).not.toContain('secret plans');
    expect(text).not.toContain('the body');
    expect(text).toContain('[message body: 1234 bytes]');
    expect(text).toContain('DATA');
  });

  it('caps the buffer and marks truncation once the bound is exceeded', () => {
    const r = new TranscriptRecorder({ daemon: 'smtp-in', sessionId: 's', clientIp: '127.0.0.1', db: fakeDb, publishLive: false });
    const big = 'A'.repeat(4096);
    for (let i = 0; i < 200; i++) feed(r, 'C', big);
    expect(r.snapshotText()).toContain('[transcript truncated]');
  });

  it('splits lines correctly across chunk boundaries', () => {
    const r = recorder();
    r.recordIncomingRaw(Buffer.from('EHL'));
    r.recordIncomingRaw(Buffer.from('O client.example\r\n'));
    const [entry] = parseTranscriptText(r.snapshotText()).filter((e) => e.dir === 'C');
    expect(entry).toMatchObject({ dir: 'C', line: 'EHLO client.example' });
  });
});

describe('compression round trip (PST-REQ-118)', () => {
  it('decompresses back to exactly the original bytes', () => {
    const text = 'line one\nline two\nAUTH PLAIN [redacted]\n';
    const compressed = gzipSync(Buffer.from(text, 'utf8'));
    expect(decompressTranscript({ body: compressed, compression: 'gzip' })).toBe(text);
  });

  it('round-trips a recorder snapshot, minus the redactions', () => {
    const r = recorder();
    feed(r, 'C', 'EHLO client.example');
    feed(r, 'C', 'AUTH PLAIN AGFsaWNlAHN1cGVyc2VjcmV0');
    const snapshot = r.snapshotText();
    const compressed = gzipSync(Buffer.from(snapshot, 'utf8'));
    const roundTripped = decompressTranscript({ body: compressed, compression: 'gzip' });
    expect(roundTripped).toBe(snapshot);
    expect(roundTripped).not.toContain('AGFsaWNlAHN1cGVyc2VjcmV0');
  });
});

describe('attachTranscriptTap', () => {
  it('records reads and writes without changing what the caller sees', () => {
    const seen: { dir: string; line: string }[] = [];
    const stub = {
      buffered: [Buffer.from('EHLO client.example\r\n')],
      read(): Buffer | null {
        return this.buffered.shift() ?? null;
      },
      write(chunk: Buffer): boolean {
        seen.push({ dir: 'raw', line: chunk.toString('utf8') });
        return true;
      },
    };
    const r = recorder();
    attachTranscriptTap(stub, r);
    const read1 = stub.read();
    expect(read1?.toString('utf8')).toBe('EHLO client.example\r\n');
    stub.write(Buffer.from('220 mx.d3cloud.io ESMTP Postroom\r\n'));
    expect(seen).toHaveLength(1);
    const text = r.snapshotText();
    expect(text).toContain('C: EHLO client.example');
    expect(text).toContain('S: 220 mx.d3cloud.io ESMTP Postroom');
  });
});
