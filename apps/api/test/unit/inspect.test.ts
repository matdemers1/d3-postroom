// PST-T-6.1, PST-REQ-114: the Inspect drawer's pure readers — the Received clause parser (with TLS
// per hop), DMARC-stated alignment, Bayes tokens, score splitting and the MDN request.
import { describe, expect, it } from 'vitest';
import { alignmentFromReasons, bayesTokens, mdnSection, parseReceived, readTls, receivedPath, spamSection } from '../../src/mail/inspect.js';

const POSTFIX =
  'from mail-out.example.org (mail-out.example.org [192.0.2.10]) (using TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits)) by relay.example.net (Postfix) with ESMTPS id 4F1B2C3D for <me@d3cloud.io>; Thu, 24 Sep 2026 10:00:05 +0000';
const SENDMAIL = 'from origin.example.org ([198.51.100.7]) by mail-out.example.org (8.17/8.17) with ESMTP id abc123 (version=TLS1.2 cipher=ECDHE-RSA-AES256-GCM-SHA384 bits=256 verify=NO); Thu, 24 Sep 2026 10:00:00 +0000';
const OURS = 'from relay.example.net (relay.example.net [203.0.113.5]) by mx.d3cloud.io (Postroom) with ESMTPS id tx-1 for <me@d3cloud.io>; Thu, 24 Sep 2026 10:00:07 +0000';
const EXCHANGE = 'from AM0PR01MB1234.eurprd01.prod.outlook.com (2603:10a6:208:1::1) by AM0PR01MB5678.eurprd01.prod.outlook.com with Microsoft SMTP Server (version=TLS1_2, cipher=TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384) id 15.20.1; Thu, 24 Sep 2026 09:59:00 +0000';

