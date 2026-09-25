// MX selection for the direct transport, against an in-memory resolver and a recording connector:
// preference order, falling through on connect failure, IPv4 only (PST-REQ-036), null MX, NXDOMAIN,
// SERVFAIL, and the per-attempt address cap.
import net from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpClientError, type Connector } from '../../src/client/connection.js';
import { fakeResolver, startFakeMx, type FakeDns, type FakeMx } from '../../src/client/fake-mx.js';
import { createDirectTransport } from '../../src/client/transport.js';
import type { DeliveryRequest } from '../../src/transports/types.js';

function request(domain: string, signal = new AbortController().signal): DeliveryRequest {
  return {
    envelopeFrom: 'me@d3cloud.io',
    domain,
    recipients: [{ id: 'r1', address: `you@${domain}`, notify: null }],
    message: () => Promise.resolve(Readable.from([Buffer.from('Subject: hi\r\n\r\nbody\r\n')])),
    size: 22,
    dsnRet: null,
    dsnEnvid: null,
    signal,
  };
}

describe('direct transport MX selection', () => {
  let mx: FakeMx;
  const dialed: string[] = [];
  /** 127.0.0.1 reaches the fake MX; every other address is refused, as a dead MX would be. */
  const connector: Connector = (o) => {
    dialed.push(o.host);
    if (o.host !== '127.0.0.1') return Promise.reject(new SmtpClientError('connect', 'connect', `${o.host}: ECONNREFUSED`));
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: mx.port }, () => { resolve(s); });
      s.once('error', reject);
    });
  };
  const transport = (dns: FakeDns, ipv4Only = true, maxAddresses?: number) => createDirectTransport({
    resolver: fakeResolver(dns),
    ipv4Only,
    connect: connector,
    random: () => 0,
    log: () => undefined,
    ...(maxAddresses === undefined ? {} : { maxAddresses }),
  });

  beforeAll(async () => { mx = await startFakeMx(); });
  afterAll(async () => { await mx.close(); });

  it('dials MX hosts in preference order and falls to the next one on connect failure', async () => {
    dialed.length = 0;
    const result = await transport({
      mx: { 'pref.test': [{ preference: 20, exchange: 'backup.pref.test' }, { preference: 10, exchange: 'primary.pref.test' }] },
      a: { 'primary.pref.test': ['192.0.2.10', '192.0.2.11'], 'backup.pref.test': ['127.0.0.1'] },
    }).deliver(request('pref.test'));
    expect(dialed).toEqual(['192.0.2.10', '192.0.2.11', '127.0.0.1']);
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(result.details).toMatchObject({ mxHost: 'backup.pref.test', mxIp: '127.0.0.1', localIp: '127.0.0.1' });
  });

  it('with ipv4Only never looks up or dials an AAAA address', async () => {
    dialed.length = 0;
    const dns: FakeDns = {
      mx: { 'v6.test': [{ preference: 10, exchange: 'mx.v6.test' }] },
      a: { 'mx.v6.test': ['127.0.0.1'] },
      aaaa: { 'mx.v6.test': ['2001:db8::25'] },
    };
    const resolver = fakeResolver(dns);
    const t = createDirectTransport({ resolver, connect: connector, log: () => undefined });
    const result = await t.deliver(request('v6.test'));
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(dialed).toEqual(['127.0.0.1']);
    expect(resolver.queries.filter((q) => q.type === 'AAAA')).toEqual([]);

    // An MX with only AAAA addresses is undeliverable over IPv4: nothing dialled, retried later.
    dialed.length = 0;
    const onlyV6 = await transport({ mx: { 'v6only.test': [{ preference: 10, exchange: 'mx.v6only.test' }] }, aaaa: { 'mx.v6only.test': ['2001:db8::25'] } })
      .deliver(request('v6only.test'));
    expect(dialed).toEqual([]);
    expect(onlyV6.results['r1']).toMatchObject({ kind: 'error' });
  });

  it('with IPv6 on, dials the AAAA address too', async () => {
    dialed.length = 0;
    await transport({ mx: { 'v6.test': [{ preference: 10, exchange: 'mx.v6.test' }] }, a: { 'mx.v6.test': ['192.0.2.1'] }, aaaa: { 'mx.v6.test': ['2001:db8::25'] } }, false)
      .deliver(request('v6.test'));
    expect(dialed).toEqual(['192.0.2.1', '2001:db8::25']);
  });

  it('null MX is permanent 556 5.1.10 without dialling anything', async () => {
    dialed.length = 0;
    const result = await transport({ mx: { 'null.test': [{ preference: 0, exchange: '.' }] } }).deliver(request('null.test'));
    expect(result.results['r1']).toMatchObject({ kind: 'permanent', code: 556, enhanced: '5.1.10' });
    expect(dialed).toEqual([]);
  });

  it('NXDOMAIN is permanent 550 5.1.2; SERVFAIL is a temporary error', async () => {
    const nx = await transport({ mx: { 'gone.test': 'nxdomain' } }).deliver(request('gone.test'));
    expect(nx.results['r1']).toMatchObject({ kind: 'permanent', code: 550, enhanced: '5.1.2' });
    const sf = await transport({ mx: { 'bogus.test': 'servfail' } }).deliver(request('bogus.test'));
    expect(sf.results['r1']).toMatchObject({ kind: 'error' });
    expect(sf.results['r1']?.kind === 'error' && sf.results['r1'].error).toMatch(/SERVFAIL/);
  });

  it('falls back to the implicit MX (the domain\'s own A record) when there is no MX', async () => {
    dialed.length = 0;
    const result = await transport({ a: { 'implicit.test': ['127.0.0.1'] } }).deliver(request('implicit.test'));
    expect(dialed).toEqual(['127.0.0.1']);
    expect(result.results['r1']?.kind).toBe('delivered');
  });

  it('tries at most maxAddresses addresses per attempt (RFC 5321 §4.5.4.1)', async () => {
    dialed.length = 0;
    const result = await transport({
      mx: { 'many.test': [{ preference: 10, exchange: 'mx.many.test' }] },
      a: { 'mx.many.test': ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5', '192.0.2.6', '127.0.0.1'] },
    }).deliver(request('many.test'));
    expect(dialed).toEqual(['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5']);
    expect(result.results['r1']).toMatchObject({ kind: 'error' });
    expect(result.details.mxIp).toBe('192.0.2.5');
  });
});
