// PST-T-9.5 against a real database and real sockets: ManageSieve (RFC 5804, PST-REQ-149).
//
// doneWhen is "Thunderbird edits a script; builder round-trips". Thunderbird's Sieve add-on is a
// manual check; its protocol sequence is replayed here byte for byte in the order the add-on sends
// it — capabilities on connect, STARTTLS and the re-issued capabilities, AUTHENTICATE PLAIN with an
// initial response, LISTSCRIPTS, CHECKSCRIPT while typing (an error comes back with its line),
// HAVESPACE and PUTSCRIPT with a {n+} literal, SETACTIVE, GETSCRIPT, an edit, and LOGOUT.
import { execFile } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { promisify } from 'node:util';
import { createAuthThrottle, FAILURE_ACTION, memoryLedger } from '@postroom/auth-throttle';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { literal, makeAccount, plain, SieveClient, startHarness, WEB_PASSWORD, type Harness } from './harness.js';

const baseUrl = process.env['DATABASE_URL'];
const canRun =
  baseUrl !== undefined &&
  (await promisify(execFile)('openssl', ['version']).then(
    () => true,
    () => false,
  ));

const SCRIPT_V1 = [
  'require ["fileinto", "imap4flags"];',
  '# Written in Thunderbird',
  'if header :contains "subject" "invoice" {',
  '  fileinto "Receipts";',
  '  addflag "$Paid";',
  '}',
  '',
].join('\r\n');

const SCRIPT_V2 = SCRIPT_V1.replace('"invoice"', '["invoice", "receipt"]');

/** Line 3 is missing its ";" — the error is reported where the next token starts. */
const BROKEN = ['require "fileinto";', '', 'fileinto "Receipts"', 'keep;', ''].join('\r\n');

async function signedIn(h: Harness, user: string, password: string): Promise<SieveClient> {
  const c = await SieveClient.connect(h.port);
  await c.reply();
  await c.startTls();
  const r = await c.send(`AUTHENTICATE "PLAIN" "${plain(user, password)}"`);
  expect(r.status).toBe('OK "Authenticated"');
  return c;
}

