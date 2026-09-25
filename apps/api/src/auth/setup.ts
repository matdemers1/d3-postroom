// One-time setup (PST-REQ-006, PST-REQ-171). The seed leaves an admin operator with no credential;
// setup claims it — display name, login (the operator's primary address at the primary domain),
// Argon2id password and a confirmed TOTP — in one transaction. Once any admin holds a password or a
// linked identity, setup is over for good: /setup redirects to /signin and the API answers 409.
import { randomInt } from 'node:crypto';
import { recordAudit, type RequestContext } from '@postroom/audit';
import type { Kek } from '@postroom/crypto';
import { AddressKind, DEFAULT_MAILBOXES, normalizeDomain, randomUidValidity, type Db, type Prisma } from '@postroom/db';
import { burnStep, sealTotpSecret } from './totp.js';
import { issueSession, type IssuedSession } from './sessions.js';
import type { Request } from 'express';

const SETUP_LOCK = 0x5057_0008;

export async function isSetupRequired(db: Db | Prisma.TransactionClient): Promise<boolean> {
  const operators = await db.account.count({
    where: { isAdmin: true, OR: [{ passwordHash: { not: null } }, { identityLinks: { some: {} } }] },
  });
  return operators === 0;
}

export class SetupConflict extends Error {
  constructor(readonly code: 'setup_complete' | 'login_taken') {
    super(code);
  }
}

export interface CompleteSetupInput {
  displayName: string;
  login: string;
  passwordHash: string;
  totpSecret: string;
  step: number;
  domain: string;
}

export interface CompletedSetup {
  accountId: string;
  address: string;
  session: IssuedSession;
}

export async function completeSetup(
  db: Db,
  kek: Kek,
  input: CompleteSetupInput,
  req: Request,
  context: RequestContext,
  now: Date,
): Promise<CompletedSetup> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_LOCK})`;
    if (!(await isSetupRequired(tx))) throw new SetupConflict('setup_complete');

    let domain = await tx.domain.findFirst({ where: { isPrimary: true } });
    domain ??= await tx.domain.findFirst({ orderBy: { createdAt: 'asc' } });
    domain ??= await tx.domain.create({ data: { name: normalizeDomain(input.domain), isPrimary: true } });

    // The seeded operator, if there is one; otherwise a new admin with the default mailboxes.
    let operator = await tx.account.findFirst({
      where: { isAdmin: true, passwordHash: null, identityLinks: { none: {} } },
      orderBy: { createdAt: 'asc' },
    });
    const before = operator === null ? null : { displayName: operator.displayName, isAdmin: operator.isAdmin };
    if (operator === null) {
      operator = await tx.account.create({ data: { displayName: input.displayName, isAdmin: true } });
      for (const mb of DEFAULT_MAILBOXES) {
        await tx.mailbox.create({
          data: { accountId: operator.id, name: mb.name, specialUse: mb.specialUse, uidvalidity: randomUidValidity(randomInt) },
        });
      }
    }

    const taken = await tx.address.findUnique({
      where: { localPart_domainId: { localPart: input.login, domainId: domain.id } },
    });
    if (taken !== null && taken.accountId !== operator.id) throw new SetupConflict('login_taken');
    if (taken === null) {
      await tx.address.create({
        data: { localPart: input.login, domainId: domain.id, kind: AddressKind.primary, accountId: operator.id },
      });
    }

    await tx.account.update({
      where: { id: operator.id },
      data: {
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        totpSecret: sealTotpSecret(kek, input.totpSecret, operator.id),
        totpEnabled: true,
      },
    });
    await burnStep(tx, operator.id, input.step);
    const session = await issueSession(tx, operator.id, { method: 'password', roles: [] }, req, now);
    const address = `${input.login}@${domain.name}`;
    await recordAudit(tx, {
      actor: { kind: 'account', accountId: operator.id },
      action: 'auth.setup.complete',
      entityType: 'account',
      entityId: operator.id,
      before,
      after: { displayName: input.displayName, address, isAdmin: true, secondFactor: 'enrolled', sessionId: session.id },
      context,
    });
    return { accountId: operator.id, address, session };
  });
}
