// PST-T-11.15: SNS message verification by hand — AWS's string to sign, the region taken from the
// TopicArn and the exact sns.<region>.amazonaws.com host for the certificate and SubscribeURL (no
// S3 look-alikes), the Timestamp window, SignatureVersion 1 and 2, the certificate cache (negative
// cache, rate limit, pinning), and forged signatures, wrong keys and foreign hosts refused. No
// network: the certificate comes from an injected fetcher, the clock is injected.
import { describe, expect, it } from 'vitest';
import { CertCache, SnsError, checkTimestamp, isSnsUrl, parseSnsMessage, snsRegion, stringToSign, topicRegion, verifySnsMessage } from '../../src/ses/sns.js';
import { CERT_URL, TOPIC, makeKey, makeSnsSigner, notification } from '../sns-signer.js';

const signer = makeSnsSigner();

describe('stringToSign', () => {
  it('uses AWS order for a Notification, with Subject only when present', () => {
    const base = { ...notification('{"a":1}', { MessageId: 'm1', Timestamp: 't' }), SignatureVersion: '2' as const, Signature: '', SigningCertURL: CERT_URL };
    expect(stringToSign(base)).toBe(`Message\n{"a":1}\nMessageId\nm1\nTimestamp\nt\nTopicArn\n${TOPIC}\nType\nNotification\n`);
    expect(stringToSign({ ...base, Subject: 'S' })).toBe(`Message\n{"a":1}\nMessageId\nm1\nSubject\nS\nTimestamp\nt\nTopicArn\n${TOPIC}\nType\nNotification\n`);
  });

  it('uses AWS order for a SubscriptionConfirmation', () => {
    const m = { Type: 'SubscriptionConfirmation' as const, MessageId: 'm', TopicArn: 'arn', Message: 'x', Timestamp: 't', Token: 'tok', SubscribeURL: 'u', SignatureVersion: '1' as const, Signature: '', SigningCertURL: CERT_URL };
    expect(stringToSign(m)).toBe('Message\nx\nMessageId\nm\nSubscribeURL\nu\nTimestamp\nt\nToken\ntok\nTopicArn\narn\nType\nSubscriptionConfirmation\n');
  });
});

const PEM = 'SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem';

/** What `fn` throws, as { status, code }; null when it does not throw. */
function thrown(fn: () => unknown): { status: number; code: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof SnsError ? { status: e.status, code: e.code } : { status: 0, code: String(e) };
  }
}

describe('topicRegion / snsRegion', () => {
  it('takes the region from the TopicArn', () => {
    expect(topicRegion(TOPIC)).toBe('us-east-1');
    expect(topicRegion('arn:aws:sns:us-gov-west-1:123456789012:t')).toBe('us-gov-west-1');
    expect(topicRegion('arn:aws:sns:s3:123456789012:t')).toBeNull();
    expect(topicRegion('arn:aws:sqs:us-east-1:123456789012:t')).toBeNull();
    expect(topicRegion('arn:aws:sns:us-east-1:1234:t')).toBeNull();
  });

  it('refuses a topic outside SES_SNS_REGION, and a TopicArn that is not one', () => {
    expect(snsRegion({ TopicArn: TOPIC }, 'us-east-1')).toBe('us-east-1');
    expect(snsRegion({ TopicArn: TOPIC })).toBe('us-east-1');
    expect(thrown(() => snsRegion({ TopicArn: TOPIC }, 'eu-west-1'))).toEqual({ status: 403, code: 'sns_region_refused' });
    expect(thrown(() => snsRegion({ TopicArn: 'nope' }))).toEqual({ status: 403, code: 'sns_topic_refused' });
  });
});

