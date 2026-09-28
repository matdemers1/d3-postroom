// A minimal Amazon SQS client for the SES feedback poller (PST-T-11.17): ReceiveMessage,
// DeleteMessage and ChangeMessageVisibility — the three calls the poller's IAM user may make — over
// SQS's JSON protocol, signed with the worker's hand-written SigV4 (../backup/sigv4.ts, service
// 'sqs'). No AWS SDK.
//
// The JSON protocol: POST to the regional endpoint's root (https://sqs.<region>.amazonaws.com/)
// with `Content-Type: application/x-amz-json-1.0` and `X-Amz-Target: AmazonSQS.<Action>`, the
// parameters as a JSON body (QueueUrl among them). An error answers 4xx/5xx with
// `{"__type": "<namespace>#<Code>", "message": ...}` and an `x-amzn-query-error: <Code>;Sender`
// header; the code decides what the poller does next:
//
//   transient  network failure, timeout, 5xx, throttling — back off and try again.
//   refused    the credentials, the signature, the policy or the queue — a person has to act, so the
//              poller alerts once and keeps retrying slowly until it clears.
import { amzDate, sha256Hex, sign, type Credentials } from '../backup/sigv4.js';

export interface SqsMessage {
  readonly messageId: string;
  readonly receiptHandle: string;
  /** The raw message body: for an SNS subscription without raw delivery, the SNS envelope JSON. */
  readonly body: string;
  /** ApproximateReceiveCount: how many times SQS has handed this message out, this time included. */
  readonly receiveCount: number;
}

export type SqsErrorKind = 'transient' | 'refused';

export class SqsError extends Error {
  constructor(
    readonly kind: SqsErrorKind,
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SqsError';
  }
}

/** Codes that retrying will not fix: an operator has to change the key, the policy or the queue. */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'SignatureDoesNotMatch',
  'IncompleteSignature',
  'MissingAuthenticationToken',
  'InvalidSecurity',
  'ExpiredToken',
  'RequestExpired',
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
  'KmsAccessDenied',
  'KmsDisabled',
  'KmsNotFound',
  'KmsInvalidKeyUsage',
  'KmsInvalidState',
]);

/** Codes that are worth waiting out, whatever their status. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['ThrottlingException', 'RequestThrottled', 'ServiceUnavailable', 'InternalError', 'InternalFailure', 'KmsThrottled', 'KmsOptInRequired']);

/** Classify an SQS error answer. Exported for tests. */
export function classifySqsError(status: number, code: string): SqsErrorKind {
  if (TRANSIENT_CODES.has(code)) return 'transient';
  if (REFUSED_CODES.has(code) || status === 401 || status === 403) return 'refused';
  if (status >= 500) return 'transient';
  // Any other 4xx is a request this client should not have made; retrying will not change it.
  return status >= 400 ? 'refused' : 'transient';
}

export interface SqsClientOptions {
  readonly queueUrl: string;
  readonly region: string;
  /** Where the requests go; default `https://sqs.<region>.amazonaws.com/`. Tests point it at loopback. */
  readonly endpoint?: string;
  readonly credentials: Credentials;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** Long-poll wait (default 20 s, the SQS maximum). */
  readonly waitTimeSeconds?: number;
  /** Visibility timeout for received messages (default 120 s, the queue's own). */
  readonly visibilityTimeout?: number;
  /** Messages per receive (default 10, the SQS maximum). */
  readonly maxMessages?: number;
  /** Timeout for a delete or visibility change (default 15 s). */
  readonly requestTimeoutMs?: number;
}

