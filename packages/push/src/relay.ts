// Sending through the relay (PST-T-20.4, spec/push.md). Postroom posts a sealed envelope to
// <relay>/v1/push/<registration>, signed with the registration's send key; the relay hands it to APNs.
// A 410 means the device is gone or signed out, and the registration is forgotten. Nothing here may
// fail the request that caused a notification: a push is best effort and logged.
import { createHmac } from 'node:crypto';
import { openWithKek, type Kek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import { sealEnvelope } from './envelope.js';

/** notification.v1 — what the device opens. */
export interface Notification {
  v: 1;
  category: string;
  title: string;
  body?: string;
  thread?: string;
  link?: string;
  sentAt: string;
}

export interface Registration {
  id: string;
  devicePublicKey: Uint8Array;
  relayUrl: string;
  registration: string;
  sendKeySealed: Uint8Array;
  categories: string[];
}

export const sendKeyAad = (id: string): string => `relay-send-key:${id}`;

/** base64url(HMAC-SHA256(sendKey, "<timestamp>.<body>")), as the relay checks it. */
export function signRelayRequest(sendKey: string, timestamp: string, body: string): string {
  return createHmac('sha256', sendKey).update(`${timestamp}.${body}`).digest('base64url');
}

export type PushResult = 'sent' | 'gone' | 'failed';

export async function push(
  db: Db,
  kek: Kek,
  registration: Registration,
  notification: Notification,
  opts: { collapseId?: string; fetch?: typeof fetch; now?: () => Date } = {},
): Promise<PushResult> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  try {
    const sendKey = openWithKek(kek, registration.sendKeySealed, sendKeyAad(registration.id)).toString('utf8');
    const ciphertext = sealEnvelope(registration.devicePublicKey, Buffer.from(JSON.stringify(notification)));
    const body = JSON.stringify({ ciphertext, priority: 'high', ...(opts.collapseId === undefined ? {} : { collapseId: opts.collapseId.slice(0, 64) }) });
    const timestamp = String(Math.floor(now().getTime() / 1000));
    const url = `${registration.relayUrl.replace(/\/$/, '')}/v1/push/${encodeURIComponent(registration.registration)}`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-d3-relay-timestamp': timestamp, 'x-d3-relay-signature': signRelayRequest(sendKey, timestamp, body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 410) {
      await db.relayRegistration.deleteMany({ where: { id: registration.id } });
      return 'gone';
    }
    if (!res.ok) {
      process.stderr.write(`${JSON.stringify({ event: 'relay-push-refused', status: res.status, registration: registration.id })}\n`);
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'relay-push-failed', registration: registration.id, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 'failed';
  }
}

/** Every device of this account that asked for `category`, each sent once. */
export async function pushToAccount(
  db: Db,
  kek: Kek,
  accountId: string,
  notification: Notification,
  opts: { collapseId?: string; fetch?: typeof fetch; now?: () => Date } = {},
): Promise<PushResult[]> {
  const registrations = await db.relayRegistration.findMany({ where: { accountId, categories: { has: notification.category } } });
  return Promise.all(registrations.map((r) => push(db, kek, r, notification, opts)));
}
