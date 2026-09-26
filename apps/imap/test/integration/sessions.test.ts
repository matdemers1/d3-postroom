// PST-T-3.2 doneWhen, over real loopback sockets with real TLS: an IMAP4rev1 client script and an
// IMAP4rev2 client script (PST-REQ-070), app-password-only login (PST-REQ-027), PROXY v2 from the
// edge only (PST-REQ-016), and the audit trail of mailbox and expunge mutations (PST-REQ-009).
import { connect as netConnect } from 'node:net';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { FAILURE_ACTION } from '@postroom/auth-throttle';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORWARD, MULTIPART, MULTIPART_BODYSTRUCTURE, MULTIPART_ENVELOPE, PDF_BYTES, PLAIN, PLAIN_BODYSTRUCTURE } from '../fixtures.js';
import { ImapClient } from './client.js';
import { extraAppPassword, hasOpenssl, makeAccount, revoke, seedMessage, startHarness, WEB_PASSWORD, type Account, type Harness } from './harness.js';

const baseUrl = process.env['DATABASE_URL'];
const canRun = baseUrl !== undefined && (await hasOpenssl());

const PRE_TLS_CAPS = 'IMAP4rev1 IMAP4rev2 LITERAL- SASL-IR ID ENABLE STARTTLS LOGINDISABLED';
const TLS_CAPS = 'IMAP4rev1 IMAP4rev2 LITERAL- SASL-IR ID ENABLE AUTH=PLAIN';
const AUTH_CAPS =
  'IMAP4rev1 IMAP4rev2 LITERAL- SASL-IR ID ENABLE NAMESPACE UNSELECT UIDPLUS MOVE CHILDREN LIST-EXTENDED LIST-STATUS SPECIAL-USE ESEARCH SEARCHRES BINARY STATUS=SIZE UTF8=ACCEPT';
const SYSTEM = '\\Answered \\Flagged \\Deleted \\Seen \\Draft';