export interface SqsClient {
  /** Long-poll for messages. `signal` aborts the poll (shutdown). */
  receive(signal?: AbortSignal): Promise<SqsMessage[]>;
  delete(receiptHandle: string): Promise<void>;
  changeVisibility(receiptHandle: string, seconds: number): Promise<void>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The error code from `__type` (`com.amazonaws.sqs#QueueDoesNotExist` → `QueueDoesNotExist`) or the query-error header. */
function errorCode(body: unknown, header: string | null): string {
  if (isObj(body) && typeof body['__type'] === 'string') {
    const t = body['__type'];
    return t.slice(t.lastIndexOf('#') + 1) || t;
  }
  if (header !== null && header !== '') return header.split(';')[0] ?? header;
  return 'Unknown';
}

export function createSqsClient(opts: SqsClientOptions): SqsClient {
  const endpoint = new URL(opts.endpoint ?? `https://sqs.${opts.region}.amazonaws.com/`);
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? ((): Date => new Date());
  const wait = opts.waitTimeSeconds ?? 20;

  async function call(target: string, params: Obj, signal: AbortSignal): Promise<unknown> {
    const body = JSON.stringify({ QueueUrl: opts.queueUrl, ...params });
    const date = amzDate(now());
    // fetch sets Host itself, from the URL; it is signed below with the same value.
    const sent: Record<string, string> = {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-date': date,
      'x-amz-target': `AmazonSQS.${target}`,
      ...(opts.credentials.sessionToken === undefined ? {} : { 'x-amz-security-token': opts.credentials.sessionToken }),
    };
    const signature = sign(
      { method: 'POST', path: endpoint.pathname || '/', headers: { host: endpoint.host, ...sent }, payloadHash: sha256Hex(body) },
      { credentials: opts.credentials, region: opts.region, service: 'sqs', amzDate: date },
    );
    let res: Response;
    try {
      res = await doFetch(endpoint, { method: 'POST', headers: { ...sent, authorization: signature.authorization }, body, redirect: 'error', signal });
    } catch (e) {
      if (signal.aborted && !(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')) throw e;
      throw new SqsError('transient', 'NetworkError', 0, e instanceof Error ? e.message : String(e));
    }
    const text = await res.text();
    let parsed: unknown = {};
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
    }
    if (!res.ok) {
      const code = errorCode(parsed, res.headers.get('x-amzn-query-error'));
      const message = isObj(parsed) && typeof parsed['message'] === 'string' ? parsed['message'].slice(0, 300) : `SQS answered ${String(res.status)}`;
      throw new SqsError(classifySqsError(res.status, code), code, res.status, message);
    }
    return parsed;
  }

  const timeout = (): AbortSignal => AbortSignal.timeout(opts.requestTimeoutMs ?? 15_000);

  return {
    async receive(signal) {
      // Longer than the long poll, so a healthy empty poll never times out.
      const limit = AbortSignal.timeout((wait + 15) * 1000);
      const out = await call(
        'ReceiveMessage',
        {
          MaxNumberOfMessages: opts.maxMessages ?? 10,
          WaitTimeSeconds: wait,
          VisibilityTimeout: opts.visibilityTimeout ?? 120,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        },
        signal === undefined ? limit : AbortSignal.any([signal, limit]),
      );
      const list = isObj(out) && Array.isArray(out['Messages']) ? out['Messages'] : [];
      const messages: SqsMessage[] = [];
      for (const m of list) {
        if (!isObj(m) || typeof m['ReceiptHandle'] !== 'string' || typeof m['MessageId'] !== 'string') continue;
        const attrs = isObj(m['Attributes']) ? m['Attributes'] : {};
        const count = Number.parseInt(typeof attrs['ApproximateReceiveCount'] === 'string' ? attrs['ApproximateReceiveCount'] : '1', 10);
        messages.push({ messageId: m['MessageId'], receiptHandle: m['ReceiptHandle'], body: typeof m['Body'] === 'string' ? m['Body'] : '', receiveCount: Number.isNaN(count) ? 1 : count });
      }
      return messages;
    },
    async delete(receiptHandle) {
      await call('DeleteMessage', { ReceiptHandle: receiptHandle }, timeout());
    },
    async changeVisibility(receiptHandle, seconds) {
      await call('ChangeMessageVisibility', { ReceiptHandle: receiptHandle, VisibilityTimeout: Math.max(0, Math.min(43_200, Math.round(seconds))) }, timeout());
    },
  };
}
