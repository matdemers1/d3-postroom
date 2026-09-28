// Amazon SNS message verification (PST-T-11.15), by hand with node:crypto, following AWS's
// "Verifying the signatures of Amazon SNS messages". Shared since PST-T-11.17 by both ways an SNS
// message reaches Postroom — POST /api/ses/sns (apps/api) and the SQS queue the worker long-polls
// (apps/worker/src/ses-feedback) — so a message is trusted by exactly the same rules either way:
//
//   1. The message is one of Notification, SubscriptionConfirmation, UnsubscribeConfirmation, with
//      every field its type needs, as strings.
//   2. The region is the TopicArn's (arn:aws:sns:<region>:<account>:<name>), and must equal
//      SES_SNS_REGION when that is set. The Timestamp must be within the last 24 hours and no more
//      than 5 minutes ahead — checked before anything is fetched, so an old signed message cannot
//      be replayed to make Postroom fetch again.
//   3. SigningCertURL is https on exactly sns.<that region>.amazonaws.com, with AWS's path
//      /SimpleNotificationService-<hex>.pem. Anything else is never fetched: the URL is chosen by
//      whoever sent the POST, and fetching an attacker's certificate would let them sign their own
//      messages. An exact host (not a pattern) also shuts out look-alikes such as
//      sns.s3.amazonaws.com, an S3 bucket's virtual host anyone can create.
//   4. The string to sign is `Key\nValue\n` for each field in AWS's fixed order — Notification:
//      Message, MessageId, Subject (only when present), Timestamp, TopicArn, Type; the two
//      confirmations: Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type.
//   5. SignatureVersion 1 is SHA1withRSA, 2 is SHA256withRSA, over that string, with the
//      certificate's public key; Signature is base64.
//
// Certificate fetches are bounded (CertCache): good certificates are cached by URL and the one that
// last verified a message is pinned, so other URLs cannot evict it; a failed fetch is remembered
// for 10 minutes; and at most 10 fetches go out per minute, however many POSTs arrive.
//
// The certificate itself is not chain-validated: its authenticity comes from where it was fetched
// (TLS to the one amazonaws.com host the topic's region names), which is AWS's own model.
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

/** An SNS topic ARN's region, or null when `arn` is not one. */
export function topicRegion(arn: string): string | null {
  const m = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d{1,2}):\d{12}:[A-Za-z0-9_-]{1,256}$/.exec(arn);
  return m?.[1] ?? null;
}

/** The region `m`'s certificate and SubscribeURL must come from. Throws SnsError(403) otherwise. */
export function snsRegion(m: Pick<SnsMessage, 'TopicArn'>, configured?: string): string {
  const region = topicRegion(m.TopicArn);
  if (region === null) throw new SnsError(403, 'sns_topic_refused', 'TopicArn is not an SNS topic ARN');
  if (configured !== undefined && configured !== '' && configured !== region) throw new SnsError(403, 'sns_region_refused', 'the topic is not in SES_SNS_REGION');
  return region;
}

/** How old a message may be, and how far ahead of our clock. */
export const MAX_MESSAGE_AGE_MS = 24 * 3_600_000;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Throws SnsError(400) unless `m`'s Timestamp is a time within the accepted window around `now`. */
export function checkTimestamp(m: Pick<SnsMessage, 'Timestamp'>, now: Date): void {
  const t = Date.parse(m.Timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(m.Timestamp) || Number.isNaN(t)) throw new SnsError(400, 'invalid_sns_message', 'Timestamp is not an ISO 8601 time');
  if (now.getTime() - t > MAX_MESSAGE_AGE_MS) throw new SnsError(400, 'sns_message_stale', 'the message is more than 24 hours old');
  if (t - now.getTime() > MAX_CLOCK_SKEW_MS) throw new SnsError(400, 'sns_message_future', 'the message is dated more than 5 minutes ahead');
}