describe('isSnsUrl', () => {
  it.each([
    [`https://sns.us-east-1.amazonaws.com/${PEM}`, true],
    [`https://SNS.us-east-1.amazonaws.com/${PEM}`, true],
    [`https://sns.eu-west-2.amazonaws.com/${PEM}`, false], // not the topic's region
    [`https://sns.s3.amazonaws.com/${PEM}`, false], // an S3 bucket's virtual host
    [`https://sns.s3-us-west-2.amazonaws.com/${PEM}`, false],
    [`http://sns.us-east-1.amazonaws.com/${PEM}`, false],
    [`https://sns.us-east-1.amazonaws.com.evil.example/${PEM}`, false],
    [`https://evil.example/sns.us-east-1.amazonaws.com/${PEM}`, false],
    [`https://sns.us-east-1.amazonaws.com:8443/${PEM}`, false],
    [`https://user@sns.us-east-1.amazonaws.com/${PEM}`, false],
    [`https://sns.us-east-1.amazonaws.com/${PEM}?x=1`, false],
    ['https://sns.us-east-1.amazonaws.com/x.pem', false], // not AWS's certificate path
    ['https://sns.us-east-1.amazonaws.com/SimpleNotificationService-zz.pem', false],
    ['not a url', false],
  ])('%s → %s (certificate, topic in us-east-1)', (url, ok) => {
    expect(isSnsUrl(url, { region: 'us-east-1', pem: true })).toBe(ok);
  });

  it('a SubscribeURL needs the exact regional host but any path', () => {
    expect(isSnsUrl('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=x', { region: 'us-east-1' })).toBe(true);
    expect(isSnsUrl('https://sns.s3.amazonaws.com/?Action=ConfirmSubscription', { region: 'us-east-1' })).toBe(false);
  });
});

describe('checkTimestamp', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  it('accepts the last 24 hours and up to 5 minutes ahead; refuses the rest with 400', () => {
    const at = (Timestamp: string): { status: number; code: string } | null => thrown(() => { checkTimestamp({ Timestamp }, now); });
    expect(at('2026-09-26T12:00:01.000Z')).toBeNull();
    expect(at('2026-09-27T12:04:59.000Z')).toBeNull();
    expect(at('2026-09-26T11:59:59.000Z')).toEqual({ status: 400, code: 'sns_message_stale' });
    expect(at('2026-09-27T12:05:01.000Z')).toEqual({ status: 400, code: 'sns_message_future' });
    expect(at('yesterday')).toEqual({ status: 400, code: 'invalid_sns_message' });
  });
});

describe('parseSnsMessage', () => {
  it('refuses what is not an SNS message', () => {
    expect(() => parseSnsMessage([])).toThrow(SnsError);
    expect(() => parseSnsMessage({ Type: 'Other' })).toThrow(/unknown Type/);
    expect(() => parseSnsMessage({ ...notification('x'), SignatureVersion: '3', Signature: 's', SigningCertURL: CERT_URL })).toThrow(/SignatureVersion/);
    expect(() => parseSnsMessage({ Type: 'SubscriptionConfirmation', MessageId: 'm', TopicArn: 'a', Message: 'x', Timestamp: 't', SignatureVersion: '1', Signature: 's', SigningCertURL: CERT_URL })).toThrow(/Token/);
    expect(() => parseSnsMessage({ ...notification('x'), MessageId: 5, SignatureVersion: '1', Signature: 's', SigningCertURL: CERT_URL })).toThrow(/MessageId/);
  });
});

