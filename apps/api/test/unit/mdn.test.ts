// PST-T-9.2, PST-REQ-146: the RFC 8098 MDN builder, parsed back with @postroom/mime to prove the
// shape is what it claims — multipart/report; report-type=disposition-notification, a human part and
// a message/disposition-notification part carrying Reporting-UA, Final-Recipient, Original-Message-ID
// and Disposition.
import { parseContentType, parseMessage, type MimeEvent } from '@postroom/mime';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildMdn } from '../../src/compose/mdn.js';

async function parse(raw: Buffer): Promise<MimeEvent[]> {
  const events: MimeEvent[] = [];
  for await (const event of parseMessage(Readable.from([raw]))) events.push(event);
  return events;
}

describe('buildMdn (RFC 8098)', () => {
  const input = {
    from: { name: 'Ada', address: 'ada@example.com' },
    to: { name: '', address: 'sender@example.org' },
    subject: 'Hello there',
    originalMessageId: '<orig-123@example.org>',
    finalRecipient: 'ada@example.com',
    reportingUa: 'postroom.example; Postroom',
    date: new Date('2026-01-01T00:00:00Z'),
    messageId: '<mdn-1@example.com>',
  };

  it('is a well-formed multipart/report; report-type=disposition-notification', async () => {
    const raw = buildMdn(input);
    const events = await parse(raw);
    const top = events.find((e): e is Extract<MimeEvent, { type: 'headers' }> => e.type === 'headers' && e.part.depth === 0);
    if (top === undefined) throw new Error('no top-level headers event');
    const headers = top.headers;
    expect(headers.get('Message-ID')).toBe('<mdn-1@example.com>');
    expect(headers.get('From')).toContain('ada@example.com');
    expect(headers.get('To')).toContain('sender@example.org');
    const ct = parseContentType(headers.get('Content-Type') ?? '');
    expect(ct.mimeType).toBe('multipart/report');
    expect(ct.params['report-type']).toBe('disposition-notification');
  });

  it('carries a human part and a machine message/disposition-notification part with the right fields', async () => {
    const raw = buildMdn(input);
    const events = await parse(raw);
    const partTypes = events.filter((e): e is Extract<MimeEvent, { type: 'headers' }> => e.type === 'headers' && e.part.depth > 0).map((e) => e.part.contentType);
    expect(partTypes).toContain('text/plain');
    expect(partTypes).toContain('message/disposition-notification');

    const bodies: Record<string, string> = {};
    for (const e of events) {
      if (e.type === 'body') bodies[e.part.contentType] = (bodies[e.part.contentType] ?? '') + e.chunk.toString('utf8');
    }
    const machine = bodies['message/disposition-notification'] ?? '';
    expect(machine).toContain('Reporting-UA: postroom.example; Postroom');
    expect(machine).toContain('Final-Recipient: rfc822; ada@example.com');
    expect(machine).toContain('Original-Message-ID: <orig-123@example.org>');
    expect(machine).toContain('Disposition: manual-action/MDN-sent-manually; displayed');
    expect(bodies['text/plain'] ?? '').toContain('was displayed');
  });

  it('is strict CRLF throughout', () => {
    const raw = buildMdn(input);
    const text = raw.toString('utf8');
    // No bare LF or CR (every line break is CRLF).
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });
});