/** AWS's signing certificate path. */
const CERT_PATH = /^\/SimpleNotificationService-[0-9a-f]{16,64}\.pem$/;

/**
 * Whether `url` is somewhere Postroom may fetch from for SNS: https, default port, no credentials,
 * no query for a certificate, and a host of exactly `sns.<region>.amazonaws.com`; for a signing
 * certificate, AWS's /SimpleNotificationService-<hex>.pem path.
 */
export function isSnsUrl(url: string, opts: { region: string; pem?: boolean }): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
  if (u.hostname.toLowerCase() !== `sns.${opts.region}.amazonaws.com`) return false;
  if (opts.pem === true && (!CERT_PATH.test(u.pathname) || u.search !== '' || u.hash !== '')) return false;
  return true;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const FETCH_TIMEOUT_MS = 5_000;
const MAX_CERT_BYTES = 16 * 1024;
const MAX_CACHED_CERTS = 16;
const MAX_FAILED_URLS = 256;

/** The system fetch with a timeout and no redirects (a redirect could leave the allow-listed host). */
export const timedFetch: Fetcher = (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export interface CertCacheOptions {
  /** Clock in ms, for the negative cache and the rate limit (tests move it). */
  readonly now?: () => number;
  /** Certificate fetches allowed per rolling minute (default 10). */
  readonly fetchesPerMinute?: number;
  /** How long a failed fetch is remembered (default 10 minutes). */
  readonly failureTtlMs?: number;
}

/** Fetches signing certificates from allow-listed SNS URLs only, bounded as the header describes. */
export class CertCache {
  private readonly certs = new Map<string, { cert: X509Certificate; pinned: boolean }>();
  private readonly failed = new Map<string, { until: number; error: SnsError }>();
  private fetches: number[] = [];
  private readonly now: () => number;
  private readonly fetchesPerMinute: number;
  private readonly failureTtlMs: number;
  /** Fetches actually sent (tests read it). */
  fetchCount = 0;

  constructor(
    private readonly fetcher: Fetcher,
    options: CertCacheOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fetchesPerMinute = options.fetchesPerMinute ?? 10;
    this.failureTtlMs = options.failureTtlMs ?? 10 * 60_000;
  }

  async get(url: string, region: string): Promise<X509Certificate> {
    if (!isSnsUrl(url, { region, pem: true })) throw new SnsError(403, 'sns_cert_url_refused', 'SigningCertURL is not an SNS certificate URL for the topic region');
    const cached = this.certs.get(url);
    if (cached !== undefined) return cached.cert;
    const now = this.now();
    const failure = this.failed.get(url);
    if (failure !== undefined) {
      if (failure.until > now) throw failure.error;
      this.failed.delete(url);
    }
    this.fetches = this.fetches.filter((t) => now - t < 60_000);
    if (this.fetches.length >= this.fetchesPerMinute) throw new SnsError(403, 'sns_cert_rate_limited', 'too many signing certificate fetches; try again later');
    this.fetches.push(now);
    this.fetchCount++;
    let cert: X509Certificate;
    try {
      cert = await this.fetchCert(url);
    } catch (e) {
      if (e instanceof SnsError) {
        if (this.failed.size >= MAX_FAILED_URLS) {
          const oldest = this.failed.keys().next().value;
          if (oldest !== undefined) this.failed.delete(oldest);
        }
        this.failed.set(url, { until: now + this.failureTtlMs, error: e });
      }
      throw e;
    }
    if (this.certs.size >= MAX_CACHED_CERTS) {
      // Evict the oldest certificate that has not verified a message; the pinned one stays.
      const victim = [...this.certs.entries()].find(([, v]) => !v.pinned)?.[0] ?? this.certs.keys().next().value;
      if (victim !== undefined) this.certs.delete(victim);
    }
    this.certs.set(url, { cert, pinned: false });
    return cert;
  }

  /** Mark `url`'s certificate as the one that verifies our topic's messages; unpins any other. */
  pin(url: string): void {
    const entry = this.certs.get(url);
    if (entry === undefined || entry.pinned) return;
    for (const v of this.certs.values()) v.pinned = false;
    entry.pinned = true;
  }

  isCached(url: string): boolean {
    return this.certs.has(url);
  }

  private async fetchCert(url: string): Promise<X509Certificate> {
    let res: Response;
    try {
      res = await this.fetcher(url, { redirect: 'error' });
    } catch {
      throw new SnsError(403, 'sns_cert_unavailable', 'the signing certificate could not be fetched');
    }
    if (!res.ok) throw new SnsError(403, 'sns_cert_unavailable', `the signing certificate fetch answered ${String(res.status)}`);
    const text = await res.text();
    if (text.length > MAX_CERT_BYTES) throw new SnsError(403, 'sns_cert_invalid', 'the signing certificate is too large');
    try {
      return new X509Certificate(text);
    } catch {
      throw new SnsError(403, 'sns_cert_invalid', 'the signing certificate is not a PEM certificate');
    }
  }
}

/**
 * Throws SnsError unless `m` is fresh (400) and its signature verifies under the certificate its
 * SigningCertURL names, fetched from the topic's region (403). `region` defaults to the TopicArn's.
 */
export async function verifySnsMessage(m: SnsMessage, certs: CertCache, now: Date = new Date(), region: string = snsRegion(m)): Promise<void> {
  checkTimestamp(m, now);
  const cert = await certs.get(m.SigningCertURL, region);
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
  certs.pin(m.SigningCertURL);
}

export interface SnsGateOptions {
  /** SES_SNS_TOPIC_ARNS: the only topics read. Empty refuses everything. */
  readonly topics: ReadonlySet<string>;
  /** SES_SNS_REGION, when set: a topic elsewhere is refused. */
  readonly configuredRegion?: string | undefined;
  readonly certs: CertCache;
  readonly now: Date;
}

/**
 * The whole acceptance check, in the order that keeps a stranger from making Postroom fetch
 * anything: the topic allow-list, the topic's region, the Timestamp window, a SubscribeURL on the
 * region's SNS host, and only then the certificate and the signature. Returns the region.
 */
export async function verifyFromTopic(m: SnsMessage, opts: SnsGateOptions): Promise<string> {
  if (!opts.topics.has(m.TopicArn)) throw new SnsError(403, 'sns_topic_refused', opts.topics.size === 0 ? 'SES_SNS_TOPIC_ARNS is not set' : 'TopicArn is not in SES_SNS_TOPIC_ARNS');
  // The topic's own region, and SES_SNS_REGION when set: the only SNS host fetched from.
  const region = snsRegion(m, opts.configuredRegion);
  // A stale or future-dated message is refused before its certificate is fetched.
  checkTimestamp(m, opts.now);
  if (m.Type === 'SubscriptionConfirmation' && !isSnsUrl(m.SubscribeURL ?? '', { region })) {
    throw new SnsError(403, 'sns_subscribe_url_refused', 'SubscribeURL is not an SNS URL for the topic region');
  }
  await verifySnsMessage(m, opts.certs, opts.now, region);
  return region;
}

/**
 * Refusals that say something about the message itself — malformed, not our topic, out of its time
 * window, a certificate host or signature that is wrong. The same message will be refused again,
 * so a queue consumer drops it. Everything else (the certificate could not be fetched, was rate
 * limited, or was not usable just now) may pass on a later try.
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'invalid_sns_message',
  'sns_topic_refused',
  'sns_region_refused',
  'sns_message_stale',
  'sns_message_future',
  'sns_cert_url_refused',
  'sns_subscribe_url_refused',
  'sns_signature_invalid',
]);

export function isPermanentRefusal(e: SnsError): boolean {
  return PERMANENT_CODES.has(e.code);
}
