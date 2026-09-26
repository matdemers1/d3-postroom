// Adversarial class 6 — PROXY protocol spoofing (PST-REQ-087, PST-REQ-016).
//
// Expected safe behaviour:
//   - A PROXY header is honoured only from the edge's WireGuard peer. From anyone else it closes the
//     connection (smtp-in, IMAP 143), fails the handshake (IMAP 993), or is at best an unknown
//     command (submission, which the edge never forwards) — and in no case does the claimed source
//     address become the session's client address.
//   - From the edge peer a PROXY v2 header is required: none (timeout), a v1 text header, data
//     before the header, a LOCAL or address-less header, a truncated header, a TLV that overruns
//     the header, or a header larger than the 4096-octet ceiling all close the connection without a
//     greeting.
//   - Only the first header counts: a second one later in the stream never re-assigns the client.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { ImapClient } from './support/imap-client.js';
import { codeOf, SmtpClient } from './support/smtp-client.js';
import { DATABASE_URL, eventually, World, type Account } from './support/world.js';

const SPOOFED = '203.0.113.7';

function v2(source = SPOOFED, tlvs: { type: number; value: Buffer }[] = []): Buffer {
  return encodeProxyV2({
    command: 'PROXY',
    family: 'TCP4',
    source: { address: source, port: 40_000 },
    destination: { address: '10.77.0.2', port: 25 },
    tlvs,
  });
}

const V1 = Buffer.from(`PROXY TCP4 ${SPOOFED} 10.77.0.2 40000 25\r\n`);

/** A v2 header (plus `append`) whose length field is off by `delta` from what it really holds. */
function withLengthDelta(header: Buffer, delta: number, append: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.concat([header, append]);
  out.writeUInt16BE(header.readUInt16BE(14) + delta, 14);
  return out;
}

