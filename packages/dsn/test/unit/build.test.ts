import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildDsn, type BuildDsnInput, type DsnRecipientReport } from '../../src/build.js';

const T0 = new Date('2026-09-25T16:00:00Z');
const HEADERS = Buffer.from('Subject: hi\r\nFrom: me@d3cloud.io\r\nTo: grey@greylist.test\r\n\r\n');

function baseRecipient(overrides: Partial<DsnRecipientReport> = {}): DsnRecipientReport {
  return {
    finalRecipient: 'grey@greylist.test',
    action: 'delayed',
    status: '4.3.0',
    remoteMta: 'mx.greylist.test',
    diagnosticCode: 'smtp; 451 4.3.0 greylisted',
    lastAttemptDate: T0,
    willRetryUntil: new Date(T0.getTime() + 5 * 24 * 3600_000),
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildDsnInput> = {}): BuildDsnInput {
  return {
    kind: 'delay',
    reportingMta: 'mx.d3cloud.io',
    arrivalDate: T0,
    originalEnvelopeId: 'env-123',
    originalMessageHeaders: HEADERS,
    recipients: [baseRecipient()],
    from: 'Mail Delivery System <mailer-daemon@d3cloud.io>',
    to: 'me@d3cloud.io',
    date: T0,
    messageId: 'dsn-1@d3cloud.io',
    ...overrides,
  };
}

/** Splits an RFC 5322 message into headers and a raw multipart body by the boundary it declares. */
function parse(buf: Buffer): { headers: string; boundary: string; parts: string[] } {
  const text = buf.toString('binary');
  expect(text).not.toMatch(/\r(?!\n)/); // no bare CR
  expect(text).not.toMatch(/(?<!\r)\n/); // no bare LF
  const [headerBlock, ...rest] = text.split('\r\n\r\n');
  const headers = headerBlock ?? '';
  const boundaryMatch = /boundary="([^"]+)"/.exec(headers);
  expect(boundaryMatch).not.toBeNull();
  const boundary = boundaryMatch?.[1] ?? '';
  const body = rest.join('\r\n\r\n');
  const parts = body.split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, ''));
  return { headers, boundary, parts };
}

describe('buildDsn', () => {
  it('produces a parseable multipart/report with a text, a delivery-status and an original part', () => {
    const buf = buildDsn(baseInput());
    const { headers, parts } = parse(buf);
    expect(headers).toContain('Content-Type: multipart/report; report-type=delivery-status;');
    expect(headers).toContain('MIME-Version: 1.0');
    expect(headers).toContain('Auto-Submitted: auto-replied');
    expect(headers).toMatch(/Message-ID: <dsn-1@d3cloud\.io>/);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('Content-Type: text/plain; charset=utf-8');
    expect(parts[1]).toContain('Content-Type: message/delivery-status');
    expect(parts[2]).toContain('Content-Type: text/rfc822-headers');
  });

  it('embeds the full original as message/rfc822 when told it is the whole message', () => {
    const buf = buildDsn(baseInput({ originalIsFullMessage: true }));
    const { parts } = parse(buf);
    expect(parts[2]).toContain('Content-Type: message/rfc822');
  });

  it('a delay report has Action: delayed, a 4.x.x Status and Will-Retry-Until', () => {
    const buf = buildDsn(baseInput({ kind: 'delay' }));
    const { parts } = parse(buf);
    const status = parts[1] ?? '';
    expect(status).toContain('Reporting-MTA: dns; mx.d3cloud.io');
    expect(status).toContain('Original-Envelope-Id: env-123');
    expect(status).toContain('Action: delayed');
    expect(status).toContain('Status: 4.3.0');
    expect(status).toContain('Will-Retry-Until:');
    expect(status).toContain('Final-Recipient: rfc822; grey@greylist.test');
    expect(status).toContain('Diagnostic-Code: smtp; 451 4.3.0 greylisted');
  });

  it('a failure report has Action: failed, a 5.x.x Status and no Will-Retry-Until', () => {
    const buf = buildDsn(baseInput({
      kind: 'failure',
      recipients: [{
        finalRecipient: 'grey@greylist.test',
        action: 'failed',
        status: '5.1.1',
        remoteMta: 'mx.greylist.test',
        diagnosticCode: 'smtp; 550 5.1.1 No such user',
        lastAttemptDate: T0,
      }],
    }));
    const { parts } = parse(buf);
    const status = parts[1] ?? '';
    expect(status).toContain('Action: failed');
    expect(status).toContain('Status: 5.1.1');
    expect(status).not.toContain('Will-Retry-Until');
    expect(status).toContain('Diagnostic-Code: smtp; 550 5.1.1 No such user');
    const text = parts[0] ?? '';
    expect(text).toMatch(/could not be delivered/);
  });

  it('folds the Reporting-MTA header line when it is longer than 78 columns', () => {
    const longMta = `mx-${'sub.'.repeat(30)}example.test`;
    const buf = buildDsn(baseInput({ reportingMta: longMta }));
    const { parts } = parse(buf);
    const status = parts[1] ?? '';
    const lines = status.split('\r\n');
    const startIdx = lines.findIndex((l) => l.startsWith('Reporting-MTA:'));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect((lines[startIdx] ?? '').length).toBeLessThanOrEqual(78);
    // A continuation line follows, indented with a single space (RFC 5322 folding).
    expect(lines[startIdx + 1]?.startsWith(' ')).toBe(true);
    let end = startIdx + 1;
    while ((lines[end + 1] ?? '').startsWith(' ')) end++;
    const unfolded = lines.slice(startIdx, end + 1).join('').replaceAll(' ', '');
    expect(unfolded).toBe(`Reporting-MTA:dns;${longMta}`);
  });

  it('sanitizes CR/LF out of every field so no value can inject a header or a part boundary', () => {
    const buf = buildDsn(baseInput({
      recipients: [baseRecipient({
        finalRecipient: 'evil@x.test\r\nBcc: everyone@x.test',
        diagnosticCode: 'smtp; 550 5.1.1 gone\r\n--forged-boundary\r\nContent-Type: text/html',
      })],
    }));
    const text = buf.toString('binary');
    // The forged text survives only as harmless content merged onto one line, never as a real
    // header (no CRLF precedes it) and never as a real boundary line (no CRLF-then-"--" precedes it).
    expect(text).not.toContain('\r\nBcc: everyone@x.test');
    expect(text).not.toContain('\r\n--forged-boundary');
    expect(text).toContain('evil@x.test Bcc: everyone@x.test');
  });

  it('property: arbitrary recipient and diagnostic strings never break CRLF structure', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 200 }),
        (finalRecipient, diagnosticCode) => {
          const buf = buildDsn(baseInput({
            recipients: [baseRecipient({ finalRecipient, diagnosticCode })],
          }));
          const text = buf.toString('binary');
          expect(text).not.toMatch(/\r(?!\n)/);
          expect(text).not.toMatch(/(?<!\r)\n/);
          const boundaryCount = (text.match(/^--postroom-dsn-/gm) ?? []).length;
          expect(boundaryCount).toBe(4); // 3 part markers + the closing marker
        },
      ),
      { numRuns: 200 },
    );
  });
});
