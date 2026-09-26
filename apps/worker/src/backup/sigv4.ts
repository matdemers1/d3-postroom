// AWS Signature Version 4, hand-rolled (PST-T-0.16): no AWS SDK, only node:crypto.
//
//   canonical request = METHOD \n canonical URI \n canonical query \n canonical headers \n
//                       signed headers \n payload hash
//   string to sign    = "AWS4-HMAC-SHA256" \n amzDate \n scope \n hex(sha256(canonical request))
//   signing key       = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request")
//   signature         = hex(HMAC(signing key, string to sign))
//
// S3 differs from the other services in one place: its canonical URI is the path encoded ONCE
// (each segment URI-encoded, '/' kept), where every other service double-encodes. `s3: true`
// selects that. Tested against AWS's published vectors in test/unit/backup-sigv4.test.ts.
import { createHash, createHmac } from 'node:crypto';

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  /** The raw (unencoded) path, beginning with '/'. */
  path: string;
  /** Query parameters, unencoded. A parameter with no value (`?lifecycle`) has value ''. */
  query?: readonly (readonly [string, string])[];
  /** Header names in any case; values are trimmed and inner runs of spaces collapsed. */
  headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or UNSIGNED-PAYLOAD. */
  payloadHash: string;
}

export interface SignOptions {
  credentials: Credentials;
  region: string;
  service: string;
  /** `YYYYMMDD'T'HHMMSS'Z'`. */
  amzDate: string;
  /** S3 single-encodes the path; everything else double-encodes. */
  s3?: boolean;
}

export interface Signature {
  canonicalRequest: string;
  stringToSign: string;
  signedHeaders: string;
  signature: string;
  authorization: string;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 unreserved characters pass; everything else is %XX with uppercase hex. */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (c === '/' && !encodeSlash)) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The path as it goes on the wire (and, for S3, in the canonical request). */
export function encodePath(path: string): string {
  return uriEncode(path, false);
}

export function canonicalUri(path: string, s3: boolean): string {
  const once = encodePath(path === '' ? '/' : path);
  return s3 ? once : uriEncode(once, false);
}

export function canonicalQuery(query: readonly (readonly [string, string])[] = []): string {
  return query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): { text: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/ +/g, ' ')] as const)
    .sort((a, b) => cmp(a[0], b[0]));
  return {
    text: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
}

export function sign(request: SignableRequest, options: SignOptions): Signature {
  const { text, signed } = canonicalHeaders(request.headers);
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(request.path, options.s3 === true),
    canonicalQuery(request.query),
    text,
    signed,
    request.payloadHash,
  ].join('\n');
  const date = options.amzDate.slice(0, 8);
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [ALGORITHM, options.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = signingKey(options.credentials.secretAccessKey, date, options.region, options.service);
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    canonicalRequest,
    stringToSign,
    signedHeaders: signed,
    signature,
    authorization: `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

/** `2013-05-24T00:00:00.000Z` → `20130524T000000Z`. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface ParsedAuthorization {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

/** Parse an `Authorization: AWS4-HMAC-SHA256 ...` header (the fake S3 in the tests verifies with it). */
export function parseAuthorization(header: string): ParsedAuthorization | null {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(header);
  if (m === null) return null;
  const [, accessKeyId = '', date = '', region = '', service = '', signedHeaders = '', signature = ''] = m;
  return { accessKeyId, date, region, service, signedHeaders: signedHeaders.split(';'), signature };
}