describe.skipIf(DATABASE_URL === undefined)('adversarial: PROXY spoofing (PST-REQ-087 / PST-REQ-016)', () => {
  let w: World;
  let alice: Account;
  let mxDirect = 0;
  let mxEdge = 0;
  let imapDirect = 0;
  let imapsDirect = 0;
  let imapEdge = 0;
  let sub587 = 0;

  beforeAll(async () => {
    w = await World.create('pst_adv_proxy');
    alice = await w.account();
    // Loopback is not the edge here (the edge is 10.77.0.1)...
    mxDirect = (await w.smtpIn()).port;
    const imap = await w.imap();
    imapDirect = imap.port;
    imapsDirect = imap.tlsPort;
    // ...and here it is, so the tests can speak as the edge.
    mxEdge = (await w.smtpIn({ edgePeers: ['127.0.0.1'], proxyTimeoutMs: 400 })).port;
    imapEdge = (await w.imap({ edgePeers: ['127.0.0.1'], proxyTimeoutMs: 400 })).port;
    sub587 = (await w.submission()).port587;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const sessionsFrom = (ip: string): number =>
    w.logs.filter((l) => (l.event === 'session' || l.event === 'auth') && (l.fields['clientIp'] === ip || l.fields['ip'] === ip)).length;

  // --- not the edge ---------------------------------------------------------------------------

  it('smtp-in: a v2 or v1 header from a peer that is not the edge closes the connection, and the address is never used', async () => {
    for (const header of [v2(), V1]) {
      const c = await SmtpClient.plain(mxDirect, Buffer.concat([header, Buffer.from('EHLO spoof.example\r\n')]));
      expect(await c.closed()).toBe(true);
      // At most the connect-time greeting; the header and the EHLO behind it were never commands.
      expect(c.transcript.every((r) => r.code === 220)).toBe(true);
    }
    expect(await eventually(() => w.logs.some((l) => l.event === 'proxy-refused' && String(l.fields['reason']).includes('not the edge')))).toBe(true);
    expect(sessionsFrom(SPOOFED)).toBe(0);
  });

  it('smtp-in: a PROXY header sent mid-session from a non-edge peer is just bad input', async () => {
    const c = await SmtpClient.plain(mxDirect);
    await c.next();
    await c.cmd('EHLO client.example');
    c.write(V1);
    expect((await c.next()).code).toBe(500);
    c.write(v2());
    // The binary signature holds a bare LF ("QUIT\n"): errors, then the session closes.
    expect(await c.closed()).toBe(true);
    await eventually(() => w.logs.some((l) => l.event === 'session' && l.fields['helo'] === 'client.example'));
    const s = w.logs.find((l) => l.event === 'session' && l.fields['helo'] === 'client.example');
    expect(s?.fields['clientIp']).toBe('127.0.0.1');
    expect(s?.fields['via']).toBe('direct');
  });

  it('IMAP 143: a PROXY header from a peer that is not the edge closes the connection', async () => {
    for (const header of [v2(), V1]) {
      const c = await ImapClient.plain(imapDirect, Buffer.concat([header, Buffer.from('a1 CAPABILITY\r\n')]));
      expect(await c.closed()).toBe(true);
      expect(c.transcript.some((l) => l.startsWith('a1 '))).toBe(false);
    }
    expect(sessionsFrom(SPOOFED)).toBe(0);
  });

  it('IMAP 993: a PROXY header in place of a ClientHello fails the handshake', async () => {
    const c = await ImapClient.plain(imapsDirect, Buffer.concat([v2(), Buffer.from('a1 CAPABILITY\r\n')]));
    expect(await c.closed()).toBe(true);
    expect(c.transcript).toEqual([]);
    expect(sessionsFrom(SPOOFED)).toBe(0);
  });

  it('submission (never forwarded by the edge): a PROXY header is never honoured', async () => {
    const c = await SmtpClient.plain(sub587, V1);
    expect((await c.next()).code).toBe(220);
    expect((await c.next()).code).toBe(500);
    await c.cmd('EHLO client.example');
    c.close();
    const d = await SmtpClient.plain(sub587, v2());
    expect(await d.closed()).toBe(true);
    expect(d.transcript.every((r) => r.code === 220 || r.code >= 500)).toBe(true);
    // Whatever the header claimed, the throttle and the logs still see loopback.
    const rows = await w.db.auditEvent.findMany({ where: { action: 'auth.failure' } });
    expect(JSON.stringify(rows)).not.toContain(SPOOFED);
  });

  // --- from the edge --------------------------------------------------------------------------

  async function refusedByEdgeListener(port: number, bytes: Buffer | null, protocol: 'smtp' | 'imap'): Promise<void> {
    if (protocol === 'smtp') {
      const c = await SmtpClient.plain(port, bytes ?? undefined);
      expect(await c.closed()).toBe(true);
      expect(c.transcript).toEqual([]); // not even a greeting
    } else {
      const c = await ImapClient.plain(port, bytes ?? undefined);
      expect(await c.closed()).toBe(true);
      expect(c.transcript).toEqual([]);
    }
  }

  const MALFORMED: readonly (readonly [string, Buffer | null])[] = [
    ['no header at all (timeout)', null],
    ['a v1 text header', V1],
    ['data before the header', Buffer.concat([Buffer.from('EHLO x\r\n'), v2()])],
    ['a LOCAL header', encodeProxyV2({ command: 'LOCAL', family: 'UNSPEC' })],
    // The LOCAL encoding with its command nibble flipped to PROXY: a PROXY header with no source.
    ['PROXY with no addresses (UNSPEC)', (() => { const b = encodeProxyV2({ command: 'LOCAL', family: 'UNSPEC' }); b[12] = 0x21; return b; })()],
    ['a truncated header, then silence', v2().subarray(0, 20)],
    ['a length shorter than the TCP4 addresses', withLengthDelta(v2(), -4)],
    ['a TLV header cut short by the length', withLengthDelta(v2(), 2, Buffer.from([0x01, 0x00]))],
    ['a TLV whose length overruns the header', withLengthDelta(v2(), 3, Buffer.from([0x04, 0x00, 0x50]))],
    ['a header over the 4096-octet ceiling', v2(SPOOFED, [{ type: 0xe0, value: Buffer.alloc(5000, 0x41) }])],
    ['a wrong version nibble', (() => { const b = v2(); b[12] = 0x11; return b; })()],
    ['an unknown family', (() => { const b = v2(); b[13] = 0x31; return b; })()],
  ];

  for (const [what, bytes] of MALFORMED) {
    it(`smtp-in from the edge: ${what} → closed without a greeting`, async () => {
      await refusedByEdgeListener(mxEdge, bytes, 'smtp');
    });
    it(`IMAP from the edge: ${what} → closed without a greeting`, async () => {
      await refusedByEdgeListener(imapEdge, bytes, 'imap');
    });
  }

  it('smtp-in from the edge: only the first header counts; a second one never re-assigns the client', async () => {
    const c = await SmtpClient.plain(mxEdge, v2('198.51.100.20'));
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd('EHLO first.example')).code).toBe(250);
    c.write(v2('192.0.2.99'));
    expect(await c.closed()).toBe(true);
    expect(await eventually(() => w.logs.some((l) => l.event === 'session' && l.fields['helo'] === 'first.example'))).toBe(true);
    const s = w.logs.find((l) => l.event === 'session' && l.fields['helo'] === 'first.example');
    expect(s?.fields['clientIp']).toBe('198.51.100.20');
    expect(s?.fields['via']).toBe('proxy');
    expect(sessionsFrom('192.0.2.99')).toBe(0);
  });

  it('IMAP from the edge: a well-formed header works, and the forwarded address is what the throttle sees', async () => {
    const c = await ImapClient.plain(imapEdge, v2('198.51.100.21'));
    expect(await c.next()).toMatch(/^\* OK /);
    const r = await c.command('a1', `LOGIN "${alice.address}" "wrong"`);
    // 143 before STARTTLS: refused for privacy before any credential check.
    expect(r.tagged).toMatch(/^a1 NO \[PRIVACYREQUIRED\]/);
    c.close();
    expect(await eventually(() => w.logs.some((l) => l.event === 'session' && l.fields['ip'] === '198.51.100.21'))).toBe(true);
  });

  it('smtp-in from the edge: a legitimate header, then SMTP, is served with the forwarded address', async () => {
    const c = await SmtpClient.plain(mxEdge, v2('198.51.100.22'));
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd('EHLO legit.example')).code).toBe(250);
    expect(codeOf(await c.cmd('QUIT'))).toBe('221 2.0.0');
    expect(await eventually(() => w.logs.some((l) => l.event === 'session' && l.fields['clientIp'] === '198.51.100.22'))).toBe(true);
  });
});
