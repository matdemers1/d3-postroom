// A fake S3 on loopback for the backup and drill tests (PST-T-0.16, PST-T-0.17). It is strict in
// the ways that matter: every request's SigV4 signature is recomputed with the shared secret and
// refused on mismatch; a signed payload hash is checked against the body; a PUT without SSE-KMS is
// refused (the bucket policy); every DELETE is refused with 403 AccessDenied (the IAM user's
// explicit Deny). Objects are versioned in memory, so an overwrite keeps the old bytes.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseAuthorization, sign, UNSIGNED_PAYLOAD } from '../../src/backup/sigv4.js';

export interface StoredVersion {
  body: Buffer;
  metadata: Record<string, string>;
  versionId: string;
  sse: string;
  kmsKeyId: string;
}

export interface FakeS3 {
  url: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  kmsKeyId: string;
  /** key → versions, oldest first. */
  objects: Map<string, StoredVersion[]>;
  /** Every request that reached a handler: `${method} ${key or ?query}` and the status answered. */
  log: { method: string; key: string; status: number }[];
  current: (key: string) => Buffer | undefined;
  /** Replace the current bytes of an object in place (simulating corruption at rest). */
  tamper: (key: string, bytes: Buffer) => void;
  close: () => Promise<void>;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeS3(opts: { bucket?: string; pageSize?: number } = {}): Promise<FakeS3> {
  const bucket = opts.bucket ?? 'pst-backups-test';
  const accessKeyId = 'AKIAPOSTROOMTEST';
  const secretAccessKey = 'fake/secret/for/the/loopback/s3';
  const kmsKeyId = 'arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000';
  const objects = new Map<string, StoredVersion[]>();
  const log: FakeS3['log'] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').slice(1).map((s) => decodeURIComponent(s));
    const [b = '', ...rest] = segments;
    const key = rest.join('/');
    const answer = (status: number): void => { log.push({ method, key: key === '' ? `?${url.searchParams.toString()}` : key, status }); };

    // Signature: recompute from what arrived, with the shared secret.
    const auth = parseAuthorization(req.headers.authorization ?? '');
    const amzDate = String(req.headers['x-amz-date'] ?? '');
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    if (auth === null || auth.accessKeyId !== accessKeyId || payloadHash === '') {
      answer(403);
      error(res, 403, 'InvalidAccessKeyId', 'missing or unknown credentials');
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of auth.signedHeaders) headers[name] = String(req.headers[name] ?? '');
    const expected = sign(
      { method, path: url.pathname.split('/').map((s) => decodeURIComponent(s)).join('/'), query: [...url.searchParams.entries()], headers, payloadHash },
      { credentials: { accessKeyId, secretAccessKey }, region: auth.region, service: auth.service, amzDate, s3: true },
    );
    if (expected.signature !== auth.signature || !auth.signedHeaders.includes('host') || auth.date !== amzDate.slice(0, 8)) {
      answer(403);
      error(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
      return;
    }
    if (b !== bucket) {
      answer(404);
      error(res, 404, 'NoSuchBucket', b);
      return;
    }

    if (method === 'DELETE' || (method === 'POST' && url.searchParams.has('delete'))) {
      // The IAM policy: an explicit Deny on s3:DeleteObject* for the backup user.
      answer(403);
      error(res, 403, 'AccessDenied', 'Access Denied');
      return;
    }

    if (method === 'PUT' && key !== '') {
      const sse = String(req.headers['x-amz-server-side-encryption'] ?? '');
      const kms = String(req.headers['x-amz-server-side-encryption-aws-kms-key-id'] ?? '');
      if (sse !== 'aws:kms' || kms !== kmsKeyId || !auth.signedHeaders.includes('x-amz-server-side-encryption')) {
        answer(403);
        error(res, 403, 'AccessDenied', 'bucket policy requires SSE-KMS with the backup key');
        return;
      }
      const body = await readBody(req);
      if (Number(req.headers['content-length']) !== body.length) {
        answer(400);
        error(res, 400, 'IncompleteBody', 'body shorter than Content-Length');
        return;
      }
      if (payloadHash !== UNSIGNED_PAYLOAD && createHash('sha256').update(body).digest('hex') !== payloadHash) {
        answer(400);
        error(res, 400, 'XAmzContentSHA256Mismatch', 'content sha256 mismatch');
        return;
      }
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (name.startsWith('x-amz-meta-') && typeof value === 'string') metadata[name.slice(11)] = value;
      }
      const version: StoredVersion = { body, metadata, versionId: randomUUID(), sse, kmsKeyId: kms };
      objects.set(key, [...(objects.get(key) ?? []), version]);
      answer(200);
      res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"`, 'x-amz-version-id': version.versionId });
      res.end();
      return;
    }

    if ((method === 'GET' || method === 'HEAD') && key !== '') {
      const v = objects.get(key)?.at(-1);
      if (v === undefined) {
        answer(404);
        if (method === 'HEAD') res.writeHead(404).end();
        else error(res, 404, 'NoSuchKey', key);
        return;
      }
      answer(200);
      const h: Record<string, string> = { 'content-length': String(v.body.length), 'x-amz-version-id': v.versionId };
      for (const [name, value] of Object.entries(v.metadata)) h[`x-amz-meta-${name}`] = value;
      res.writeHead(200, h);
      res.end(method === 'HEAD' ? undefined : v.body);
      return;
    }

    if (method === 'GET' && key === '' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const max = Math.min(Number(url.searchParams.get('max-keys') ?? '1000'), opts.pageSize ?? 1000);
      const start = Number(Buffer.from(url.searchParams.get('continuation-token') ?? 'MA==', 'base64').toString('utf8'));
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = keys.slice(start, start + max);
      const truncated = start + max < keys.length;
      const contents = page
        .map((k) => `<Contents><Key>${xmlEscape(k)}</Key><Size>${objects.get(k)?.at(-1)?.body.length ?? 0}</Size></Contents>`)
        .join('');
      answer(200);
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
          `<KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${Buffer.from(String(start + max)).toString('base64')}</NextContinuationToken>` : '') +
          `${contents}</ListBucketResult>`,
      );
      return;
    }

    answer(400);
    error(res, 400, 'NotImplemented', `${method} ${url.pathname}`);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      error(res, 500, 'InternalError', e instanceof Error ? e.message : String(e));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bucket,
    accessKeyId,
    secretAccessKey,
    kmsKeyId,
    objects,
    log,
    current: (key) => objects.get(key)?.at(-1)?.body,
    tamper: (key, bytes) => {
      const v = objects.get(key)?.at(-1);
      if (v === undefined) throw new Error(`no object ${key}`);
      v.body = bytes;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { resolve(); }); }),
  };
}