describe.skipIf(signer === undefined)('verifySnsMessage', () => {
  const s = signer as NonNullable<typeof signer>;

  it('accepts SignatureVersion 1 and 2, fetching the certificate once', async () => {
    const { fetch, urls } = s.fetcher();
    const certs = new CertCache(fetch);
    await verifySnsMessage(s.sign(notification('{"eventType":"Bounce"}'), '1'), certs);
    await verifySnsMessage(s.sign(notification('{"eventType":"Bounce"}', { Subject: 'Amazon SES Email Event Notification' }), '2'), certs);
    expect(urls).toEqual([CERT_URL]);
  });

  it('refuses a message altered after signing', async () => {
    const m = s.sign(notification('{"eventType":"Bounce"}'));
    await expect(verifySnsMessage({ ...m, Message: '{"eventType":"Complaint"}' }, new CertCache(s.fetcher().fetch))).rejects.toMatchObject({ status: 403, code: 'sns_signature_invalid' });
    await expect(verifySnsMessage({ ...m, TopicArn: 'arn:aws:sns:us-east-1:999999999999:other' }, new CertCache(s.fetcher().fetch))).rejects.toMatchObject({ code: 'sns_signature_invalid' });
  });

  it('refuses a message signed with a different key (a forger with their own key)', async () => {
    const other = makeKey();
    if (other === undefined) return;
    const forged = s.sign(notification('{"eventType":"Bounce"}'), '2', other.key);
    await expect(verifySnsMessage(forged, new CertCache(s.fetcher().fetch))).rejects.toMatchObject({ code: 'sns_signature_invalid' });
  });

  it('never fetches a certificate from a host that is not the topic region\'s SNS', async () => {
    const { fetch, urls } = s.fetcher();
    for (const url of ['https://attacker.example/cert.pem', `https://sns.s3.amazonaws.com/${PEM}`, `https://sns.eu-west-1.amazonaws.com/${PEM}`]) {
      await expect(verifySnsMessage(s.sign({ ...notification('{}'), SigningCertURL: url }), new CertCache(fetch))).rejects.toMatchObject({ status: 403, code: 'sns_cert_url_refused' });
    }
    expect(urls).toEqual([]);
  });

  it('refuses a stale or future-dated message before fetching anything', async () => {
    const { fetch, urls } = s.fetcher();
    const now = new Date();
    const stale = s.sign(notification('{}', { Timestamp: new Date(now.getTime() - 25 * 3_600_000).toISOString() }));
    const future = s.sign(notification('{}', { Timestamp: new Date(now.getTime() + 10 * 60_000).toISOString() }));
    await expect(verifySnsMessage(stale, new CertCache(fetch), now)).rejects.toMatchObject({ status: 400, code: 'sns_message_stale' });
    await expect(verifySnsMessage(future, new CertCache(fetch), now)).rejects.toMatchObject({ status: 400, code: 'sns_message_future' });
    expect(urls).toEqual([]);
  });

  it('refuses when the certificate cannot be fetched or is not one', async () => {
    const m = s.sign(notification('{}'));
    await expect(verifySnsMessage(m, new CertCache(() => Promise.reject(new Error('offline'))))).rejects.toMatchObject({ code: 'sns_cert_unavailable' });
    await expect(verifySnsMessage(m, new CertCache(() => Promise.resolve(new Response('garbage'))))).rejects.toMatchObject({ code: 'sns_cert_invalid' });
  });

  it('refuses when the certificate is not valid at the given time', async () => {
    const at = new Date('2000-01-01T00:00:00Z');
    const m = s.sign(notification('{}', { Timestamp: at.toISOString() }));
    await expect(verifySnsMessage(m, new CertCache(s.fetcher().fetch), at)).rejects.toMatchObject({ code: 'sns_cert_expired' });
  });
});

describe.skipIf(signer === undefined)('CertCache: bounded fetching', () => {
  const s = signer as NonNullable<typeof signer>;
  const url = (n: number): string => `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${n.toString(16).padStart(32, '0')}.pem`;

  it('remembers a failed fetch for 10 minutes', async () => {
    let clock = 0;
    let calls = 0;
    const certs = new CertCache(() => {
      calls++;
      return Promise.resolve(new Response('nope', { status: 404 }));
    }, { now: () => clock });
    await expect(certs.get(url(1), 'us-east-1')).rejects.toMatchObject({ code: 'sns_cert_unavailable' });
    await expect(certs.get(url(1), 'us-east-1')).rejects.toMatchObject({ code: 'sns_cert_unavailable' });
    clock += 9 * 60_000;
    await expect(certs.get(url(1), 'us-east-1')).rejects.toMatchObject({ code: 'sns_cert_unavailable' });
    expect(calls).toBe(1);
    clock += 2 * 60_000;
    await expect(certs.get(url(1), 'us-east-1')).rejects.toMatchObject({ code: 'sns_cert_unavailable' });
    expect(calls).toBe(2);
  });

  it('sends at most 10 fetches a minute, however many URLs it is asked for', async () => {
    let clock = 0;
    let calls = 0;
    const certs = new CertCache(() => {
      calls++;
      return Promise.resolve(new Response('nope', { status: 404 }));
    }, { now: () => clock });
    for (let i = 0; i < 25; i++) await expect(certs.get(url(100 + i), 'us-east-1')).rejects.toBeInstanceOf(SnsError);
    expect(calls).toBe(10);
    await expect(certs.get(url(200), 'us-east-1')).rejects.toMatchObject({ code: 'sns_cert_rate_limited' });
    clock += 60_001;
    await expect(certs.get(url(201), 'us-east-1')).rejects.toMatchObject({ code: 'sns_cert_unavailable' });
    expect(calls).toBe(11);
  });

  it('keeps the certificate that verified a message pinned while other URLs churn the cache', async () => {
    let clock = 0;
    const certs = new CertCache((u) => Promise.resolve(new Response(u === CERT_URL || u.startsWith('https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0') ? s.cert : 'x')), { now: () => clock, fetchesPerMinute: 1000 });
    await verifySnsMessage(s.sign(notification('{}')), certs);
    for (let i = 0; i < 40; i++) {
      clock += 1;
      await certs.get(url(i), 'us-east-1');
    }
    expect(certs.isCached(CERT_URL)).toBe(true);
    expect(certs.isCached(url(0))).toBe(false);
  });
});
