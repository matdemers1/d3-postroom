// PST-T-5.1 doneWhen, IMAP half: the bucket folders (PST-REQ-101) are real, subscribed IMAP folders
// — LIST "" "*" and LSUB show Newsletters, Updates, Receipts and Notifications for a new account,
// and for an account created before they existed once the migration's backfill has run. (Whether
// iPhone Mail lists them is a manual device check.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapClient } from './client.js';
import { hasOpenssl, makeAccount, startHarness, type Account, type Harness } from './harness.js';

const canRun = process.env['DATABASE_URL'] !== undefined && (await hasOpenssl());

const BUCKETS = ['Newsletters', 'Notifications', 'Receipts', 'Updates'];

/** The backfill section of the migration, exactly as `prisma migrate deploy` runs it. */
function backfillSql(): string {
  const path = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/20260926050500_bucket_folders/migration.sql', import.meta.url));
  const sql = readFileSync(path, 'utf8');
  const at = sql.indexOf('-- Backfill');
  if (at < 0) throw new Error('backfill section not found in the migration');
  return sql.slice(at);
}

describe.skipIf(!canRun)('bucket folders over IMAP (PST-T-5.1, PST-REQ-101)', () => {
  let h: Harness;
  const open: ImapClient[] = [];

  beforeAll(async () => {
    h = await startHarness('pst_t51i');
  }, 120_000);

  afterAll(async () => {
    for (const c of open) c.close();
    await h.close();
  });

  async function login(account: Account): Promise<ImapClient> {
    const c = await ImapClient.tls(h.tlsPort);
    open.push(c);
    expect(await c.next()).toMatch(/^\* OK /);
    expect((await c.command(`LOGIN ${account.address} ${account.appPassword}`)).tagged).toMatch(/^A\d+ OK /);
    return c;
  }

  async function expectBucketsListed(c: ImapClient): Promise<void> {
    const list = await c.command('LIST "" "*"');
    expect(list.tagged).toMatch(/OK LIST completed/);
    for (const name of BUCKETS) expect(list.untagged).toContain(`* LIST (\\HasNoChildren) "/" "${name}"`);
    // Subscribed: a client that shows only subscribed folders (iPhone Mail, via LSUB or LIST
    // (SUBSCRIBED)) lists them too.
    const lsub = await c.command('LSUB "" "*"');
    for (const name of BUCKETS) expect(lsub.untagged.some((l) => l.startsWith('* LSUB') && l.endsWith(`"${name}"`))).toBe(true);
    const subscribed = await c.command('LIST (SUBSCRIBED) "" "*"');
    for (const name of BUCKETS) expect(subscribed.untagged.some((l) => l.includes('\\Subscribed') && l.endsWith(`"${name}"`))).toBe(true);
  }

  it('a new account lists the four bucket folders, subscribed, with no special use', async () => {
    const account = await makeAccount(h);
    await expectBucketsListed(await login(account));
    const rows = await h.db.mailbox.findMany({ where: { accountId: account.id, name: { in: BUCKETS } }, orderBy: { name: 'asc' } });
    expect(rows.map((r) => [r.name, r.specialUse, r.subscribed])).toEqual(BUCKETS.map((n) => [n, null, true]));
  });

  it('an account from before the buckets gets them from the backfill, idempotently and audited', async () => {
    const account = await makeAccount(h);
    // As it was before PST-T-5.1: the seven default mailboxes, no buckets.
    await h.db.mailbox.deleteMany({ where: { accountId: account.id, name: { in: BUCKETS } } });
    const before = await login(account);
    const list = await before.command('LIST "" "*"');
    for (const name of BUCKETS) expect(list.untagged.some((l) => l.endsWith(`"${name}"`))).toBe(false);

    await h.db.$executeRawUnsafe(backfillSql());
    await h.db.$executeRawUnsafe(backfillSql());

    await expectBucketsListed(await login(account));
    const rows = await h.db.mailbox.findMany({ where: { accountId: account.id, name: { in: BUCKETS } } });
    expect(rows).toHaveLength(4);
    const audit = await h.db.auditEvent.findMany({ where: { action: 'mailbox.bucket_backfill', entityId: account.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorKind).toBe('system');
  });
});
