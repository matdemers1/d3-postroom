import { randomBytes } from 'node:crypto';
import { kekFromBase64 } from '@postroom/crypto';
import { AddressKind, type Db } from '@postroom/db';
import { Secret, TOTP } from 'otpauth';
import type { Response } from 'supertest';
import { hashPassword, sealTotpSecret } from '../../src/auth/index.js';
import type { ApiConfig } from '../../src/deps.js';

export const PEPPER = 'test-pepper-0123456789abcdef';
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
export const KEK_BASE64 = Buffer.alloc(32, 7).toString('base64');
export const WEB_ORIGIN = 'http://127.0.0.1:3399';

/** A clock the test moves: the app sees `base + offset`. */
export class TestClock {
  offsetMs = 0;
  readonly now = (): Date => new Date(Date.now() + this.offsetMs);
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export function baseConfig(clock: TestClock, extra: Partial<ApiConfig> = {}): ApiConfig {
  return {
    webDist: undefined,
    webOrigin: WEB_ORIGIN,
    revision: 'test',
    passwordPepper: PEPPER,
    sessionSecret: SESSION_SECRET,
    kekBase64: KEK_BASE64,
    domain: 'd3cloud.io',
    now: clock.now,
    ...extra,
  };
}

/** The code an authenticator shows at `at`. */
export function totpCode(secretBase32: string, at: Date): string {
  return new TOTP({ secret: Secret.fromBase32(secretBase32), digits: 6, period: 30, algorithm: 'SHA1' }).generate({
    timestamp: at.getTime(),
  });
}

/** name=value pairs from Set-Cookie. An empty value (a clear) removes the name. */
export function cookiesOf(res: Response, jar: Record<string, string> = {}): Record<string, string> {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  for (const line of list) {
    const first = line.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) Reflect.deleteProperty(jar, name);
    else jar[name] = value;
  }
  return jar;
}

export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** A web account made directly: password, enrolled TOTP, a primary address at the primary domain. */
export async function createAccount(
  db: Db,
  opts: { login: string; password: string; isAdmin?: boolean; displayName?: string },
): Promise<{ id: string; totpSecret: string }> {
  const kek = kekFromBase64(KEK_BASE64);
  const totpSecret = new Secret({ size: 20 }).base32;
  const domain = await db.domain.findFirstOrThrow({ where: { isPrimary: true } });
  const account = await db.account.create({
    data: {
      displayName: opts.displayName ?? opts.login,
      isAdmin: opts.isAdmin ?? false,
      passwordHash: await hashPassword(opts.password, PEPPER),
      totpEnabled: true,
    },
  });
  await db.account.update({ where: { id: account.id }, data: { totpSecret: sealTotpSecret(kek, totpSecret, account.id) } });
  await db.address.create({
    data: { localPart: opts.login, domainId: domain.id, kind: AddressKind.primary, accountId: account.id },
  });
  return { id: account.id, totpSecret };
}

export const randomLogin = (): string => `u${randomBytes(4).toString('hex')}`;
