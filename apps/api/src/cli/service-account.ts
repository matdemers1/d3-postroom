// `node dist/cli/service-account.js create <local-part> <display-name> [dailyRecipientCap]`
//
// The operator's line for standing up a service mailbox (PST-T-1.12 / PST-REQ-046) — the same
// account the admin API at /api/admin/service-accounts creates, plus the one 'smtp'-scoped app
// password an ecosystem app authenticates with over submission. Idempotent up to the account:
// running it twice for the same local part fails loudly (`local part already exists`) rather than
// minting a second password silently. Needs DATABASE_URL and PASSWORD_PEPPER.
//
// Example: node dist/cli/service-account.js create alerts "Postroom alerts" 200
import { randomInt } from 'node:crypto';
import { recordAudit, type Actor } from '@postroom/audit';
import { createAppPassword } from '@postroom/credentials';
import { AccountKind, AddressKind, createDb, DEFAULT_MAILBOXES, normalizeLocalPart, randomUidValidity } from '@postroom/db';

function usage(): never {
  process.stderr.write('usage: service-account create <local-part> <display-name> [dailyRecipientCap]\n');
  process.exit(2);
}

const [command, localPartArg, displayNameArg, capArg] = process.argv.slice(2);
if (command !== 'create' || localPartArg === undefined || displayNameArg === undefined) usage();

let dailyRecipientCap: number | null = null;
if (capArg !== undefined) {
  const parsed = Number(capArg);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1_000_000) {
    process.stderr.write('dailyRecipientCap must be a positive integer (max 1000000)\n');
    process.exit(2);
  }
  dailyRecipientCap = parsed;
}

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(2);
}
const pepper = process.env['PASSWORD_PEPPER'];
if (pepper === undefined || pepper === '') {
  process.stderr.write('PASSWORD_PEPPER is required\n');
  process.exit(2);
}

const localPart = normalizeLocalPart(localPartArg);
const displayName = displayNameArg;
const actor: Actor = { kind: 'system', label: 'service-account-cli' };
const db = createDb(databaseUrl);

try {
  const { accountId, address } = await db.$transaction(async (tx) => {
    const domain = await tx.domain.findFirst({ where: { isPrimary: true } });
    if (domain === null) throw new Error('no primary domain configured yet — run /setup first');
    const taken = await tx.address.findUnique({ where: { localPart_domainId: { localPart, domainId: domain.id } } });
    if (taken !== null) throw new Error(`${localPart}@${domain.name} already exists`);

    const account = await tx.account.create({ data: { displayName, isAdmin: false, kind: AccountKind.service } });
    await tx.address.create({ data: { localPart, domainId: domain.id, kind: AddressKind.service, accountId: account.id } });
    for (const mb of DEFAULT_MAILBOXES) {
      await tx.mailbox.create({
        data: { accountId: account.id, name: mb.name, specialUse: mb.specialUse, uidvalidity: randomUidValidity(randomInt) },
      });
    }
    const address = `${localPart}@${domain.name}`;
    await recordAudit(tx, {
      actor,
      action: 'admin.service_account.create',
      entityType: 'account',
      entityId: account.id,
      before: null,
      after: { address, displayName, kind: 'service' },
    });
    return { accountId: account.id, address };
  });

  const created = await createAppPassword(
    db,
    actor,
    { accountId, label: `${localPart}-submission`, scopes: ['smtp'], dailyRecipientCap },
    { pepper },
  );

  process.stdout.write(`account          ${accountId}\n`);
  process.stdout.write(`address          ${address}\n`);
  process.stdout.write(`dailyRecipientCap ${String(dailyRecipientCap)}\n`);
  // The one place the plaintext is shown, to the operator who ran this CLI (PST-REQ-046); stdout
  // is their terminal, not a log.
  process.stdout.write(`password         ${created.password}\n`); // nosemgrep: postroom.secret-in-log
  process.stdout.write('The password above is shown once — it cannot be recovered from the database.\n');
} finally {
  await db.$disconnect();
}
