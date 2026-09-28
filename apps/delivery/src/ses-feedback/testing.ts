// A throwaway SNS signing identity for the PST-T-11.15 and PST-T-11.17 tests (exported as
// @postroom/delivery/ses-feedback/testing so the api's and the worker's tests share it): an RSA key and a self-signed
// certificate made at runtime with the openssl CLI (as the other certificate tests do), messages
// signed per AWS's string-to-sign, and a fetcher that serves the certificate from the one allowed
// URL — so nothing touches the network. Undefined when openssl is unavailable.
import { createSign, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringToSign, type Fetcher, type SnsMessage } from './sns.js';

export const TOPIC = 'arn:aws:sns:us-east-1:123456789012:postroom-ses';
export const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem';
export const SUBSCRIBE_URL = 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:us-east-1:123456789012:postroom-ses&Token=abc';

export interface SnsSigner {
  readonly key: string;
  readonly cert: string;
  sign(m: Omit<SnsMessage, 'Signature' | 'SignatureVersion' | 'SigningCertURL'> & { SigningCertURL?: string }, version?: '1' | '2', key?: string): SnsMessage;
  /** A fetcher serving `cert` at CERT_URL and 200 at SUBSCRIBE_URL; records every URL it was asked for. */
  fetcher(): { fetch: Fetcher; urls: string[] };
}

export function makeKey(): { key: string; cert: string } | undefined {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'pst-t1115-sns-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=sns.amazonaws.com'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  } catch {
    return undefined;
  } finally {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
}

export function makeSnsSigner(): SnsSigner | undefined {
  const pair = makeKey();
  if (pair === undefined) return undefined;
  const { key, cert } = pair;
  return {
    key,
    cert,
    sign(m, version = '2', withKey = key) {
      const unsigned = { ...m, SignatureVersion: version, SigningCertURL: m.SigningCertURL ?? CERT_URL, Signature: '' } as SnsMessage;
      const signer = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
      signer.update(stringToSign(unsigned), 'utf8');
      return { ...unsigned, Signature: signer.sign(withKey, 'base64') };
    },
    fetcher() {
      const urls: string[] = [];
      const fetch: Fetcher = (url) => {
        urls.push(url);
        if (url === CERT_URL) return Promise.resolve(new Response(cert, { status: 200 }));
        if (url === SUBSCRIBE_URL) return Promise.resolve(new Response('<ConfirmSubscriptionResponse/>', { status: 200 }));
        return Promise.resolve(new Response('not found', { status: 404 }));
      };
      return { fetch, urls };
    },
  };
}

/** An SNS Notification envelope around `message` (the SES event JSON). */
export function notification(message: string, over: Partial<SnsMessage> = {}): Omit<SnsMessage, 'Signature' | 'SignatureVersion' | 'SigningCertURL'> {
  return {
    Type: 'Notification',
    MessageId: randomUUID(),
    TopicArn: TOPIC,
    Message: message,
    Timestamp: new Date().toISOString(),
    UnsubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=x',
    ...over,
  };
}
