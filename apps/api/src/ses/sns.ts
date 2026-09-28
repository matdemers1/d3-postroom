// Amazon SNS message verification (PST-T-11.15), by hand with node:crypto, following AWS's
// "Verifying the signatures of Amazon SNS messages":
//
//   1. The message is one of Notification, SubscriptionConfirmation, UnsubscribeConfirmation, with
//      every field its type needs, as strings.
//   2. SigningCertURL is https, on a host matching sns.<region>.amazonaws.com (and, when the region
//      is configured, exactly that region), with a .pem path. Anything else is never fetched: the
//      URL is chosen by whoever sent the POST, and fetching an attacker's certificate would let them
//      sign their own messages. The PEM is cached by URL.
//   3. The string to sign is `Key\nValue\n` for each field in AWS's fixed order — Notification:
//      Message, MessageId, Subject (only when present), Timestamp, TopicArn, Type; the two
//      confirmations: Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type.
//   4. SignatureVersion 1 is SHA1withRSA, 2 is SHA256withRSA, over that string, with the
//      certificate's public key; Signature is base64.
//
// The certificate itself is not chain-validated: its authenticity comes from where it was fetched
// (TLS to an amazonaws.com host we allow-listed), which is AWS's own model.
import { X509Certificate, createVerify } from 'node:crypto';

export type SnsType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';

export interface SnsMessage {
  readonly Type: SnsType;
  readonly MessageId: string;
  readonly TopicArn: string;
  readonly Message: string;
  readonly Timestamp: string;
  readonly SignatureVersion: '1' | '2';
  readonly Signature: string;
  readonly SigningCertURL: string;
  readonly Subject?: string;
  readonly Token?: string;
  readonly SubscribeURL?: string;
  readonly UnsubscribeURL?: string;
}

export class SnsError extends Error {
  constructor(
    /** 400 for a malformed message, 403 for one that is not from our SNS topic. */
    readonly status: 400 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SnsError';
  }
}

const TYPES: readonly SnsType[] = ['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'];
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;
const MAX_FIELD = 262_144;

function str(o: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new SnsError(400, 'invalid_sns_message', `${key} is missing`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length > MAX_FIELD) throw new SnsError(400, 'invalid_sns_message', `${key} is not a string`);
  return v;
}

/** Shape-check a parsed SNS POST body. Throws SnsError(400) on anything that is not one. */
export function parseSnsMessage(body: unknown): SnsMessage {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SnsError(400, 'invalid_sns_message', 'body is not a JSON object');
  const o = body as Record<string, unknown>;
  const type = str(o, 'Type', true) as SnsType;
  if (!TYPES.includes(type)) throw new SnsError(400, 'invalid_sns_message', 'unknown Type');
  const version = str(o, 'SignatureVersion', true);
  if (version !== '1' && version !== '2') throw new SnsError(400, 'invalid_sns_message', 'unsupported SignatureVersion');
  const confirmation = type !== 'Notification';
  const subject = str(o, 'Subject', false);
  const token = str(o, 'Token', confirmation);
  const subscribeUrl = str(o, 'SubscribeURL', confirmation);
  const unsubscribeUrl = str(o, 'UnsubscribeURL', false);
  return {
    Type: type,
    MessageId: str(o, 'MessageId', true) ?? '',
    TopicArn: str(o, 'TopicArn', true) ?? '',
    Message: str(o, 'Message', true) ?? '',
    Timestamp: str(o, 'Timestamp', true) ?? '',
    SignatureVersion: version,
    Signature: str(o, 'Signature', true) ?? '',
    SigningCertURL: str(o, 'SigningCertURL', true) ?? '',
    ...(subject === undefined ? {} : { Subject: subject }),
    ...(token === undefined ? {} : { Token: token }),
    ...(subscribeUrl === undefined ? {} : { SubscribeURL: subscribeUrl }),
    ...(unsubscribeUrl === undefined ? {} : { UnsubscribeURL: unsubscribeUrl }),
  };
}

/** AWS's string to sign for `m` (step 3 above). */
export function stringToSign(m: SnsMessage): string {
  const keys: (keyof SnsMessage)[] =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(m.Subject === undefined ? [] : (['Subject'] as const)), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${m[k] ?? ''}\n`).join('');
}

/**
 * Whether `url` is somewhere Postroom may fetch from for SNS: https, default port, no credentials,
 * a host of the form sns.<region>.amazonaws.com — exactly `sns.<region>.amazonaws.com` when a region
 * is configured — and, for a signing certificate, a path ending in .pem.
 */
export function isSnsUrl(url: string, opts: { region?: string | undefined; pem?: boolean } = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
  const host = u.hostname.toLowerCase();
  if (!SNS_HOST.test(host)) return false;
  if (opts.region !== undefined && opts.region !== '' && host !== `sns.${opts.region}.amazonaws.com`) return false;
  if (opts.pem === true && !u.pathname.endsWith('.pem')) return false;
  return true;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const FETCH_TIMEOUT_MS = 5_000;
const MAX_CERT_BYTES = 16 * 1024;
const MAX_CACHED_CERTS = 16;

/** The system fetch with a timeout and no redirects (a redirect could leave the allow-listed host). */
export const timedFetch: Fetcher = (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/** Fetches signing certificates from allow-listed SNS URLs only, and keeps them by URL. */
export class CertCache {
  private readonly certs = new Map<string, X509Certificate>();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly region?: string,
  ) {}

  async get(url: string): Promise<X509Certificate> {
    if (!isSnsUrl(url, { region: this.region, pem: true })) throw new SnsError(403, 'sns_cert_url_refused', 'SigningCertURL is not an SNS certificate URL');
    const cached = this.certs.get(url);
    if (cached !== undefined) return cached;
    let res: Response;
    try {
      res = await this.fetcher(url, { redirect: 'error' });
    } catch {
      throw new SnsError(403, 'sns_cert_unavailable', 'the signing certificate could not be fetched');
    }
    if (!res.ok) throw new SnsError(403, 'sns_cert_unavailable', `the signing certificate fetch answered ${String(res.status)}`);
    const text = await res.text();
    if (text.length > MAX_CERT_BYTES) throw new SnsError(403, 'sns_cert_invalid', 'the signing certificate is too large');
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(text);
    } catch {
      throw new SnsError(403, 'sns_cert_invalid', 'the signing certificate is not a PEM certificate');
    }
    if (this.certs.size >= MAX_CACHED_CERTS) {
      const oldest = this.certs.keys().next().value;
      if (oldest !== undefined) this.certs.delete(oldest);
    }
    this.certs.set(url, cert);
    return cert;
  }
}

/** Throws SnsError(403) unless `m`'s signature verifies under the certificate its SigningCertURL names. */
export async function verifySnsMessage(m: SnsMessage, certs: CertCache, now: Date = new Date()): Promise<void> {
  const cert = await certs.get(m.SigningCertURL);
  if (new Date(cert.validTo).getTime() < now.getTime() || new Date(cert.validFrom).getTime() > now.getTime()) {
    throw new SnsError(403, 'sns_cert_expired', 'the signing certificate is not valid now');
  }
  const signature = Buffer.from(m.Signature, 'base64');
  if (signature.length === 0) throw new SnsError(403, 'sns_signature_invalid', 'the signature is empty');
  const verifier = createVerify(m.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
  verifier.update(stringToSign(m), 'utf8');
  let ok: boolean;
  try {
    ok = verifier.verify(cert.publicKey, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new SnsError(403, 'sns_signature_invalid', 'the SNS signature does not verify');
}
