// fast-check properties for @postroom/reports (PST-REQ-088): nothing throws anything but
// ReportError on arbitrary input, and the DMARC XML and TLS-RPT JSON serializers round-trip.
import { gzipSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ReportError,
  parseDmarcAggregate,
  parseReportAttachment,
  parseTlsRpt,
  parseXml,
  serializeDmarcAggregate,
  serializeTlsRpt,
  type DmarcAggregateReport,
  type TlsRptReport,
} from '../../src/index.js';

const onlyReportError = (fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
  }
};

// A trimmed, non-empty field value made of XML characters (markup and entity characters included).
const field = fc
  .string({ unit: fc.oneof(fc.constantFrom('<', '>', '&', '"', "'", ';', '\n', '\t', ' ', 'é', '中', '😀'), fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })), minLength: 1, maxLength: 40 })
  // eslint-disable-next-line no-control-regex -- strips the control characters XML cannot carry
  .map((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\r￾￿]/g, 'x').trim())
  .filter((s) => s !== '');
const opt = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | null> => fc.option(a, { nil: null });
const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const domain = fc.tuple(label, label).map(([a, b]) => `${a}.${b}`);
const tok = fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/);
const ip = fc.oneof(fc.ipV4(), fc.ipV6().map((s) => s.toLowerCase()));
const disposition = fc.constantFrom('none' as const, 'quarantine' as const, 'reject' as const);
const aligned = opt(fc.constantFrom('pass' as const, 'fail' as const));
const u32 = fc.integer({ min: 0, max: 2_147_483_647 });

const dmarcReport: fc.Arbitrary<DmarcAggregateReport> = fc
  .record({
    version: opt(field),
    orgName: field,
    email: opt(field),
    extraContactInfo: opt(field),
    reportId: field,
    begin: fc.integer({ min: 0, max: 4_000_000_000 }),
    span: fc.integer({ min: 0, max: 86_400 * 7 }),
    errors: fc.array(field, { maxLength: 2 }),
    policy: fc.record({
      domain,
      adkim: opt(fc.constantFrom('r' as const, 's' as const)),
      aspf: opt(fc.constantFrom('r' as const, 's' as const)),
      p: disposition,
      sp: opt(disposition),
      pct: opt(fc.integer({ min: 0, max: 100 })),
      fo: opt(field),
    }),
    records: fc.array(
      fc.record({
        sourceIp: ip,
        count: u32,
        disposition,
        dkim: aligned,
        spf: aligned,
        reasons: fc.array(fc.record({ type: tok, comment: opt(field) }), { maxLength: 2 }),
        headerFrom: domain,
        envelopeFrom: opt(domain),
        envelopeTo: opt(domain),
        authDkim: fc.array(fc.record({ domain, selector: opt(field), result: tok, humanResult: opt(field) }), { maxLength: 2 }),
        authSpf: fc.array(fc.record({ domain, scope: opt(tok), result: tok }), { maxLength: 2 }),
      }),
      { maxLength: 4 },
    ),
  })
  .map(({ span, ...r }) => ({ ...r, end: r.begin + span }));

const iso = fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true }).map((d) => d.toISOString());
const tlsReport: fc.Arbitrary<TlsRptReport> = fc
  .record({
    organizationName: field,
    a: iso,
    b: iso,
    contactInfo: opt(field),
    reportId: field,
    policies: fc.array(
      fc.record({
        policyType: fc.constantFrom('sts' as const, 'tlsa' as const, 'no-policy-found' as const),
        policyString: fc.array(field, { maxLength: 3 }),
        policyDomain: domain,
        mxHost: fc.array(domain, { maxLength: 2 }),
        totalSuccessful: u32,
        totalFailure: u32,
        failures: fc.array(
          fc.record({
            resultType: tok,
            sendingMtaIp: opt(fc.ipV4()),
            receivingMxHostname: opt(domain),
            receivingMxHelo: opt(field),
            receivingIp: opt(fc.ipV4()),
            failedSessionCount: u32,
            additionalInformation: opt(field),
            failureReasonCode: opt(field),
          }),
          { maxLength: 2 },
        ),
      }),
      { maxLength: 3 },
    ),
  })
  .map(({ a, b, ...r }) => ({ ...r, start: a < b ? a : b, end: a < b ? b : a }));

describe('round trips', () => {
  it('parseDmarcAggregate(serializeDmarcAggregate(r)) equals r', () => {
    fc.assert(
      fc.property(dmarcReport, (r) => {
        expect(parseDmarcAggregate(serializeDmarcAggregate(r))).toEqual(r);
      }),
      { numRuns: 300 },
    );
  });

  it('parseTlsRpt(serializeTlsRpt(r)) equals r', () => {
    fc.assert(
      fc.property(tlsReport, (r) => {
        expect(parseTlsRpt(serializeTlsRpt(r))).toEqual(r);
      }),
      { numRuns: 300 },
    );
  });

  it('a gzipped serialized report survives the attachment path', () => {
    fc.assert(
      fc.property(dmarcReport, (r) => {
        const parsed = parseReportAttachment({ filename: 'r.xml.gz', contentType: 'application/gzip', bytes: gzipSync(serializeDmarcAggregate(r)) });
        expect(parsed?.report).toEqual(r);
      }),
      { numRuns: 50 },
    );
  });
});

describe('never throws anything but ReportError', () => {
  const xmlish = fc
    .array(fc.oneof(fc.constantFrom('<', '>', '</', '/>', '<feedback>', '</feedback>', '<record>', '<row>', '&amp;', '&x;', '<!DOCTYPE', '<![CDATA[', ']]>', '<!--', '-->', '<?xml version="1.0"?>', '"', '='), fc.string({ maxLength: 6 })), { maxLength: 40 })
    .map((p) => p.join(''));

  it('parseXml and parseDmarcAggregate on XML-shaped strings and bytes', () => {
    fc.assert(
      fc.property(fc.oneof(xmlish, fc.string()), fc.uint8Array({ maxLength: 200 }), (s, b) => {
        onlyReportError(() => parseXml(s));
        onlyReportError(() => parseDmarcAggregate(s));
        onlyReportError(() => parseDmarcAggregate(b));
      }),
      { numRuns: 1000 },
    );
  });

  it('parseTlsRpt on arbitrary JSON values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        onlyReportError(() => parseTlsRpt(JSON.stringify(v)));
      }),
      { numRuns: 500 },
    );
  });

  it('parseReportAttachment on arbitrary bytes under every container guise', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), fc.constantFrom('r.zip', 'r.xml.gz', 'r.json.gz', 'r.xml', 'r.json', null), (b, name) => {
        const withMagic = [Buffer.from(b), Buffer.concat([Buffer.from([0x1f, 0x8b]), b]), Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), b])];
        for (const bytes of withMagic) onlyReportError(() => parseReportAttachment({ filename: name, contentType: 'application/octet-stream', bytes }));
      }),
      { numRuns: 500 },
    );
  });
});