describe('parseReceived (RFC 5321 §4.4)', () => {
  it('reads every clause, the client IP and rDNS, and Postfix TLS', () => {
    const hop = parseReceived(POSTFIX);
    expect(hop).toMatchObject({
      from: 'mail-out.example.org',
      fromRdns: 'mail-out.example.org',
      fromIp: '192.0.2.10',
      by: 'relay.example.net',
      with: 'ESMTPS',
      id: '4F1B2C3D',
      for: 'me@d3cloud.io',
      tls: { encrypted: true, version: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' },
      timestamp: '2026-09-24T10:00:05.000Z',
      ours: false,
    });
  });

  it('reads version=/cipher= comments, even on a plain ESMTP hop', () => {
    const hop = parseReceived(SENDMAIL);
    expect(hop.fromIp).toBe('198.51.100.7');
    expect(hop.fromRdns).toBeNull();
    expect(hop.tls).toEqual({ encrypted: true, version: 'TLS1.2', cipher: 'ECDHE-RSA-AES256-GCM-SHA384' });
  });

  it('keeps a multi-word protocol and Exchange TLS', () => {
    const hop = parseReceived(EXCHANGE);
    expect(hop.with).toBe('Microsoft SMTP Server');
    expect(hop.tls).toEqual({ encrypted: true, version: 'TLS1_2', cipher: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384' });
    expect(hop.id).toBe('15.20.1');
  });

  it('marks our own hop and an unencrypted hop', () => {
    expect(parseReceived(OURS).ours).toBe(true);
    const plain = parseReceived('from a.example (a.example [192.0.2.1]) by b.example with SMTP id x; Thu, 24 Sep 2026 10:00:00 +0000');
    expect(plain.tls).toEqual({ encrypted: false, version: null, cipher: null });
  });

  it('never throws on junk, and keeps the raw text', () => {
    for (const junk of ['', ';', '((((', 'from', 'by ) ; not a date', 'from x (unterminated']) {
      const hop = parseReceived(junk);
      expect(hop.raw).toBe(junk);
    }
    expect(parseReceived('by x; not a date').timestamp).toBeNull();
  });

  it('readTls knows Gmail\'s wording and RFC 3848 protocols', () => {
    expect(readTls('SMTP', ['Google Transport Security']).encrypted).toBe(true);
    expect(readTls('ESMTPSA', []).encrypted).toBe(true);
    expect(readTls('UTF8SMTPS', []).encrypted).toBe(true);
    expect(readTls('ESMTP', []).encrypted).toBe(false);
  });
});

describe('receivedPath', () => {
  it('orders oldest first and states the delay since the previous hop', () => {
    const path = receivedPath([OURS, POSTFIX, SENDMAIL]);
    expect(path.map((h) => h.by)).toEqual(['mail-out.example.org', 'relay.example.net', 'mx.d3cloud.io']);
    expect(path.map((h) => h.delaySeconds)).toEqual([null, 5, 2]);
  });
});

describe('alignmentFromReasons (DMARC\'s own words)', () => {
  const reasons = [
    'SPF pass for bounce.example.org, relaxedly aligned with example.org',
    'DKIM pass for d=example.org, relaxedly aligned with example.org',
    'DKIM pass for d=esp.example is not relaxedly aligned with example.org',
  ];
  it('reads aligned and unaligned identifiers', () => {
    expect(alignmentFromReasons(reasons, 'spf', 'bounce.example.org')).toEqual({ aligned: true, mode: 'relaxed' });
    expect(alignmentFromReasons(reasons, 'dkim', 'example.org')).toEqual({ aligned: true, mode: 'relaxed' });
    expect(alignmentFromReasons(reasons, 'dkim', 'esp.example')).toEqual({ aligned: false, mode: 'relaxed' });
  });
  it('is null when DMARC did not say', () => {
    expect(alignmentFromReasons(reasons, 'dkim', 'other.example')).toBeNull();
    expect(alignmentFromReasons(reasons, 'spf', null)).toBeNull();
  });
});

describe('spam breakdown', () => {
  it('splits signals, Bayes probabilities and top tokens; decision markers stay out', () => {
    const spam = spamSection({
      scores: { bulk: 1, human: 0, 'bayes:newsletters': 0.87, 'bayes:receipts': 0.1, 'bayes:trainingDocs': 42, 'bucket:newsletters': 1, newSender: 1 },
      reasons: ['bayes: newsletters 0.87 (tokens: h:list-unsubscribe, weekly, digest); then receipts 0.10'],
      attachments: [{ partId: '2', filename: 'a.zip', verdict: 'ok', kind: 'archive', reasons: ['no executables inside'] }],
    });
    expect(spam.signals).toEqual([
      { name: 'bulk', value: 1 },
      { name: 'human', value: 0 },
    ]);
    expect(spam.bayes).toEqual({
      probabilities: [
        { bucket: 'newsletters', probability: 0.87 },
        { bucket: 'receipts', probability: 0.1 },
      ],
      trainingDocs: 42,
      topTokens: ['h:list-unsubscribe', 'weekly', 'digest'],
      reason: 'bayes: newsletters 0.87 (tokens: h:list-unsubscribe, weekly, digest); then receipts 0.10',
    });
    expect(spam.attachments).toHaveLength(1);
  });
  it('has no Bayes part without a model', () => {
    expect(bayesTokens(['people: human sender']).reason).toBeNull();
    expect(spamSection(null)).toEqual({ signals: [], bayes: null, attachments: [] });
  });
});

describe('mdnSection (RFC 8098 §2.1)', () => {
  it('reports the request, its address and whether Return-Path matches — and never that one was sent', () => {
    const m = mdnSection([
      { name: 'Return-Path', value: '<alice@example.org>' },
      { name: 'Disposition-Notification-To', value: 'Alice <alice@example.org>' },
    ]);
    expect(m).toMatchObject({ requested: true, to: ['alice@example.org'], returnPathMatches: true, sent: false });
    expect(mdnSection([{ name: 'Disposition-Notification-To', value: 'x@evil.example' }, { name: 'Return-Path', value: '<a@example.org>' }]).returnPathMatches).toBe(false);
    expect(mdnSection([]).requested).toBe(false);
  });
});
