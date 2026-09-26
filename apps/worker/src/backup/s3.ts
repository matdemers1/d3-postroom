// A small S3 client for backups (PST-T-0.16, PST-REQ-022): PutObject with SSE-KMS, GetObject,
// HeadObject and ListObjectsV2 — signed with the hand-rolled SigV4 in sigv4.ts, sent with
// node:http/https so bodies stream both ways. No AWS SDK.
//
// Bodies are streamed with a known Content-Length (S3 refuses a plain chunked PUT). A caller that
// already hashed the body (the dump) passes its SHA-256 so S3 verifies it; blob files are sent as
// UNSIGNED-PAYLOAD over TLS, since they are content-addressed and re-hashing each would double the
// read.
//
// Addressing: virtual-hosted (`https://<bucket>.s3.<region>.amazonaws.com/<key>`) against AWS;
// path-style (`<endpoint>/<bucket>/<key>`) when BACKUP_S3_ENDPOINT points somewhere else.
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { amzDate, EMPTY_SHA256, encodePath, canonicalQuery, sign, UNSIGNED_PAYLOAD, type Credentials } from './sigv4.js';

export interface S3Config {
  bucket: string;
  region: string;
  credentials: Credentials;
  /** e.g. http://127.0.0.1:9000; when set, requests are path-style against it. */
  endpoint?: string;
  /** SSE-KMS key for every PUT. */
  kmsKeyId: string;
  /** Clock, for tests. */
  now?: () => Date;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

export interface PutBody {
  /** The bytes; a stream is consumed exactly once. */
  body: Readable | Buffer;
  contentLength: number;
  /** Hex SHA-256 of the body; omitted → UNSIGNED-PAYLOAD. */
  sha256?: string;
  contentType?: string;
  /** User metadata, sent as x-amz-meta-<name>. */
  metadata?: Readonly<Record<string, string>>;
}

export interface PutResult {
  etag: string | null;
  versionId: string | null;
}

export interface HeadResult {
  contentLength: number;
  etag: string | null;
  metadata: Record<string, string>;
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface S3Client {
  readonly bucket: string;
  putObject: (key: string, body: PutBody) => Promise<PutResult>;
  /** The object's bytes as a stream, or null when it does not exist. */
  getObject: (key: string) => Promise<IncomingMessage | null>;
  headObject: (key: string) => Promise<HeadResult | null>;
  /** Every object under `prefix`, page by page (ListObjectsV2 with continuation tokens). */
  listObjects: (prefix: string, pageSize?: number) => AsyncGenerator<ListedObject>;
}

export interface BuiltRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

/** Build and sign one request. Exported so the unit tests can assert on exactly what goes out. */
export function buildRequest(
  config: S3Config,
  method: string,
  key: string,
  opts: { query?: [string, string][]; headers?: Record<string, string>; payloadHash?: string } = {},
): BuiltRequest {
  const query = opts.query ?? [];
  let base: URL;
  let path: string;
  if (config.endpoint === undefined) {
    base = new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com`);
    path = `/${key}`;
  } else {
    base = new URL(config.endpoint);
    path = `${base.pathname.replace(/\/$/, '')}/${config.bucket}${key === '' ? '' : `/${key}`}`;
  }
  const payloadHash = opts.payloadHash ?? EMPTY_SHA256;
  const date = amzDate((config.now ?? (() => new Date()))());
  const headers: Record<string, string> = {
    host: base.host,
    'x-amz-date': date,
    'x-amz-content-sha256': payloadHash,
    ...(config.credentials.sessionToken === undefined ? {} : { 'x-amz-security-token': config.credentials.sessionToken }),
    ...opts.headers,
  };
  const signature = sign({ method, path, query, headers, payloadHash }, {
    credentials: config.credentials,
    region: config.region,
    service: 's3',
    amzDate: date,
    s3: true,
  });
  headers['authorization'] = signature.authorization;
  const qs = canonicalQuery(query);
  const url = new URL(`${base.protocol}//${base.host}${encodePath(path)}${qs === '' ? '' : `?${qs}`}`);
  return { url, method, headers };
}

function send(req: BuiltRequest, body?: Readable | Buffer): Promise<IncomingMessage> {
  const requester = req.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = requester(req.url, { method: req.method, headers: req.headers }, resolve);
    r.on('error', reject);
    if (body === undefined) r.end();
    else if (Buffer.isBuffer(body)) r.end(body);
    else {
      body.on('error', (error) => { r.destroy(error); });
      body.pipe(r);
    }
  });
}

async function readAll(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function xmlUnescape(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m?.[1] === undefined ? null : xmlUnescape(m[1]);
}

async function failure(res: IncomingMessage, what: string): Promise<S3Error> {
  const text = await readAll(res);
  const code = tag(text, 'Code') ?? `HTTP${res.statusCode ?? 0}`;
  const message = tag(text, 'Message') ?? res.statusMessage ?? '';
  return new S3Error(res.statusCode ?? 0, code, `${what}: ${res.statusCode ?? 0} ${code}${message === '' ? '' : ` — ${message}`}`);
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const v = headers[name];
  return typeof v === 'string' ? v : null;
}

/** Parse one ListObjectsV2 page. Exported for the unit tests. */
export function parseListPage(xml: string): { objects: ListedObject[]; truncated: boolean; next: string | null } {
  const objects: ListedObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1] ?? '';
    const key = tag(body, 'Key');
    if (key !== null) objects.push({ key, size: Number(tag(body, 'Size') ?? '0') });
  }
  return { objects, truncated: tag(xml, 'IsTruncated') === 'true', next: tag(xml, 'NextContinuationToken') };
}

