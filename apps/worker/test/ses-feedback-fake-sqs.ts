// A fake Amazon SQS on loopback for the SES feedback poller's tests (PST-T-11.17). Strict where it
// matters: every request must be a SigV4-signed JSON-protocol POST (service 'sqs', the configured
// region and key, host/x-amz-date/x-amz-target/content-type signed), and the signature is
// recomputed with the shared secret and refused on mismatch, as SQS would. It serves queued
// messages with an ApproximateReceiveCount, hides a received message until it is deleted or its
// visibility changes, holds an empty long poll until a message arrives or the client goes away, and
// records every call.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseAuthorization, sha256Hex, sign } from '../src/backup/sigv4.js';

export const REGION = 'us-east-1';
export const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/postroom-ses-feedback';

interface Queued {
  id: string;
  body: string;
  receives: number;
  /** Receipt handle of the current receive, while in flight. */
  handle: string | null;
  visibleAt: number;
}

export interface FakeSqs {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Every call: target and status answered. */
  readonly calls: { target: string; status: number }[];
  readonly deleted: string[];
  readonly visibility: { id: string; seconds: number }[];
  /** Enqueue a message body; returns its SQS MessageId. `receives` starts the ApproximateReceiveCount. */
  push(body: string, receives?: number): string;
  /** Messages still on the queue (in flight or visible). */
  remaining(): string[];
  /** Answer the next `n` ReceiveMessage calls with this error. */
  failReceive(status: number, type: string, n?: number): void;
  /** Make every in-flight message visible again (its visibility timeout ran out). */
  expireAll(): void;
  /** Long polls currently held open. */
  pending(): number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeSqs(opts: { waitMs?: number } = {}): Promise<FakeSqs> {
  const accessKeyId = 'AKIAPOSTROOMSQSTEST';
  const secretAccessKey = 'fake/secret/for/the/loopback/sqs';
  const queue: Queued[] = [];
  const calls: FakeSqs['calls'] = [];
  const deleted: string[] = [];
  const visibility: FakeSqs['visibility'] = [];
  const failures: { status: number; type: string }[] = [];
  const waiters = new Set<() => void>();
  let seq = 0;

  // Both return null so a handler can `return error(...)`.
  const json = (res: ServerResponse, status: number, body: unknown, target: string): null => {
    calls.push({ target, status });
    res.writeHead(status, { 'content-type': 'application/x-amz-json-1.0' });
    res.end(JSON.stringify(body));
    return null;
  };
  const error = (res: ServerResponse, status: number, type: string, message: string, target: string): null => {
    res.setHeader('x-amzn-query-error', `${type};Sender`);
    return json(res, status, { __type: `com.amazonaws.sqs#${type}`, message }, target);
  };

  const visible = (): Queued[] => queue.filter((q) => q.visibleAt <= Date.now());

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<null> => {
    const body = await readBody(req);
    const rawTarget = req.headers['x-amz-target'];
    const target = typeof rawTarget === 'string' ? rawTarget : '';
    if (req.method !== 'POST' || req.url !== '/') return error(res, 400, 'InvalidAction', 'POST / only', target);
    if (req.headers['content-type'] !== 'application/x-amz-json-1.0') return error(res, 400, 'InvalidParameterValue', 'content-type', target);
    const auth = parseAuthorization(req.headers['authorization'] ?? '');
    const date = String(req.headers['x-amz-date'] ?? '');
    if (auth === null || auth.accessKeyId !== accessKeyId) return error(res, 403, 'InvalidClientTokenId', 'The security token included in the request is invalid.', target);
    if (auth.service !== 'sqs' || auth.region !== REGION || auth.date !== date.slice(0, 8)) return error(res, 403, 'SignatureDoesNotMatch', 'wrong scope', target);
    for (const h of ['host', 'x-amz-date', 'x-amz-target', 'content-type']) {
      if (!auth.signedHeaders.includes(h)) return error(res, 403, 'SignatureDoesNotMatch', `${h} is not signed`, target);
    }
    const headers: Record<string, string> = {};
    for (const h of auth.signedHeaders) headers[h] = String(req.headers[h] ?? '');
    const expected = sign({ method: 'POST', path: '/', headers, payloadHash: sha256Hex(body) }, { credentials: { accessKeyId, secretAccessKey }, region: REGION, service: 'sqs', amzDate: date });
    if (expected.signature !== auth.signature) return error(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match', target);

    const params = JSON.parse(body) as Record<string, unknown>;
    if (params['QueueUrl'] !== QUEUE_URL) return error(res, 400, 'QueueDoesNotExist', 'no such queue', target);

    if (target === 'AmazonSQS.ReceiveMessage') {
      const failure = failures.shift();
      if (failure !== undefined) return error(res, failure.status, failure.type, 'injected', target);
      const max = Number(params['MaxNumberOfMessages'] ?? 1);
      const vis = Number(params['VisibilityTimeout'] ?? 30);
      const names = params['MessageSystemAttributeNames'];
      if (!Array.isArray(names) || !names.includes('ApproximateReceiveCount')) return error(res, 400, 'InvalidParameterValue', 'attributes', target);
      if (visible().length === 0) {
        // A long poll: wait for a message, the wait time, or the client hanging up.
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            waiters.delete(wake);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(wake, opts.waitMs ?? Number(params['WaitTimeSeconds'] ?? 0) * 1000);
          waiters.add(wake);
          res.once('close', wake);
        });
        if (res.destroyed || res.writableEnded) {
          calls.push({ target, status: 0 });
          return null;
        }
      }
      const out = visible().slice(0, max).map((q) => {
        q.receives++;
        q.handle = `rh-${q.id}-${String(q.receives)}`;
        q.visibleAt = Date.now() + vis * 1000;
        return { MessageId: q.id, ReceiptHandle: q.handle, MD5OfBody: 'x', Body: q.body, Attributes: { ApproximateReceiveCount: String(q.receives) } };
      });
      return json(res, 200, out.length === 0 ? {} : { Messages: out }, target);
    }
    if (target === 'AmazonSQS.DeleteMessage') {
      const i = queue.findIndex((q) => q.handle === params['ReceiptHandle']);
      if (i < 0) return error(res, 400, 'ReceiptHandleIsInvalid', 'unknown receipt handle', target);
      const [q] = queue.splice(i, 1);
      if (q !== undefined) deleted.push(q.id);
      return json(res, 200, {}, target);
    }
    if (target === 'AmazonSQS.ChangeMessageVisibility') {
      const q = queue.find((x) => x.handle === params['ReceiptHandle']);
      if (q === undefined) return error(res, 400, 'ReceiptHandleIsInvalid', 'unknown receipt handle', target);
      visibility.push({ id: q.id, seconds: Number(params['VisibilityTimeout']) });
      q.visibleAt = Date.now() + Number(params['VisibilityTimeout']) * 1000;
      return json(res, 200, {}, target);
    }
    return error(res, 400, 'InvalidAction', `unknown target ${target}`, target);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) error(res, 500, 'InternalError', String(e), '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${String(port)}/`,
    accessKeyId,
    secretAccessKey,
    calls,
    deleted,
    visibility,
    push(body, receives = 0) {
      const id = `${String(++seq)}-${randomUUID()}`;
      queue.push({ id, body, receives, handle: null, visibleAt: 0 });
      for (const w of [...waiters]) w();
      return id;
    },
    remaining: () => queue.map((q) => q.id),
    failReceive(status, type, n = 1) {
      for (let i = 0; i < n; i++) failures.push({ status, type });
    },
    expireAll() {
      for (const q of queue) q.visibleAt = 0;
      for (const w of [...waiters]) w();
    },
    pending: () => waiters.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const w of [...waiters]) w();
        server.closeAllConnections();
        server.close(() => { resolve(); });
      }),
  };
}
