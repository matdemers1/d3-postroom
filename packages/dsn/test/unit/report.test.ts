// PST-T-11.15: the DSN (RFC 3464) and ARF (RFC 5965) readers, against the hand-made fixtures, a
// round trip through our own buildDsn, and fast-check properties: total on any input, bounded, and
// every Status they return is a real x.y.z code.
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildDsn } from '../../src/build.js';
import {
  MAX_RECIPIENTS,
  MAX_VALUE_CHARS,
  decodeXtext,
  parseDeliveryStatus,
  parseFeedbackReport,
  smtpCodeOf,
  statusCode,
} from '../../src/report.js';

const fixture = (name: string): string => readFileSync(new URL(`../../../../fuzz/dsn-report/corpus/${name}`, import.meta.url), 'latin1');

/** The body of the part whose Content-Type line is `type` (the fixtures are simple enough to slice). */
function partBody(message: string, type: string): string {
  const start = message.indexOf(`Content-Type: ${type}`);
  if (start < 0) throw new Error(`no ${type} part`);
  const body = message.indexOf('\r\n\r\n', start) + 4;
  return message.slice(body, message.indexOf('\r\n--', body));
}

describe('parseDeliveryStatus (RFC 3464)', () => {
  it('reads a Postfix-style 5.1.1 failure', () => {
    const r = parseDeliveryStatus(partBody(fixture('dsn-5.1.1-full.eml'), 'message/delivery-status'));
    expect(r.reportingMta).toBe('mx.example.net');
    expect(r.originalEnvelopeId).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.recipients).toEqual([
      {
        finalRecipient: 'nobody@example.net',
        finalRecipientType: 'rfc822',
        originalRecipient: 'nobody@example.net',
        action: 'failed',
        status: '5.1.1',
        remoteMta: 'mailstore.example.net',
        diagnosticType: 'smtp',
        diagnostic: '550 5.1.1 <nobody@example.net>: Recipient address rejected: User unknown in local recipient table',
        smtpCode: 550,
        lastAttemptDate: null,
      },
    ]);
  });

  it('reads ENVID, a commented Status, a dashed reply code and a second, delayed recipient', () => {
    const r = parseDeliveryStatus(partBody(fixture('dsn-5.2.2-headers-envid.eml'), 'message/delivery-status'));
    expect(r.originalEnvelopeId).toBe('pst+2Denv+2D0042');
    expect(decodeXtext(r.originalEnvelopeId ?? '')).toBe('pst-env-0042');
    expect(r.recipients.map((x) => [x.finalRecipient, x.action, x.status, x.smtpCode])).toEqual([
      ['full@example.com', 'failed', '5.2.2', 552],
      ['later@example.com', 'delayed', '4.4.1', null],
    ]);
  });

  it('round-trips what our own buildDsn writes', () => {
    const dsn = buildDsn({
      kind: 'failure',
      reportingMta: 'mx.d3cloud.io',
      arrivalDate: new Date('2026-09-25T12:00:00Z'),
      originalEnvelopeId: 'env-7',
      originalMessageHeaders: Buffer.from('Message-ID: <x@d3cloud.io>\r\n\r\n'),
      recipients: [
        { finalRecipient: 'a@example.org', action: 'failed', status: '5.1.1', remoteMta: 'mx.example.org', diagnosticCode: 'smtp; 550 5.1.1 no such user', lastAttemptDate: new Date('2026-09-25T12:01:00Z') },
        { finalRecipient: 'b@example.org', action: 'failed', status: '5.7.1', diagnosticCode: 'smtp; 554 5.7.1 policy', lastAttemptDate: new Date('2026-09-25T12:01:00Z') },
      ],
      from: 'Mail Delivery System <mailer-daemon@d3cloud.io>',
      to: 'matt@d3cloud.io',
      date: new Date('2026-09-25T12:02:00Z'),
      messageId: 'dsn-1@d3cloud.io',
    }).toString('latin1');
    const r = parseDeliveryStatus(partBody(dsn, 'message/delivery-status'));
    expect(r.originalEnvelopeId).toBe('env-7');
    expect(r.reportingMta).toBe('mx.d3cloud.io');
    expect(r.recipients.map((x) => [x.finalRecipient, x.status, x.smtpCode, x.remoteMta])).toEqual([
      ['a@example.org', '5.1.1', 550, 'mx.example.org'],
      ['b@example.org', '5.7.1', 554, null],
    ]);
  });

  it('is null, not a guess, for a malformed Status, recipient or action', () => {
    const r = parseDeliveryStatus('Reporting-MTA: dns; x\n\nFinal-Recipient: rfc822; two words@example.org\nAction: f@iled\nStatus: 5.1\n');
    expect(r.recipients).toEqual([expect.objectContaining({ finalRecipient: null, action: null, status: null })]);
    expect(statusCode('5.01.001 extra')).toBe('5.1.1');
    expect(statusCode('3.1.1')).toBeNull();
    expect(statusCode('5.1.1.1')).toBeNull();
    expect(smtpCodeOf('550-5.1.1 x')).toBe(550);
    expect(smtpCodeOf('5505 x')).toBeNull();
  });

  it('reads LF-only and bare-CR text, and skips prose lines inside a block', () => {
    const r = parseDeliveryStatus('Reporting-MTA: dns; x\rjunk line\r\rFinal-Recipient: rfc822; <a@b.example>\rAction: FAILED\rStatus: 5.1.2\r');
    expect(r.reportingMta).toBe('x');
    expect(r.recipients[0]).toMatchObject({ finalRecipient: 'a@b.example', action: 'failed', status: '5.1.2' });
  });

  it(`reads at most ${String(MAX_RECIPIENTS)} recipients and says it stopped`, () => {
    const blocks = Array.from({ length: MAX_RECIPIENTS + 5 }, (_, i) => `Final-Recipient: rfc822; r${String(i)}@example.org\nAction: failed\nStatus: 5.1.1`);
    const r = parseDeliveryStatus(`Reporting-MTA: dns; x\n\n${blocks.join('\n\n')}\n`);
    expect(r.recipients).toHaveLength(MAX_RECIPIENTS);
    expect(r.truncated).toBe(true);
  });

  it('property: total and bounded on any input; every status it returns is a code', () => {
    const line = fc.oneof(
      fc.constantFrom('', ' ', '\t folded', 'Final-Recipient: rfc822; a@b.example', 'Action: failed', 'Status: 5.1.1', 'Status: 9.9.9', 'Diagnostic-Code: smtp; 550 x', 'Original-Envelope-Id: x+41', ':', 'Reporting-MTA: dns;'),
      fc.string({ maxLength: 40 }),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 80 }), fc.constantFrom('\r\n', '\n', '\r'), (lines, eol) => {
        const r = parseDeliveryStatus(lines.join(eol));
        expect(r.recipients.length).toBeLessThanOrEqual(MAX_RECIPIENTS);
        for (const x of r.recipients) {
          if (x.status !== null) expect(x.status).toMatch(/^[245]\.\d{1,3}\.\d{1,3}$/);
          if (x.smtpCode !== null) expect(x.smtpCode).toBeGreaterThanOrEqual(200);
          for (const v of [x.finalRecipient, x.diagnostic, x.remoteMta]) if (v !== null) expect(v.length).toBeLessThanOrEqual(MAX_VALUE_CHARS);
        }
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (bytes) => {
        parseDeliveryStatus(bytes);
        parseFeedbackReport(bytes);
      }),
      { numRuns: 300 },
    );
  });
});

describe('parseFeedbackReport (RFC 5965)', () => {
  it('reads the RFC 5965 §B.2-style abuse report', () => {
    const r = parseFeedbackReport(partBody(fixture('arf-abuse.eml'), 'message/feedback-report'));
    expect(r).toEqual({
      feedbackType: 'abuse',
      userAgent: 'SomeGenerator/1.0',
      version: '1',
      originalMailFrom: 'matt@d3cloud.io',
      originalRcptTo: ['user@example.com'],
      originalEnvelopeId: null,
      arrivalDate: 'Fri, 25 Sep 2026 13:50:00 +0000',
      reportingMta: 'mail.example.com',
      sourceIp: '192.0.2.1',
      incidents: null,
      reportedDomain: ['d3cloud.io'],
    });
  });

  it('refuses a Feedback-Type that is not a token, and a non-numeric Incidents', () => {
    const r = parseFeedbackReport('Feedback-Type: <script>\nIncidents: many\n');
    expect(r.feedbackType).toBeNull();
    expect(r.incidents).toBeNull();
    expect(parseFeedbackReport('Feedback-Type: Fraud\nIncidents: 3\n')).toMatchObject({ feedbackType: 'fraud', incidents: 3 });
  });
});
