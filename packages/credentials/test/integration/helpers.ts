import { randomBytes } from 'node:crypto';
import { AccountKind, AddressKind, type Db } from '@postroom/db';
import argon2 from 'argon2';

export const PEPPER = 'test-pepper-0123456789abcdef';
export const OPERATOR = { kind: 'system', label: 'test' } as const;

/**
 * An account with a web password hashed exactly as apps/api does it (Argon2id + the same pepper)
 * and one address at the primary domain.
 */
export async function makeAccount(
  db: Db,
  opts: { webPassword?: string; kind?: AccountKind; addressKind?: AddressKind } = {},
): Promise<{ id: string; address: string; webPassword: string }> {
  const login = `u${randomBytes(4).toString('hex')}`;
  const webPassword = opts.webPassword ?? 'correct horse battery staple';
  const domain = await db.domain.findFirstOrThrow({ where: { isPrimary: true } });
  const account = await db.account.create({
    data: {
      displayName: login,
      kind: opts.kind ?? AccountKind.person,
      passwordHash: await argon2.hash(webPassword, { type: argon2.argon2id, secret: Buffer.from(PEPPER, 'utf8') }),
    },
  });
  await db.address.create({
    data: { localPart: login, domainId: domain.id, kind: opts.addressKind ?? AddressKind.primary, accountId: account.id },
  });
  return { id: account.id, address: `${login}@${domain.name}`, webPassword };
}
