// PST-T-7.1 / PST-REQ-122: the Google (.zip), Microsoft (.xml.gz) and Google TLS-RPT (.json.gz)
// fixtures parse to the rows the Deliverability screen charts.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ReportError, dmarcPassed, parseReportAttachment, parseTlsRpt, serializeTlsRpt, unwrapReport, type DmarcAggregateReport, type TlsRptReport } from '../../src/index.js';

const dir = join(import.meta.dirname, '..', 'fixtures');
const file = (suffix: string): { filename: string; bytes: Buffer } => {
  const name = readdirSync(dir).find((f) => f.endsWith(suffix));
  if (name === undefined) throw new Error(`no fixture ending ${suffix}`);
  return { filename: name, bytes: readFileSync(join(dir, name)) };
};

describe('Google aggregate report (.zip)', () => {
  const { filename, bytes } = file('.zip');
  const parsed = parseReportAttachment({ filename, contentType: 'application/zip', bytes });

  it('unwraps the single entry and reads the metadata', () => {
    expect(parsed?.kind).toBe('dmarc');
    expect(parsed?.container).toBe('zip');
    const r = parsed?.report as DmarcAggregateReport;
    expect(r.orgName).toBe('google.com');
    expect(r.email).toBe('noreply-dmarc-support@google.com');
    expect(r.reportId).toBe('4817259360124789153');
    expect(r.begin).toBe(1790208000);
    expect(r.end).toBe(1790294399);
    expect(r.policy).toEqual({ domain: 'd3cloud.io', adkim: 'r', aspf: 'r', p: 'quarantine', sp: 'quarantine', pct: 100, fo: null });
  });

  it('reads every record with its aligned results and auth results', () => {
    const r = parsed?.report as DmarcAggregateReport;
    expect(r.records.map((x) => [x.sourceIp, x.count, x.disposition, x.dkim, x.spf])).toEqual([
      ['203.0.113.25', 42, 'none', 'pass', 'pass'],
      ['198.51.100.77', 3, 'quarantine', 'fail', 'fail'],
      ['192.0.2.10', 5, 'none', 'pass', 'fail'],
    ]);
    expect(r.records.map(dmarcPassed)).toEqual([true, false, true]);
    expect(r.records[2]?.reasons).toEqual([{ type: 'forwarded', comment: 'looks forwarded' }]);
    expect(r.records[0]?.authDkim).toEqual([{ domain: 'd3cloud.io', selector: 'pr2026a', result: 'pass', humanResult: null }]);
    expect(r.records[1]?.authSpf).toEqual([{ domain: 'spoof.example', scope: null, result: 'softfail' }]);
  });
});

describe('Microsoft aggregate report (.xml.gz)', () => {
  const { filename, bytes } = file('.xml.gz');
  const parsed = parseReportAttachment({ filename, contentType: 'application/gzip', bytes });

  it('gunzips and reads the IPv6 row and envelope identifiers', () => {
    expect(parsed?.kind).toBe('dmarc');
    expect(parsed?.container).toBe('gzip');
    const r = parsed?.report as DmarcAggregateReport;
    expect(r.orgName).toBe('Enterprise Outlook');
    expect(r.version).toBe('1.0');
    expect(r.policy.fo).toBe('1');
    expect(r.records).toHaveLength(2);
    expect(r.records[1]).toMatchObject({ sourceIp: '2001:db8::25', count: 2, disposition: 'quarantine', envelopeFrom: 'bulk.example.net', envelopeTo: 'contoso.example' });
    expect(r.records[0]?.authSpf).toEqual([{ domain: 'd3cloud.io', scope: 'mfrom', result: 'pass' }]);
  });
});

describe('Google TLS-RPT report (.json.gz)', () => {
  const { filename, bytes } = file('.json.gz');
  const parsed = parseReportAttachment({ filename, contentType: 'application/tlsrpt+gzip', bytes });

  it('reads policies, summaries and failure details', () => {
    expect(parsed?.kind).toBe('tlsrpt');
    const r = parsed?.report as TlsRptReport;
    expect(r.organizationName).toBe('Google Inc.');
    expect(r.start).toBe('2026-09-24T00:00:00.000Z');
    expect(r.reportId).toBe('2026-09-24T00:00:00Z_d3cloud.io');
    expect(r.policies).toHaveLength(2);
    expect(r.policies[0]).toMatchObject({ policyType: 'sts', policyDomain: 'd3cloud.io', mxHost: ['mx.d3cloud.io'], totalSuccessful: 58, totalFailure: 2 });
    expect(r.policies[0]?.failures).toEqual([
      {
        resultType: 'certificate-expired',
        sendingMtaIp: '198.51.100.40',
        receivingMxHostname: 'mx.d3cloud.io',
        receivingMxHelo: null,
        receivingIp: '203.0.113.5',
        failedSessionCount: 2,
        additionalInformation: null,
        failureReasonCode: null,
      },
    ]);
    expect(r.policies[1]).toMatchObject({ policyType: 'no-policy-found', policyString: [], failures: [] });
  });
});

