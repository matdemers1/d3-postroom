// Capability tokens for the usercontent origin (PST-REQ-081). That origin has NO session cookie — a
// cookie there would be a cookie a mail's HTML sits beside — so the mail origin, which does, mints a
// short-lived token naming exactly one message of one account under one session, and whether remote
// images may be loaded. The usercontent routes verify it and re-check the session is still live, so
// signing out ends every open frame's reach too.
//
//   token = base64url("1.<messageId>.<accountId>.<sessionId>.<images 0|1>.<exp unix s>") "." base64url(HMAC-SHA256)
//
// The key is derived from SESSION_SECRET with a fixed label, so it is never the secret itself and a
// token for this purpose can never verify as anything else. Image-proxy URLs carry a second MAC over
// (token, remote URL), so the proxy fetches only addresses that the sanitizer wrote into that message.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Long enough to read a message and click "Load images"; short enough that a leaked URL is stale. */
export const TOKEN_TTL_S = 15 * 60;

export interface Capability {
  messageId: string;
  accountId: string;
  sessionId: string;
  /** The reader chose to load remote images (through the proxy) for this message. */
  images: boolean;
  /** Expiry, unix seconds. */
  exp: number;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAYLOAD = new RegExp(`^1\\.(${UUID})\\.(${UUID})\\.(${UUID})\\.([01])\\.(\\d{1,12})$`);
const B64URL = /^[A-Za-z0-9_-]+$/;

export function deriveKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update('postroom/usercontent/capability/v1').digest();
}

const mac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

export function mintToken(key: Buffer, cap: Capability): string {
  const payload = Buffer.from(`1.${cap.messageId}.${cap.accountId}.${cap.sessionId}.${cap.images ? '1' : '0'}.${String(cap.exp)}`, 'utf8').toString('base64url');
  return `${payload}.${mac(key, payload).toString('base64url')}`;
}

function macMatches(key: Buffer, data: string, given: string): boolean {
  if (!B64URL.test(given)) return false;
  const expected = mac(key, data);
  const actual = Buffer.from(given, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The capability, or null for anything forged, malformed or expired. */
export function verifyToken(key: Buffer, token: string, nowMs: number): Capability | null {
  if (token.length > 512) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
  const payload = token.slice(0, dot);
  if (!B64URL.test(payload) || !macMatches(key, payload, token.slice(dot + 1))) return null;
  const m = PAYLOAD.exec(Buffer.from(payload, 'base64url').toString('utf8'));
  if (m === null) return null;
  const [, messageId = '', accountId = '', sessionId = '', images, exp = '0'] = m;
  const cap: Capability = { messageId, accountId, sessionId, images: images === '1', exp: Number(exp) };
  return cap.exp * 1000 > nowMs ? cap : null;
}

/** The MAC an image-proxy URL carries: this token, this remote address. */
export function signImage(key: Buffer, token: string, url: string): string {
  return mac(key, `img\n${token}\n${url}`).toString('base64url');
}

export function verifyImage(key: Buffer, token: string, url: string, sig: string): boolean {
  return macMatches(key, `img\n${token}\n${url}`, sig);
}
