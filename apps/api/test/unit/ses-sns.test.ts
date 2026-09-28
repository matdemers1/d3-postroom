// PST-T-11.15: SNS message verification by hand — AWS's string to sign, the SNS-host allow-list for
// the certificate and SubscribeURL, SignatureVersion 1 and 2, the certificate cache, and forged
// signatures, wrong keys and foreign certificate hosts refused. No network: the certificate comes
// from an injected fetcher.
import { describe, expect, it } from 'vitest';
import { CertCache, SnsError, isSnsUrl, parseSnsMessage, stringToSign, verifySnsMessage } from '../../src/ses/sns.js';
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

describe('isSnsUrl', () => {
  it.each([
    ['https://sns.us-east-1.amazonaws.com/SimpleNotificationService-1.pem', true],
    ['https://sns.eu-west-2.amazonaws.com/x.pem', true],
    ['http://sns.us-east-1.amazonaws.com/x.pem', false],
    ['https://sns.us-east-1.amazonaws.com.evil.example/x.pem', false],
    ['https://evil.example/sns.us-east-1.amazonaws.com/x.pem', false],
    ['https://sns.us-east-1.amazonaws.com:8443/x.pem', false],
    ['https://user@sns.us-east-1.amazonaws.com/x.pem', false],
    ['https://s3.amazonaws.com/x.pem', false],
    ['https://sns.us-east-1.amazonaws.com/x.txt', false],
    ['not a url', false],
  ])('%s → %s (certificate)', (url, ok) => {
    expect(isSnsUrl(url, { pem: true })).toBe(ok);
  });

  it('pins the region when one is configured', () => {
    expect(isSnsUrl('https://sns.us-east-1.amazonaws.com/x.pem', { region: 'us-east-1', pem: true })).toBe(true);
    expect(isSnsUrl('https://sns.eu-west-1.amazonaws.com/x.pem', { region: 'us-east-1', pem: true })).toBe(false);
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

  it('never fetches a certificate from a host that is not SNS', async () => {
    const { fetch, urls } = s.fetcher();
    const m = s.sign({ ...notification('{}'), SigningCertURL: 'https://attacker.example/cert.pem' });
    await expect(verifySnsMessage(m, new CertCache(fetch))).rejects.toMatchObject({ status: 403, code: 'sns_cert_url_refused' });
    expect(urls).toEqual([]);
  });

  it('refuses when the certificate cannot be fetched or is not one', async () => {
    const m = s.sign(notification('{}'));
    await expect(verifySnsMessage(m, new CertCache(() => Promise.reject(new Error('offline'))))).rejects.toMatchObject({ code: 'sns_cert_unavailable' });
    await expect(verifySnsMessage(m, new CertCache(() => Promise.resolve(new Response('garbage'))))).rejects.toMatchObject({ code: 'sns_cert_invalid' });
  });

  it('refuses when the certificate is not valid at the given time', async () => {
    const m = s.sign(notification('{}'));
    await expect(verifySnsMessage(m, new CertCache(s.fetcher().fetch), new Date('2000-01-01T00:00:00Z'))).rejects.toMatchObject({ code: 'sns_cert_expired' });
  });
});
