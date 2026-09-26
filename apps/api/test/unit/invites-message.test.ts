// buildReplyMessage (PST-T-8.4, PST-REQ-134): a multipart/alternative message whose second part is
// text/calendar; method=REPLY; charset=UTF-8, CRLF throughout.
import { describe, expect, it } from 'vitest';
import { buildReplyMessage } from '../../src/invites/message.js';

describe('buildReplyMessage (PST-T-8.4)', () => {
  it('is multipart/alternative with a text/plain part and a text/calendar; method=REPLY part', () => {
    const bytes = buildReplyMessage(
      {
        from: { name: '', address: 'reader@d3cloud.io' },
        to: { name: 'Priya Patel', address: 'priya@example.com' },
        subject: 'Accepted: Quarterly Planning Sync',
        text: 'Accepted.',
        ics: 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR\r\n',
        messageId: '<abc@d3cloud.io>',
        date: new Date('2026-09-30T12:00:00Z'),
      },
      'BOUNDARY123',
    );
    const text = bytes.toString('utf8');
    expect(text).not.toContain('\r\n\r\n\r\n\r\n');
    expect(text.split(/\r\n|\n|\r/).every((line) => !line.includes('\n'))).toBe(true);
    expect(text).toContain('From: reader@d3cloud.io\r\n');
    expect(text).toContain('To: "Priya Patel" <priya@example.com>\r\n');
    expect(text).toContain('Content-Type: multipart/alternative;\r\n boundary="BOUNDARY123"');
    expect(text).toContain('--BOUNDARY123\r\nContent-Type: text/plain; charset=utf-8');
    expect(text).toContain('Content-Type: text/calendar; method=REPLY; charset=UTF-8');
    expect(text).toContain('BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR\r\n');
    expect(text.trimEnd().endsWith('--BOUNDARY123--')).toBe(true);
    // Every line break is CRLF (PST-REQ-049).
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });
});