export function createS3Client(config: S3Config): S3Client {
  const putObject = async (key: string, put: PutBody): Promise<PutResult> => {
    const headers: Record<string, string> = {
      'content-length': String(put.contentLength),
      'content-type': put.contentType ?? 'application/octet-stream',
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': config.kmsKeyId,
    };
    for (const [name, value] of Object.entries(put.metadata ?? {})) headers[`x-amz-meta-${name.toLowerCase()}`] = value;
    const req = buildRequest(config, 'PUT', key, { headers, payloadHash: put.sha256 ?? UNSIGNED_PAYLOAD });
    const res = await send(req, put.body);
    if (res.statusCode !== 200) throw await failure(res, `PUT ${key}`);
    res.resume();
    return { etag: header(res.headers, 'etag'), versionId: header(res.headers, 'x-amz-version-id') };
  };

  const getObject = async (key: string): Promise<IncomingMessage | null> => {
    const res = await send(buildRequest(config, 'GET', key));
    if (res.statusCode === 404) {
      res.resume();
      return null;
    }
    if (res.statusCode !== 200) throw await failure(res, `GET ${key}`);
    return res;
  };

  const headObject = async (key: string): Promise<HeadResult | null> => {
    const res = await send(buildRequest(config, 'HEAD', key));
    res.resume();
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) throw new S3Error(res.statusCode ?? 0, `HTTP${res.statusCode ?? 0}`, `HEAD ${key}: ${res.statusCode ?? 0}`);
    const metadata: Record<string, string> = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (name.startsWith('x-amz-meta-') && typeof value === 'string') metadata[name.slice('x-amz-meta-'.length)] = value;
    }
    return { contentLength: Number(header(res.headers, 'content-length') ?? '0'), etag: header(res.headers, 'etag'), metadata };
  };

  async function* listObjects(prefix: string, pageSize = 1000): AsyncGenerator<ListedObject> {
    let token: string | null = null;
    for (;;) {
      const query: [string, string][] = [['list-type', '2'], ['prefix', prefix], ['max-keys', String(pageSize)]];
      if (token !== null) query.push(['continuation-token', token]);
      const res = await send(buildRequest(config, 'GET', '', { query }));
      if (res.statusCode !== 200) throw await failure(res, `LIST ${prefix}`);
      const page = parseListPage(await readAll(res));
      yield* page.objects;
      if (!page.truncated) return;
      if (page.next === null) throw new S3Error(200, 'MissingContinuationToken', `LIST ${prefix}: truncated page without a continuation token`);
      token = page.next;
    }
  }

  return { bucket: config.bucket, putObject, getObject, headObject, listObjects };
}