describe.skipIf(!canRun)('ManageSieve (PST-T-9.5, PST-REQ-149)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('pst_t95_ms');
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('replays the Thunderbird Sieve add-on editing a script', async () => {
    const me = await makeAccount(h);
    const c = await SieveClient.connect(h.port);

    // 1. Capabilities on connect: STARTTLS offered, SASL empty until TLS.
    const greeting = await c.reply();
    expect(greeting.status).toBe('OK "Postroom ManageSieve ready"');
    expect(greeting.lines).toContain('"IMPLEMENTATION" "Postroom ManageSieve"');
    expect(greeting.lines).toContain('"STARTTLS"');
    expect(greeting.lines).toContain('"SASL" ""');
    expect(greeting.lines).toContain('"VERSION" "1.0"');
    const sieve = greeting.lines.find((l) => l.startsWith('"SIEVE"')) ?? '';
    for (const ext of ['fileinto', 'envelope', 'imap4flags', 'variables', 'body', 'vacation', 'vnd.postroom.bucket']) expect(sieve).toContain(ext);

    // 2. No password before TLS.
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(me.address, me.appPassword)}"`)).status).toBe('NO (ENCRYPT-NEEDED) "Authentication needs TLS: use STARTTLS first"');

    // 3. STARTTLS: the capabilities are re-issued, now with SASL PLAIN and without STARTTLS.
    const afterTls = await c.startTls();
    expect(afterTls.status).toBe('OK "TLS negotiation successful"');
    expect(afterTls.lines).toContain('"SASL" "PLAIN"');
    expect(afterTls.lines).not.toContain('"STARTTLS"');

    // 4. AUTHENTICATE PLAIN with the initial response, as the add-on sends it.
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(me.address, me.appPassword)}"`)).status).toBe('OK "Authenticated"');
    expect((await c.send('CAPABILITY')).status).toBe('OK "Capability completed"');

    // 5. An empty account.
    expect(await c.send('LISTSCRIPTS')).toEqual({ lines: [], status: 'OK "Listscripts completed"' });

    // 6. The editor checks as the user types: a broken script names its line.
    const check = await c.send(`CHECKSCRIPT ${literal(BROKEN)}`);
    expect(check.status).toMatch(/^NO "line 4, column 1: /);
    expect((await c.send(`CHECKSCRIPT ${literal(SCRIPT_V1)}`)).status).toBe('OK "Script is valid"');

    // 7. Save: HAVESPACE, then PUTSCRIPT with a non-synchronising literal.
    expect((await c.send(`HAVESPACE "thunderbird" ${Buffer.byteLength(SCRIPT_V1)}`)).status).toBe('OK "Putscript would succeed"');
    expect((await c.send(`PUTSCRIPT "thunderbird" ${literal(BROKEN)}`)).status).toMatch(/^NO "line 4, column 1: /);
    expect((await c.send(`PUTSCRIPT "thunderbird" ${literal(SCRIPT_V1)}`)).status).toBe('OK "Putscript completed"');
    expect(await c.send('LISTSCRIPTS')).toEqual({ lines: ['"thunderbird"'], status: 'OK "Listscripts completed"' });

    // 8. Activate, read back byte for byte.
    expect((await c.send('SETACTIVE "thunderbird"')).status).toBe('OK "Setactive completed"');
    expect(await c.send('LISTSCRIPTS')).toEqual({ lines: ['"thunderbird" ACTIVE'], status: 'OK "Listscripts completed"' });
    const got = await c.send('GETSCRIPT "thunderbird"');
    expect(got.status).toBe('OK "Getscript completed"');
    expect(got.lines[0]).toBe(`{${Buffer.byteLength(SCRIPT_V1)}}\r\n${SCRIPT_V1}`);

    // 9. Edit and save again: still the active one.
    expect((await c.send(`PUTSCRIPT "thunderbird" ${literal(SCRIPT_V2)}`)).status).toBe('OK "Putscript completed"');
    expect(await c.send('LISTSCRIPTS')).toEqual({ lines: ['"thunderbird" ACTIVE'], status: 'OK "Listscripts completed"' });
    expect((await c.send('GETSCRIPT "thunderbird"')).lines[0]).toBe(`{${Buffer.byteLength(SCRIPT_V2)}}\r\n${SCRIPT_V2}`);

    // 10. Keep-alive and goodbye.
    expect((await c.send('NOOP "tb-keepalive"')).status).toBe('OK (TAG "tb-keepalive") "Done"');
    expect((await c.send('LOGOUT')).status).toBe('OK "Logout completed"');

    const row = await h.db.sieveScript.findUniqueOrThrow({ where: { accountId_name: { accountId: me.id, name: 'thunderbird' } } });
    expect(row.content).toBe(SCRIPT_V2);
    expect(row.active).toBe(true);
    const audit = await h.db.auditEvent.findMany({ where: { actorAccountId: me.id, entityType: 'sieve_script' }, orderBy: { at: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['sieve.script.put', 'sieve.script.activate', 'sieve.script.put']);
    expect(audit.every((a) => a.ip === '127.0.0.1')).toBe(true);
  });

  it('renames, refuses to delete the active script, deactivates, and deletes — all audited', async () => {
    const me = await makeAccount(h);
    const c = await signedIn(h, me.address, me.appPassword);
    expect((await c.send(`PUTSCRIPT "a" ${literal('keep;')}`)).status).toBe('OK "Putscript completed"');
    expect((await c.send(`PUTSCRIPT "b" ${literal('discard;')}`)).status).toBe('OK "Putscript completed"');
    expect((await c.send('SETACTIVE "a"')).status).toBe('OK "Setactive completed"');
    expect((await c.send('SETACTIVE "b"')).status).toBe('OK "Setactive completed"');
    expect((await c.send('LISTSCRIPTS')).lines).toEqual(['"a"', '"b" ACTIVE']);
    expect((await c.send('SETACTIVE "nope"')).status).toBe('NO (NONEXISTENT) "there is no script named \\"nope\\""');
    expect((await c.send('RENAMESCRIPT "b" "a"')).status).toBe('NO (ALREADYEXISTS) "a script named \\"a\\" already exists"');
    expect((await c.send('RENAMESCRIPT "b" "Filters ✓"')).status).toBe('OK "Renamescript completed"');
    expect((await c.send('LISTSCRIPTS')).lines.sort()).toEqual(['"Filters ✓" ACTIVE', '"a"'].sort());
    expect((await c.send('DELETESCRIPT "Filters ✓"')).status).toBe('NO (ACTIVE) "the active script cannot be deleted; deactivate it first"');
    expect((await c.send('SETACTIVE ""')).status).toBe('OK "Setactive completed"');
    expect((await c.send('DELETESCRIPT "Filters ✓"')).status).toBe('OK "Deletescript completed"');
    expect((await c.send('GETSCRIPT "Filters ✓"')).status).toBe('NO (NONEXISTENT) "There is no script by that name"');
    expect((await c.send('LISTSCRIPTS')).lines).toEqual(['"a"']);
    const actions = (await h.db.auditEvent.findMany({ where: { actorAccountId: me.id, entityType: 'sieve_script' }, orderBy: { at: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['sieve.script.put', 'sieve.script.put', 'sieve.script.activate', 'sieve.script.activate', 'sieve.script.rename', 'sieve.script.deactivate', 'sieve.script.delete']);
    await c.send('LOGOUT');
  });

  it('AUTHENTICATE without an initial response takes the response after an empty challenge', async () => {
    const me = await makeAccount(h);
    const c = await SieveClient.connect(h.port);
    await c.reply();
    await c.startTls();
    c.write('AUTHENTICATE "PLAIN"\r\n');
    expect(await c.next()).toBe('""');
    expect((await c.send(`{${plain(me.address, me.appPassword).length}+}\r\n${plain(me.address, me.appPassword)}`)).status).toBe('OK "Authenticated"');
    expect((await c.send('LISTSCRIPTS')).status).toBe('OK "Listscripts completed"');
    await c.send('LOGOUT');
  });

  it('keeps accounts apart', async () => {
    const alice = await makeAccount(h);
    const bob = await makeAccount(h);
    const a = await signedIn(h, alice.address, alice.appPassword);
    expect((await a.send(`PUTSCRIPT "private" ${literal('keep;')}`)).status).toBe('OK "Putscript completed"');
    const b = await signedIn(h, bob.address, bob.appPassword);
    expect((await b.send('LISTSCRIPTS')).lines).toEqual([]);
    expect((await b.send('GETSCRIPT "private"')).status).toBe('NO (NONEXISTENT) "There is no script by that name"');
    expect((await b.send('DELETESCRIPT "private"')).status).toMatch(/^NO \(NONEXISTENT\)/);
    await a.send('LOGOUT');
    await b.send('LOGOUT');
  });

  it('refuses the account password and an app password without the sieve scope — and audits both failures', async () => {
    const me = await makeAccount(h);
    const imapOnly = await makeAccount(h, ['imap']);
    const c = await SieveClient.connect(h.port);
    await c.reply();
    await c.startTls();
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(me.address, WEB_PASSWORD)}"`)).status).toBe('NO "Authentication failed"');
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(imapOnly.address, imapOnly.appPassword)}"`)).status).toBe('NO "Authentication failed"');
    expect((await c.send('LISTSCRIPTS')).status).toBe('NO "Authenticate first"');
    // A third failure in one session ends it.
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(me.address, 'nope')}"`)).status).toBe('BYE "Too many authentication failures"');
    const failures = await h.db.auditEvent.findMany({ where: { action: FAILURE_ACTION } });
    const mine = failures.filter((f) => JSON.stringify(f.after).includes('managesieve'));
    expect(mine.length).toBeGreaterThanOrEqual(3);
  });

  it('is throttled: past the source ceiling a login is refused with TRYLATER before the password is checked', async () => {
    const me = await makeAccount(h);
    const tight = await h.serverWith({ throttle: createAuthThrottle({ ledger: memoryLedger(), sleep: () => Promise.resolve(), sourceCeiling: 2 }) });
    const c = await SieveClient.connect(tight.port);
    await c.reply();
    await c.startTls();
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(me.address, 'wrong-1')}"`)).status).toBe('NO "Authentication failed"');
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(me.address, 'wrong-2')}"`)).status).toBe('NO "Authentication failed"');
    // Even the right password is not looked at now.
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(me.address, me.appPassword)}"`)).status).toBe('NO (TRYLATER) "Too many failed attempts; try again later"');
    await c.closeSocket();
  });

  it('answers a bare LF and an unknown command with NO, and stays usable', async () => {
    const c = await SieveClient.connect(h.port);
    await c.reply();
    c.write('CAPABILITY\n');
    expect((await c.reply()).status).toBe('NO "bare LF in a command line (lines end with CRLF)"');
    expect((await c.send('FROBNICATE')).status).toBe('NO "Unknown command FROBNICATE"');
    expect((await c.send('PUTSCRIPT "x" {5+}\r\nkeep;')).status).toBe('NO "Authenticate first"');
    expect((await c.send('LOGOUT')).status).toBe('OK "Logout completed"');
  });

  it('refuses a script over the size limit without storing it', async () => {
    const me = await makeAccount(h);
    const c = await signedIn(h, me.address, me.appPassword);
    const huge = `# ${'x'.repeat(300 * 1024)}\r\nkeep;\r\n`;
    expect((await c.send(`HAVESPACE "big" ${Buffer.byteLength(huge)}`)).status).toMatch(/^NO \(QUOTA\/MAXSIZE\)/);
    expect((await c.send(`PUTSCRIPT "big" ${literal(huge)}`)).status).toMatch(/^NO \(QUOTA\/MAXSIZE\)/);
    expect((await c.send('LISTSCRIPTS')).lines).toEqual([]);
    await c.send('LOGOUT');
  });

  it('takes PROXY v2 from the edge peer (the real client address is the one audited) and refuses it from anyone else', async () => {
    const me = await makeAccount(h);
    const edge = await h.serverWith({ edgePeers: ['127.0.0.1'] });
    const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const s = netConnect(edge.port, '127.0.0.1', () => {
        resolve(s);
      });
      s.once('error', reject);
    });
    const c = SieveClient.over(socket);
    c.write(encodeProxyV2({ command: 'PROXY', family: 'TCP4', source: { address: '203.0.113.9', port: 40000 }, destination: { address: '10.77.0.2', port: 4190 } }));
    expect((await c.reply()).status).toBe('OK "Postroom ManageSieve ready"');
    await c.startTls();
    expect((await c.send(`AUTHENTICATE "PLAIN" "${plain(me.address, me.appPassword)}"`)).status).toBe('OK "Authenticated"');
    expect((await c.send(`PUTSCRIPT "p" ${literal('keep;')}`)).status).toBe('OK "Putscript completed"');
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { actorAccountId: me.id, action: 'sieve.script.put' } });
    expect(audit.ip).toBe('203.0.113.9');
    await c.send('LOGOUT');

    // Not the edge: a PROXY header closes the connection.
    const stray = await SieveClient.connect(h.port);
    stray.write(encodeProxyV2({ command: 'PROXY', family: 'TCP4', source: { address: '198.51.100.1', port: 1 }, destination: { address: '10.77.0.2', port: 4190 } }));
    await expect(
      (async () => {
        for (;;) await stray.next();
      })(),
    ).rejects.toThrow('connection closed');
  });
});
