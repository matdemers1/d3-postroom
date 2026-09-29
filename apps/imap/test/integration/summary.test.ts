// PST-T-14.2: a message APPENDed over IMAP is filed with its list summary — the From display name
// (RFC 2047 decoded) and a one-line snippet of its body — and COPY carries both to the new row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapClient } from './client.js';
import { hasOpenssl, makeAccount, startHarness, type Harness } from './harness.js';

const canRun = process.env['DATABASE_URL'] !== undefined && (await hasOpenssl());

const MESSAGE = Buffer.from(
  [
    'From: =?UTF-8?B?TGluZGEgRMOpbWVycw==?= <linda.demers@example.com>',
    'To: me@d3cloud.io',
    'Subject: Photos from Sunday',
    'Date: Sun, 28 Sep 2026 12:00:00 +0000',
    'Message-ID: <photos-sunday@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Photos from Sunday are up,',
    'have a look!',
    '',
    '> quoted question',
    '',
  ].join('\r\n'),
  'utf8',
);

describe.skipIf(!canRun)('IMAP APPEND files the list summary (PST-T-14.2)', () => {
  let h: Harness;
  const open: ImapClient[] = [];

  beforeAll(async () => {
    h = await startHarness('pst_t142i');
  }, 120_000);

  afterAll(async () => {
    for (const c of open) c.close();
    await h.close();
  });

  it('APPEND stores fromName and snippet; COPY keeps them', async () => {
    const account = await makeAccount(h);
    const c = await ImapClient.tls(h.tlsPort);
    open.push(c);
    expect(await c.next()).toMatch(/^\* OK /);
    expect((await c.command(`LOGIN ${account.address} ${account.appPassword}`)).tagged).toMatch(/^A\d+ OK /);

    const appended = await c.append('INBOX', MESSAGE, '()', 'P1');
    expect(appended.tagged).toMatch(/^P1 OK \[APPENDUID \d+ 1\] APPEND completed$/);
    const inbox = await h.db.mailbox.findFirstOrThrow({ where: { accountId: account.id, name: 'INBOX' } });
    const row = await h.db.message.findFirstOrThrow({ where: { mailboxId: inbox.id, uid: 1 } });
    expect(row).toMatchObject({ fromAddress: 'linda.demers@example.com', fromName: 'Linda Démers', snippet: 'Photos from Sunday are up, have a look!' });

    expect((await c.command('SELECT INBOX', 'P2')).tagged).toMatch(/^P2 OK/);
    expect((await c.command('UID COPY 1 Archive', 'P3')).tagged).toMatch(/^P3 OK/);
    const archive = await h.db.mailbox.findFirstOrThrow({ where: { accountId: account.id, name: 'Archive' } });
    const copy = await h.db.message.findFirstOrThrow({ where: { mailboxId: archive.id } });
    expect(copy).toMatchObject({ fromName: 'Linda Démers', snippet: 'Photos from Sunday are up, have a look!' });
  });
});