// Nightly fuzz run 37015732321 (GitHub issue #35, PST-T-002 / PST-REQ-088): a TLS-RPT report whose
// "total-failure-session-count" is the JSON number -0. count() let it through (-0 < 0 is false) and
// kept it as -0, which serializeTlsRpt writes as 0, so the fuzz target's round-trip check failed. A
// count of -0 is zero; it is read as 0.
describe('TLS-RPT count of -0 (fuzz crasher, issue #35)', () => {
  // The target's first byte picks the attachment guise; the report is the rest.
  const bytes = readFileSync(join(import.meta.dirname, '../../../../fuzz/dmarc-report/fixtures/tlsrpt-negative-zero-count.bin')).subarray(1);

  it('reads -0 as 0 and round-trips through the serializer', () => {
    const report = parseTlsRpt(bytes);
    const zero = report.policies.find((p) => p.policyType === 'no-policy-found');
    expect(Object.is(zero?.totalFailure, 0)).toBe(true);
    expect(parseTlsRpt(serializeTlsRpt(report))).toStrictEqual(report);
  });

  it('reads -0 as 0 in every count field', () => {
    const doc = {
      'organization-name': 'Example',
      'date-range': { 'start-datetime': '2026-09-24T00:00:00Z', 'end-datetime': '2026-09-24T23:59:59Z' },
      'contact-info': 'tls@example.com',
      'report-id': 'r1',
      policies: [
        {
          policy: { 'policy-type': 'sts', 'policy-domain': 'd3cloud.io' },
          summary: { 'total-successful-session-count': 1, 'total-failure-session-count': 1 },
          'failure-details': [{ 'result-type': 'certificate-expired', 'failed-session-count': 1 }],
        },
      ],
    };
    const text = JSON.stringify(doc).replace(/"(total-successful-session-count|total-failure-session-count|failed-session-count)":1/g, '"$1":-0');
    const p = parseTlsRpt(Buffer.from(text)).policies[0];
    expect([p?.totalSuccessful, p?.totalFailure, p?.failures[0]?.failedSessionCount].every((n) => Object.is(n, 0))).toBe(true);
  });
});

describe('what is not a report', () => {
  it('ignores a PDF or a text part', () => {
    expect(unwrapReport({ filename: 'invoice.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.7') })).toBeNull();
    expect(unwrapReport({ filename: null, contentType: 'text/plain', bytes: Buffer.from('hello') })).toBeNull();
  });
});

describe('decompression-bomb and container limits', () => {
  it('refuses a gzip that expands past the cap, without inflating it', () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const attempt = (): unknown => unwrapReport({ filename: 'r.xml.gz', contentType: 'application/gzip', bytes: bomb }, { maxOutput: 1024 * 1024 });
    expect(attempt).toThrow(ReportError);
    try {
      attempt();
    } catch (error) {
      expect((error as ReportError).code).toBe('too-large');
    }
  });

  it('refuses a ZIP whose CRC does not match', () => {
    const { bytes } = file('.zip');
    const broken = Buffer.from(bytes);
    // The CRC-32 in the central directory: find the CD signature and flip a CRC byte.
    const cd = broken.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    broken[cd + 16] = (broken[cd + 16] ?? 0) ^ 0xff;
    expect(() => unwrapReport({ filename: 'r.zip', contentType: 'application/zip', bytes: broken })).toThrow(/CRC/);
  });

  it('refuses a truncated gzip', () => {
    const { bytes } = file('.xml.gz');
    expect(() => unwrapReport({ filename: 'r.xml.gz', contentType: 'application/gzip', bytes: bytes.subarray(0, bytes.length - 12) })).toThrow(ReportError);
  });
});