describe.skipIf(!canRun)('imap daemon (PST-T-3.2)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('pst_t32');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  async function seeded(): Promise<{ account: Account; uidvalidity: (name: string) => Promise<number> }> {
    const account = await makeAccount(h);
    await seedMessage(h, account.id, 'INBOX', MULTIPART);
    await seedMessage(h, account.id, 'INBOX', PLAIN);
    await seedMessage(h, account.id, 'INBOX', FORWARD);
    const uidvalidity = async (name: string): Promise<number> =>
      (await h.db.mailbox.findFirstOrThrow({ where: { accountId: account.id, name } })).uidvalidity;
    return { account, uidvalidity };
  }

  /** Greeting, STARTTLS; returns a TLS client that has not logged in. */
  async function overStartTls(): Promise<ImapClient> {
    const c = await ImapClient.plain(h.port);
    expect(await c.next()).toBe(`* OK [CAPABILITY ${PRE_TLS_CAPS}] Postroom IMAP ready`);
    const r = await c.startTls();
    expect(r.tagged).toMatch(/^A\d+ OK Begin TLS negotiation now$/);
    return c;
  }

  it('runs the IMAP4rev1 client script', async () => {
    const { account, uidvalidity } = await seeded();
    const inboxV = await uidvalidity('INBOX');
    const archiveV = await uidvalidity('Archive');
    const c = await ImapClient.plain(h.port);
    expect(await c.next()).toBe(`* OK [CAPABILITY ${PRE_TLS_CAPS}] Postroom IMAP ready`);

    // Before TLS, LOGIN is refused whatever the password.
    expect((await c.command(`LOGIN ${account.address} ${account.appPassword}`, 'L0')).tagged).toBe(
      'L0 NO [PRIVACYREQUIRED] LOGIN is disabled until TLS is active (STARTTLS)',
    );
    expect((await c.startTls()).tagged).toMatch(/OK Begin TLS/);
    expect(await c.command('CAPABILITY', 'C1')).toEqual({ untagged: [`* CAPABILITY ${TLS_CAPS}`], tagged: 'C1 OK CAPABILITY completed' });

    expect(await c.command(`LOGIN ${account.address} "${account.appPassword}"`, 'L1')).toEqual({
      untagged: [],
      tagged: `L1 OK [CAPABILITY ${AUTH_CAPS}] Logged in`,
    });

    expect(await c.command('LIST "" "*"', 'S1')).toEqual({
      untagged: [
        '* LIST (\\HasNoChildren) "/" "INBOX"',
        '* LIST (\\HasNoChildren \\Archive) "/" "Archive"',
        '* LIST (\\HasNoChildren \\Drafts) "/" "Drafts"',
        '* LIST (\\HasNoChildren \\Junk) "/" "Junk"',
        '* LIST (\\HasNoChildren) "/" "Rejects"',
        '* LIST (\\HasNoChildren \\Sent) "/" "Sent"',
        '* LIST (\\HasNoChildren \\Trash) "/" "Trash"',
      ],
      tagged: 'S1 OK LIST completed',
    });

    expect(await c.command('SELECT INBOX', 'S2')).toEqual({
      untagged: [
        `* FLAGS (${SYSTEM})`,
        '* 3 EXISTS',
        '* 0 RECENT',
        '* OK [UNSEEN 1] Message 1 is first unseen',
        `* OK [UIDVALIDITY ${inboxV}] UIDs valid`,
        '* OK [UIDNEXT 4] Predicted next UID',
        `* OK [PERMANENTFLAGS (${SYSTEM} \\*)] Flags permitted`,
        '* OK [HIGHESTMODSEQ 3] Highest',
      ],
      tagged: 'S2 OK [READ-WRITE] SELECT completed',
    });

    const fetched = await c.command('FETCH 1:* (FLAGS ENVELOPE BODYSTRUCTURE RFC822.SIZE)', 'S3');
    expect(fetched.tagged).toBe('S3 OK FETCH completed');
    expect(fetched.untagged).toHaveLength(3);
    expect(fetched.untagged[0]).toBe(`* 1 FETCH (FLAGS () ${MULTIPART_ENVELOPE} ${MULTIPART_BODYSTRUCTURE} RFC822.SIZE ${MULTIPART.length})`);
    expect(fetched.untagged[1]).toBe(
      '* 2 FETCH (FLAGS () ENVELOPE ("Wed, 23 Sep 2026 12:30:00 +0000" "Lunch?" (("Bob" NIL "bob" "example.net")) (("Bob" NIL "bob" "example.net")) (("Bob" NIL "bob" "example.net")) ((NIL NIL "alice" "d3cloud.io")) NIL NIL NIL "<lunch@example.net>") ' +
        `${PLAIN_BODYSTRUCTURE} RFC822.SIZE ${PLAIN.length})`,
    );

    const peek = await c.command('UID FETCH 1:2 BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)]', 'S4');
    const h1 = 'From: =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <juergen@example.com>\r\nSubject: =?UTF-8?B?w5xiZXIgZGVuIFdvbGtlbg==?= report\r\n\r\n';
    const h2 = 'From: Bob <bob@example.net>\r\nSubject: Lunch?\r\n\r\n';
    expect(peek).toEqual({
      untagged: [
        `* 1 FETCH (UID 1 BODY[HEADER.FIELDS (SUBJECT FROM)] {${Buffer.byteLength(h1)}}\r\n${h1})`,
        `* 2 FETCH (UID 2 BODY[HEADER.FIELDS (SUBJECT FROM)] {${Buffer.byteLength(h2)}}\r\n${h2})`,
      ],
      tagged: 'S4 OK FETCH completed',
    });

    expect(await c.command('STORE 1 +FLAGS (\\Seen)', 'S5')).toEqual({ untagged: ['* 1 FETCH (FLAGS (\\Seen))'], tagged: 'S5 OK STORE completed' });
    expect(await c.command('SEARCH UNSEEN', 'S6')).toEqual({ untagged: ['* SEARCH 2 3'], tagged: 'S6 OK SEARCH completed' });
    expect(await c.command('COPY 1 Archive', 'S7')).toEqual({ untagged: [], tagged: `S7 OK [COPYUID ${archiveV} 1 1] COPY completed` });
    expect(await c.command('UID MOVE 2 Archive', 'S8')).toEqual({
      untagged: [`* OK [COPYUID ${archiveV} 2 2] Moved`, '* 2 EXPUNGE'],
      tagged: 'S8 OK MOVE completed',
    });
    expect(await c.command('STORE 1 +FLAGS.SILENT (\\Deleted)', 'S9')).toEqual({ untagged: [], tagged: 'S9 OK STORE completed' });
    expect(await c.command('EXPUNGE', 'SA')).toEqual({ untagged: ['* 1 EXPUNGE'], tagged: 'SA OK EXPUNGE completed' });
    expect(await c.command('LOGOUT', 'SB')).toEqual({ untagged: ['* BYE Logging out'], tagged: 'SB OK LOGOUT completed' });
    c.close();

    // What the database holds afterwards: UIDs only ever grew, and the expunge was audited.
    const inbox = await h.db.mailbox.findFirstOrThrow({ where: { accountId: account.id, name: 'INBOX' }, include: { messages: true } });
    expect(inbox.messages.map((m) => m.uid)).toEqual([3]);
    expect(inbox.uidnext).toBe(4);
    const archive = await h.db.mailbox.findFirstOrThrow({ where: { accountId: account.id, name: 'Archive' }, include: { messages: { orderBy: { uid: 'asc' } } } });
    expect(archive.messages.map((m) => [m.uid, m.flags])).toEqual([
      [1, ['\\Seen']],
      [2, []],
    ]);
    const audit = await h.db.auditEvent.findMany({ where: { actorAccountId: account.id, action: 'message.expunge' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toMatchObject({ uids: [1], count: 1, via: 'EXPUNGE' });
  });

  it('runs the IMAP4rev2 client script', async () => {
    const { account, uidvalidity } = await seeded();
    const inboxV = await uidvalidity('INBOX');
    const c = await overStartTls();
    const plain = Buffer.from(`\0${account.address}\0${account.appPassword}`).toString('base64');
    expect((await c.command(`AUTHENTICATE PLAIN ${plain}`, 'R1')).tagged).toBe(`R1 OK [CAPABILITY ${AUTH_CAPS}] Logged in`);
    expect(await c.command('ENABLE IMAP4rev2', 'R2')).toEqual({ untagged: ['* ENABLED IMAP4rev2'], tagged: 'R2 OK ENABLE completed' });

    // rev2 SELECT: no RECENT, no UNSEEN.
    expect(await c.command('SELECT INBOX', 'R3')).toEqual({
      untagged: [
        `* FLAGS (${SYSTEM})`,
        '* 3 EXISTS',
        `* OK [UIDVALIDITY ${inboxV}] UIDs valid`,
        '* OK [UIDNEXT 4] Predicted next UID',
        `* OK [PERMANENTFLAGS (${SYSTEM} \\*)] Flags permitted`,
        '* OK [HIGHESTMODSEQ 3] Highest',
      ],
      tagged: 'R3 OK [READ-WRITE] SELECT completed',
    });

    // rev2 SEARCH answers with ESEARCH.
    expect(await c.command('SEARCH UNSEEN', 'R4')).toEqual({ untagged: ['* ESEARCH (TAG "R4") ALL 1:3'], tagged: 'R4 OK SEARCH completed' });
    expect(await c.command('UID SEARCH RETURN (MIN MAX COUNT) SUBJECT "report"', 'R5')).toEqual({
      untagged: ['* ESEARCH (TAG "R5") UID MIN 1 MAX 1 COUNT 1'],
      tagged: 'R5 OK SEARCH completed',
    });
    expect(await c.command('SEARCH FROM "Jürgen"', 'R6')).toEqual({ untagged: ['* ESEARCH (TAG "R6") ALL 1'], tagged: 'R6 OK SEARCH completed' });
    expect(await c.command('SEARCH OR BODY "usual place" BODY "Hallo Welt —" NOT LARGER 100000', 'R7')).toEqual({
      untagged: ['* ESEARCH (TAG "R7") ALL 1:2'],
      tagged: 'R7 OK SEARCH completed',
    });

    // BINARY: the decoded attachment, and the decoded quoted-printable text (which sets \Seen).
    const pdf = PDF_BYTES.toString('latin1');
    expect(await c.command('FETCH 1 (BINARY.PEEK[2] BINARY.SIZE[2])', 'R8')).toEqual({
      untagged: [`* 1 FETCH (BINARY[2] ~{${PDF_BYTES.length}}\r\n${pdf} BINARY.SIZE[2] ${PDF_BYTES.length})`],
      tagged: 'R8 OK FETCH completed',
    });
    const text = 'Hallo Welt — plain';
    expect(await c.command('FETCH 1 BINARY[1.1]', 'R9')).toEqual({
      untagged: [`* 1 FETCH (BINARY[1.1] ~{${Buffer.byteLength(text)}}\r\n${text} FLAGS (\\Seen))`],
      tagged: 'R9 OK FETCH completed',
    });
    // Nested part and a partial fetch.
    expect(await c.command('FETCH 1 (BODY.PEEK[1.2] BODY.PEEK[]<0.10>)', 'RA')).toEqual({
      untagged: ['* 1 FETCH (BODY[1.2] {24}\r\n<p>Hallo <b>Welt</b></p> BODY[]<0> {10}\r\nFrom: =?UT)'],
      tagged: 'RA OK FETCH completed',
    });
    expect(await c.command('UID FETCH 3 (BODY.PEEK[2.HEADER.FIELDS (SUBJECT)] BODY.PEEK[2.TEXT])', 'RB')).toEqual({
      untagged: ['* 3 FETCH (UID 3 BODY[2.HEADER.FIELDS (SUBJECT)] {20}\r\nSubject: minutes\r\n\r\n BODY[2.TEXT] {9}\r\nItem one.)'],
      tagged: 'RB OK FETCH completed',
    });

    expect(await c.command('STORE 2 +FLAGS.SILENT (\\Deleted)', 'RC')).toEqual({ untagged: [], tagged: 'RC OK STORE completed' });
    expect(await c.command('UID EXPUNGE 1:3', 'RD')).toEqual({ untagged: ['* 2 EXPUNGE'], tagged: 'RD OK UID EXPUNGE completed' });

    // UTF-8 mailbox names travel as UTF-8 under rev2 …
    expect((await c.command('CREATE "Entwürfe/Ärger"', 'RE')).tagged).toBe('RE OK CREATE completed');
    expect(await c.command('LIST "" "Entw*"', 'RF')).toEqual({
      untagged: ['* LIST (\\HasChildren) "/" "Entwürfe"', '* LIST (\\HasNoChildren) "/" "Entwürfe/Ärger"'],
      tagged: 'RF OK LIST completed',
    });
    expect(await c.command('STATUS INBOX (MESSAGES UIDNEXT UNSEEN DELETED SIZE)', 'RG')).toEqual({
      untagged: [`* STATUS "INBOX" (MESSAGES 2 UIDNEXT 4 UNSEEN 1 DELETED 0 SIZE ${MULTIPART.length + FORWARD.length})`],
      tagged: 'RG OK STATUS completed',
    });
    // … and APPEND answers APPENDUID; the selected session hears EXISTS.
    const appended = await c.append('INBOX', PLAIN, '(\\Flagged $Later)', 'RH');
    expect(appended).toEqual({ untagged: ['* 3 EXISTS'], tagged: `RH OK [APPENDUID ${inboxV} 4] APPEND completed` });
    expect(await c.command('UID FETCH 4 (FLAGS RFC822.SIZE)', 'RI')).toEqual({
      untagged: [`* 3 FETCH (UID 4 FLAGS (\\Flagged $Later) RFC822.SIZE ${PLAIN.length})`],
      tagged: 'RI OK FETCH completed',
    });
    expect((await c.command('LOGOUT', 'RJ')).tagged).toBe('RJ OK LOGOUT completed');
    c.close();

    // … while a rev1 session sees the same names in modified UTF-7.
    const r1 = await overStartTls();
    await r1.command(`LOGIN ${account.address} ${account.appPassword}`);
    expect((await r1.command('LIST "" "Entw*"', 'M1')).untagged).toEqual([
      '* LIST (\\HasChildren) "/" "Entw&APw-rfe"',
      '* LIST (\\HasNoChildren) "/" "Entw&APw-rfe/&AMQ-rger"',
    ]);
    r1.close();

    const audit = await h.db.auditEvent.findMany({ where: { actorAccountId: account.id }, orderBy: { at: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['message.expunge', 'mailbox.create', 'mailbox.create']);
  });

  it('accepts app passwords scoped to imap only — never the account password', async () => {
    const account = await makeAccount(h);
    const smtpOnly = await extraAppPassword(h, account, ['smtp']);
    const revoked = await extraAppPassword(h, account, ['imap']);
    await revoke(h, revoked.id);
    const c = await overStartTls();
    const failed = 'NO [AUTHENTICATIONFAILED] Authentication failed';
    expect((await c.command(`LOGIN ${account.address} "${WEB_PASSWORD}"`, 'P1')).tagged).toBe(`P1 ${failed}`);
    expect((await c.command(`LOGIN ${account.address} ${revoked.password}`, 'P2')).tagged).toBe(`P2 ${failed}`);
    expect((await c.command(`LOGIN ${account.address} ${smtpOnly.password}`, 'P3')).tagged).toBe(`P3 ${failed}`);
    const webPlain = Buffer.from(`\0${account.address}\0${WEB_PASSWORD}`).toString('base64');
    expect((await c.command(`AUTHENTICATE PLAIN ${webPlain}`, 'P4')).tagged).toBe(`P4 ${failed}`);
    // Not logged in, so mailbox commands are refused.
    expect((await c.command('SELECT INBOX', 'P5')).tagged).toBe('P5 BAD Authenticate first');
    // AUTHENTICATE without SASL-IR: an empty challenge, then the response.
    c.write('P6 AUTHENTICATE PLAIN\r\n');
    expect(await c.next()).toBe('+ ');
    c.write(`${Buffer.from(`\0${account.address}\0${account.appPassword}`).toString('base64')}\r\n`);
    expect((await c.collect('P6')).tagged).toBe(`P6 OK [CAPABILITY ${AUTH_CAPS}] Logged in`);
    c.close();
    // Every failure is an audit row (the shared throttle, PST-REQ-075); no secret is in it.
    const rows = await h.db.auditEvent.findMany({ where: { action: FAILURE_ACTION, entityId: account.address.toLowerCase() } });
    expect(rows.map((r) => (r.after as { reason: string; protocol: string }).reason).sort()).toEqual(['bad_password', 'bad_password', 'revoked', 'wrong_scope']);
    expect(rows.every((r) => (r.after as { protocol: string }).protocol === 'imap')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(WEB_PASSWORD);
  });

  it('refuses AUTHENTICATE before TLS, and serves 993 with implicit TLS', async () => {
    const account = await makeAccount(h);
    const c = await ImapClient.plain(h.port);
    await c.next();
    const plain = Buffer.from(`\0${account.address}\0${account.appPassword}`).toString('base64');
    expect((await c.command(`AUTHENTICATE PLAIN ${plain}`, 'T1')).tagged).toBe('T1 NO [PRIVACYREQUIRED] Authentication is disabled until TLS is active (STARTTLS)');
    c.close();
    const s = await ImapClient.tls(h.tlsPort);
    expect(await s.next()).toBe(`* OK [CAPABILITY ${TLS_CAPS}] Postroom IMAP ready`);
    expect((await s.command(`LOGIN ${account.address} ${account.appPassword}`, 'T2')).tagged).toBe(`T2 OK [CAPABILITY ${AUTH_CAPS}] Logged in`);
    s.close();
  });

  it('takes PROXY v2 only from the edge peer, and requires it there (PST-REQ-016)', async () => {
    // Loopback as the edge: the header is required and names the real client.
    const edge = await h.listenersWith({ edgePeers: ['127.0.0.1'], proxyTimeoutMs: 300 });
    const header = encodeProxyV2({
      command: 'PROXY',
      family: 'TCP4',
      source: { address: '203.0.113.9', port: 40000 },
      destination: { address: '10.77.0.2', port: 143 },
    });
    const viaEdge = await ImapClient.plain(edge.port);
    viaEdge.write(header);
    expect(await viaEdge.next()).toBe(`* OK [CAPABILITY ${PRE_TLS_CAPS}] Postroom IMAP ready`);
    viaEdge.close();
    const bare = await ImapClient.plain(edge.port);
    expect(await bare.next(3_000)).toBeNull(); // no header within the timeout: closed, no greeting
    // Anyone else sending a PROXY header is cut off.
    const stray = await new Promise<string>((resolve) => {
      const s = netConnect(h.port, '127.0.0.1', () => {
        s.write(header);
      });
      let got = '';
      s.on('data', (d: Buffer) => {
        got += d.toString('latin1');
      });
      s.on('close', () => {
        resolve(got);
      });
    });
    expect(stray).toMatch(/^\* OK \[CAPABILITY/); // the greeting goes out first; then the connection is closed
    expect(h.logs.some((l) => l.event === 'proxy-refused' && String(l.fields['reason']).includes('not the edge'))).toBe(true);
    await edge.listeners.close();
  });

  it('audits mailbox create, rename and delete, and refuses to delete INBOX or a special-use mailbox', async () => {
    const account = await makeAccount(h);
    await seedMessage(h, account.id, 'INBOX', PLAIN);
    const c = await overStartTls();
    await c.command(`LOGIN ${account.address} ${account.appPassword}`);
    expect((await c.command('CREATE Projects/2026/', 'D1')).tagged).toBe('D1 OK CREATE completed');
    expect((await c.command('CREATE projects', 'D2')).tagged).toBe('D2 OK CREATE completed');
    expect((await c.command('CREATE Projects', 'D3')).tagged).toBe('D3 NO [ALREADYEXISTS] Mailbox already exists');
    expect((await c.command('RENAME Projects Work', 'D4')).tagged).toBe('D4 OK RENAME completed');
    expect((await c.command('LIST "" "Work*"', 'D5')).untagged).toEqual(['* LIST (\\HasChildren) "/" "Work"', '* LIST (\\HasNoChildren) "/" "Work/2026"']);
    expect((await c.command('DELETE Work', 'D6')).tagged).toBe('D6 NO [HASCHILDREN] Delete its child mailboxes first');
    expect((await c.command('DELETE Work/2026', 'D7')).tagged).toBe('D7 OK DELETE completed');
    expect((await c.command('DELETE INBOX', 'D8')).tagged).toBe('D8 NO [CANNOT] INBOX cannot be deleted');
    expect((await c.command('DELETE Trash', 'D9')).tagged).toBe('D9 NO [CANNOT] A special-use mailbox cannot be deleted');
    expect((await c.command('DELETE Nope', 'DA')).tagged).toBe('DA NO [NONEXISTENT] No such mailbox');
    expect((await c.command('APPEND Nope {3}', 'DB')).tagged).toBe('DB NO [TRYCREATE] No such mailbox');
    // RENAME INBOX moves its messages to a new mailbox and leaves INBOX, empty.
    expect((await c.command('RENAME INBOX Saved', 'DC')).tagged).toBe('DC OK RENAME completed');
    expect((await c.command('STATUS INBOX (MESSAGES)', 'DD')).untagged).toEqual(['* STATUS "INBOX" (MESSAGES 0)']);
    expect((await c.command('STATUS Saved (MESSAGES)', 'DE')).untagged).toEqual(['* STATUS "Saved" (MESSAGES 1)']);
    c.close();
    const actions = (await h.db.auditEvent.findMany({ where: { actorAccountId: account.id }, orderBy: { at: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['mailbox.create', 'mailbox.create', 'mailbox.create', 'mailbox.rename', 'mailbox.delete', 'mailbox.rename']);
  });

  it('delivers another session’s changes at the allowed points', async () => {
    const account = await makeAccount(h);
    await seedMessage(h, account.id, 'INBOX', PLAIN);
    await seedMessage(h, account.id, 'INBOX', PLAIN);
    const a = await overStartTls();
    const b = await overStartTls();
    for (const c of [a, b]) {
      await c.command(`LOGIN ${account.address} ${account.appPassword}`);
      await c.command('SELECT INBOX');
    }
    await b.command('STORE 1 +FLAGS.SILENT (\\Deleted \\Flagged)');
    await b.command('EXPUNGE');
    await b.append('INBOX', PLAIN);
    // A FETCH may not carry the EXPUNGE (RFC 9051 §7.5.1): message 1 stays numbered (and is skipped),
    // the arrival is announced after the data; NOOP then delivers the EXPUNGE.
    const f = await a.command('FETCH 1:* (UID)', 'X1');
    expect(f.untagged).toEqual(['* 2 FETCH (UID 2)', '* 3 EXISTS']);
    expect(f.tagged).toBe('X1 OK [EXPUNGEISSUED] Some messages were expunged by another session');
    expect(await a.command('NOOP', 'X2')).toEqual({ untagged: ['* 1 EXPUNGE'], tagged: 'X2 OK NOOP completed' });
    expect((await a.command('FETCH 1:* (UID)', 'X3')).untagged).toEqual(['* 1 FETCH (UID 2)', '* 2 FETCH (UID 3)']);
    await b.command('UID STORE 2 +FLAGS (\\Answered)');
    expect(await a.command('NOOP', 'X4')).toEqual({ untagged: ['* 1 FETCH (UID 2 FLAGS (\\Answered))'], tagged: 'X4 OK NOOP completed' });
    a.close();
    b.close();
  });
  it('drains a refused LITERAL- APPEND, caps connections per IP, and autologs out an idle client', async () => {
    const account = await makeAccount(h);
    const c = await overStartTls();
    await c.command(`LOGIN ${account.address} ${account.appPassword}`);
    // A non-synchronizing literal is already on its way: it is read past, then refused.
    c.write('N1 APPEND Nope {5+}\r\nhello\r\n');
    expect((await c.collect('N1')).tagged).toBe('N1 NO [TRYCREATE] No such mailbox');
    c.write(`N2 APPEND INBOX {${PLAIN.length}+}\r\n`);
    c.write(Buffer.concat([PLAIN, Buffer.from('\r\n')]));
    expect((await c.collect('N2')).tagged).toMatch(/^N2 OK \[APPENDUID \d+ 1\] APPEND completed$/);
    expect((await c.command('NOOP', 'N3')).tagged).toBe('N3 OK NOOP completed');
    c.close();

    const capped = await h.listenersWith({ maxConnectionsPerIp: 1, preauthTimeoutMs: 300 });
    const first = await ImapClient.plain(capped.port);
    expect(await first.next()).toMatch(/^\* OK \[CAPABILITY/);
    const second = await ImapClient.plain(capped.port);
    expect(await second.next()).toBe('* BYE Too many connections from your address');
    // The first, silent before login, is logged out after the pre-auth timeout.
    expect(await first.next(3_000)).toBe('* BYE Autologout; idle for too long');
    expect(await first.next(3_000)).toBeNull();
    await capped.listeners.close();
  });
});
