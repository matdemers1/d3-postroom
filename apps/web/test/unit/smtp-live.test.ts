// PST-T-6.3, PST-REQ-117: parsing one SSE block from the live SMTP viewer. Plain .ts (no @d3cloud/ui)
// so it runs under apps/web's node-only unit tests.
import { describe, expect, it } from 'vitest';
import { parseSmtpLiveBlock } from '../../src/api';

describe('parseSmtpLiveBlock', () => {
  it('parses a line event', () => {
    const block = 'event: line\ndata: {"daemon":"smtp-in","sessionId":"s1","dir":"C","line":"EHLO client.example","at":"2026-09-26T00:00:00.000Z"}';
    expect(parseSmtpLiveBlock(block)).toEqual({
      daemon: 'smtp-in',
      sessionId: 's1',
      dir: 'C',
      line: 'EHLO client.example',
      at: '2026-09-26T00:00:00.000Z',
    });
  });

  it('ignores a heartbeat comment (no event/data lines)', () => {
    expect(parseSmtpLiveBlock(': ping')).toBeNull();
  });

  it('ignores an unrelated event name', () => {
    expect(parseSmtpLiveBlock('event: mailbox.changed\ndata: {}')).toBeNull();
  });

  it('never throws on malformed JSON or a missing field', () => {
    expect(parseSmtpLiveBlock('event: line\ndata: not json')).toBeNull();
    expect(parseSmtpLiveBlock('event: line\ndata: {"daemon":"smtp-in"}')).toBeNull();
    expect(parseSmtpLiveBlock('event: line\ndata: {"daemon":"smtp-in","sessionId":"s","dir":"X","line":"a","at":"a"}')).toBeNull();
  });
});
