// PST-T-11.15: finding the report in a stored message — the machine-readable part and the returned
// original's Message-ID (message/rfc822 or text/rfc822-headers) — without a database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { extractReport } from '../../src/feedback/extract.js';

const fixtures = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'dsn', 'test', 'fixtures');
const blobsOf = (bytes: Buffer) => ({ get: () => Promise.resolve(Readable.from([bytes])) }) as never;
const read = (name: string) => extractReport(blobsOf(readFileSync(join(fixtures, name))), 'x');

describe('extractReport', () => {
  it('reads a DSN with the whole original returned', async () => {
    const r = await read('dsn-5.1.1-full.eml');
    expect(r).toMatchObject({ type: 'delivery-status', from: 'mailer-daemon@mx.example.net', originalMessageId: '6f1d2c3b-4a5e-4f60-9b7a-8c9d0e1f2a3b@d3cloud.io' });
    expect(r?.body?.toString()).toMatch(/^Reporting-MTA: dns; mx\.example\.net/);
  });

  it('reads a DSN with only the headers returned', async () => {
    const r = await read('dsn-5.2.2-headers-envid.eml');
    expect(r).toMatchObject({ type: 'delivery-status', from: 'postmaster@mail.example.com', originalMessageId: '0a1b2c3d-5e6f-4a70-8b91-a2b3c4d5e6f7@d3cloud.io' });
    expect(r?.body?.toString()).toMatch(/Original-Envelope-Id: pst\+2Denv\+2D0042/);
  });

  it('reads an ARF report', async () => {
    const r = await read('arf-abuse.eml');
    expect(r).toMatchObject({ type: 'feedback-report', from: 'abusedesk@example.com', originalMessageId: '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7@d3cloud.io' });
    expect(r?.body?.toString()).toMatch(/^Feedback-Type: abuse/);
  });

  it('is null for ordinary mail and for other report types', async () => {
    expect(await extractReport(blobsOf(Buffer.from('From: a@b.example\r\nSubject: hi\r\n\r\nhello\r\n')), 'x')).toBeNull();
    const dmarc = 'From: a@b.example\r\nContent-Type: multipart/report; report-type=disposition-notification; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nread\r\n--b--\r\n';
    expect(await extractReport(blobsOf(Buffer.from(dmarc)), 'x')).toBeNull();
  });
});
