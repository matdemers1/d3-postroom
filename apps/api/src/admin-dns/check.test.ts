// PST-REQ-099: expected-record generation and the live verdicts — SPF evaluated for the edge IP (a
// deliberately wrong SPF fails, with the reason), DKIM p= compared, DMARC parsed, PTR
// forward-confirmed, and a resolver that does not answer is never a pass.
import { dnsRecordFor, generateDkimKeys } from '@postroom/auth-checks';
import { describe, expect, it } from 'vitest';
import { checkRecords, parseSrvRdata, type CheckRow } from './check.js';
import { dkimPublicKey, expectedRecords, hostsFromEnv, isForbiddenName, type ExpectedInput } from './expected.js';
import { encodeSrvRdata, fakeResolver, type FakeZone } from './fake-resolver.js';

const EDGE = '203.0.113.7';
const keys = generateDkimKeys();
const ED_RECORD = dnsRecordFor('ed25519-sha256', keys.ed25519.publicKey);
const RSA_RECORD = dnsRecordFor('rsa-sha256', keys.rsa.publicKey);
const other = generateDkimKeys();

function input(extra: Partial<ExpectedInput> = {}): ExpectedInput {
  return {
    ...hostsFromEnv({ EDGE_PUBLIC_IP: EDGE }, 'd3cloud.io', 'https://mail.d3cloud.io'),
    dkim: [
      { selector: 'pr20260926e', dnsRecord: ED_RECORD },
      { selector: 'pr20260926r', dnsRecord: RSA_RECORD },
    ],
    ...extra,
  };
}

/** A zone where everything Postroom needs is published correctly. */
function goodZone(): FakeZone {
  return {
    records: {
      'd3cloud.io': [
        { type: 'MX', preference: 10, exchange: 'mail.d3cloud.io' },
        { type: 'TXT', value: `v=spf1 ip4:${EDGE} -all` },
        { type: 'TXT', value: 'google-site-verification=abc' },
      ],
      'mail.d3cloud.io': [{ type: 'A', value: EDGE }],
      'pr20260926e._domainkey.d3cloud.io': [{ type: 'TXT', value: ED_RECORD }],
      'pr20260926r._domainkey.d3cloud.io': [{ type: 'TXT', value: RSA_RECORD }],
      '_dmarc.d3cloud.io': [{ type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:dmarc-reports@d3cloud.io' }],
      [EDGE]: [{ type: 'PTR', value: 'mail.d3cloud.io' }],
      '_mta-sts.d3cloud.io': [{ type: 'TXT', value: 'v=STSv1; id=20260926' }],
      'mta-sts.d3cloud.io': [{ type: 'CNAME', value: 'mail.d3cloud.io' }],
      '_smtp._tls.d3cloud.io': [{ type: 'TXT', value: 'v=TLSRPTv1; rua=mailto:tls-reports@d3cloud.io' }],
      '_submissions._tcp.d3cloud.io': [{ type: 'SRV', priority: 0, weight: 1, port: 465, target: 'mail.d3cloud.io' }],
      '_imaps._tcp.d3cloud.io': [{ type: 'SRV', priority: 0, weight: 1, port: 993, target: 'mail.d3cloud.io' }],
      '_caldavs._tcp.d3cloud.io': [{ type: 'SRV', priority: 0, weight: 1, port: 443, target: 'mail.d3cloud.io' }],
      '_carddavs._tcp.d3cloud.io': [{ type: 'SRV', priority: 0, weight: 1, port: 443, target: 'mail.d3cloud.io' }],
      'autoconfig.d3cloud.io': [{ type: 'CNAME', value: 'mail.d3cloud.io' }],
      'autodiscover.d3cloud.io': [{ type: 'A', value: EDGE }],
    },
  };
}

async function run(zone: FakeZone, extra: Partial<ExpectedInput> = {}): Promise<CheckRow[]> {
  const i = input(extra);
  return checkRecords({ resolver: fakeResolver(zone), domain: i.domain, helo: i.mxHostname }, expectedRecords(i));
}

const find = (rows: CheckRow[], record: CheckRow['record'], name?: string): CheckRow => {
  const r = rows.find((x) => x.record === record && (name === undefined || x.name === name));
  if (r === undefined) throw new Error(`no ${record} row`);
  return r;
};

describe('expected records (PST-REQ-099)', () => {
  it('covers MX, SPF, DKIM per selector, DMARC, PTR, MTA-STS, TLS-RPT, four SRV and autoconfig/autodiscover', () => {
    const rows = expectedRecords(input());
    expect(rows.map((r) => `${r.record} ${r.name}`)).toEqual([
      'MX d3cloud.io',
      'SPF d3cloud.io',
      'DKIM pr20260926e._domainkey.d3cloud.io',
      'DKIM pr20260926r._domainkey.d3cloud.io',
      'DMARC _dmarc.d3cloud.io',
      'PTR 7.113.0.203.in-addr.arpa',
      'MTA-STS _mta-sts.d3cloud.io',
      'MTA-STS host mta-sts.d3cloud.io',
      'TLS-RPT _smtp._tls.d3cloud.io',
      'SRV _submissions._tcp.d3cloud.io',
      'SRV _imaps._tcp.d3cloud.io',
      'SRV _caldavs._tcp.d3cloud.io',
      'SRV _carddavs._tcp.d3cloud.io',
      'autoconfig autoconfig.d3cloud.io',
      'autodiscover autodiscover.d3cloud.io',
    ]);
    const byRecord = Object.fromEntries(rows.map((r) => [r.name, r.expected]));
    expect(byRecord['d3cloud.io']).toBeDefined();
    expect(rows.find((r) => r.record === 'MX')?.expected).toBe('10 mail.d3cloud.io.');
    expect(rows.find((r) => r.record === 'MX')?.afterGoLive).toBe(true);
    expect(rows.find((r) => r.record === 'SPF')?.expected).toBe(`v=spf1 ip4:${EDGE} -all`);
    expect(rows.find((r) => r.record === 'DMARC')?.expected).toBe('v=DMARC1; p=none; rua=mailto:dmarc-reports@d3cloud.io');
    expect(rows.find((r) => r.record === 'PTR')?.expected).toBe('mail.d3cloud.io.');
    expect(rows.find((r) => r.name === '_submissions._tcp.d3cloud.io')?.expected).toBe('0 1 465 mail.d3cloud.io.');
  });

  it('says "edge not provisioned" rather than inventing an SPF or PTR value', () => {
    const rows = expectedRecords({ ...hostsFromEnv({}, 'd3cloud.io', 'https://mail.d3cloud.io'), dkim: [] });
    const spf = rows.find((r) => r.record === 'SPF');
    expect(spf?.expected).toBeNull();
    expect(spf?.note).toMatch(/not provisioned/);
    expect(rows.find((r) => r.record === 'PTR')?.expected).toBeNull();
    expect(rows.find((r) => r.record === 'DKIM')?.note).toMatch(/No DKIM keys yet/);
  });

  it('never suggests anything at the no-reply subdomain', () => {
    expect(isForbiddenName('no-reply.d3cloud.io')).toBe(true);
    expect(isForbiddenName('x._domainkey.no-reply.d3cloud.io')).toBe(true);
    expect(isForbiddenName('d3cloud.io')).toBe(false);
    expect(expectedRecords(input()).some((r) => r.name.includes('no-reply'))).toBe(false);
  });

  it('extracts p= from a DKIM record', () => {
    expect(dkimPublicKey('v=DKIM1; k=ed25519; p=abc def')).toBe('abcdef');
    expect(dkimPublicKey('v=DKIM1; k=rsa')).toBeNull();
  });

  it('round-trips SRV rdata, and refuses a compressed target', () => {
    expect(parseSrvRdata(encodeSrvRdata({ priority: 0, weight: 1, port: 993, target: 'mail.d3cloud.io.' }))).toEqual({ priority: 0, weight: 1, port: 993, target: 'mail.d3cloud.io' });
    expect(parseSrvRdata(Uint8Array.from([0, 0, 0, 1, 3, 225, 0xc0, 12]))).toBeNull();
  });
});

describe('live verdicts (PST-REQ-099)', () => {
  it('passes every record of a correct zone', async () => {
    const rows = await run(goodZone());
    for (const r of rows) expect(`${r.record} ${r.name}: ${r.status} (${r.reason})`).toMatch(/: pass \(/);
    expect(find(rows, 'SPF').reason).toMatch(/Evaluated for the edge 203\.0\.113\.7: pass/);
    expect(find(rows, 'PTR').reason).toMatch(/forward-confirmed/);
    expect(find(rows, 'SPF').live).toEqual([`v=spf1 ip4:${EDGE} -all`]);
  });

  it('a deliberately wrong SPF fails, and says why', async () => {
    const zone = goodZone();
    zone.records['d3cloud.io'] = [{ type: 'MX', preference: 10, exchange: 'mail.d3cloud.io' }, { type: 'TXT', value: 'v=spf1 ip4:198.51.100.9 -all' }];
    const spf = find(await run(zone), 'SPF');
    expect(spf.status).toBe('fail');
    expect(spf.reason).toMatch(/Evaluated for the edge 203\.0\.113\.7: fail \(matched -all\) — the edge is not authorised/);
    expect(spf.live).toEqual(['v=spf1 ip4:198.51.100.9 -all']);
  });

  it('SPF: two records is a fail, a broken one is a fail, none is missing', async () => {
    const two = goodZone();
    two.records['d3cloud.io'] = [{ type: 'TXT', value: `v=spf1 ip4:${EDGE} -all` }, { type: 'TXT', value: 'v=spf1 -all' }];
    expect(find(await run(two), 'SPF').reason).toMatch(/More than one/);
    const broken = goodZone();
    broken.records['d3cloud.io'] = [{ type: 'TXT', value: `v=spf1 ip4:${EDGE} bogus:x -all` }];
    const b = find(await run(broken), 'SPF');
    expect(b.status).toBe('fail');
    expect(b.reason).toMatch(/permerror/);
    const none = goodZone();
    none.records['d3cloud.io'] = [];
    expect(find(await run(none), 'SPF').status).toBe('missing');
  });

  it('SPF and PTR are pending while the edge is not provisioned', async () => {
    const rows = await run(goodZone(), { edgeIp: null });
    expect(find(rows, 'SPF').status).toBe('pending');
    expect(find(rows, 'PTR').status).toBe('pending');
  });

  it('DKIM: a different key fails, a missing record is missing', async () => {
    const zone = goodZone();
    zone.records['pr20260926e._domainkey.d3cloud.io'] = [{ type: 'TXT', value: dnsRecordFor('ed25519-sha256', other.ed25519.publicKey) }];
    delete zone.records['pr20260926r._domainkey.d3cloud.io'];
    const rows = await run(zone);
    const ed = find(rows, 'DKIM', 'pr20260926e._domainkey.d3cloud.io');
    expect(ed.status).toBe('fail');
    expect(ed.reason).toMatch(/different key/);
    expect(find(rows, 'DKIM', 'pr20260926r._domainkey.d3cloud.io').status).toBe('missing');
  });

  it('DMARC: parsed — no rua fails, a stricter p passes with a note, two records fail', async () => {
    const noRua = goodZone();
    noRua.records['_dmarc.d3cloud.io'] = [{ type: 'TXT', value: 'v=DMARC1; p=none' }];
    expect(find(await run(noRua), 'DMARC').reason).toMatch(/no rua/);
    const strict = goodZone();
    strict.records['_dmarc.d3cloud.io'] = [{ type: 'TXT', value: 'v=DMARC1; p=reject; rua=mailto:a@d3cloud.io' }];
    const s = find(await run(strict), 'DMARC');
    expect(s.status).toBe('pass');
    expect(s.reason).toMatch(/stricter/);
    const two = goodZone();
    two.records['_dmarc.d3cloud.io'] = [{ type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:a@d3cloud.io' }, { type: 'TXT', value: 'v=DMARC1; p=reject; rua=mailto:a@d3cloud.io' }];
    expect(find(await run(two), 'DMARC').status).toBe('fail');
  });

  it('PTR must be forward-confirmed', async () => {
    const zone = goodZone();
    zone.records['mail.d3cloud.io'] = [{ type: 'A', value: '198.51.100.1' }];
    const ptr = find(await run(zone), 'PTR');
    expect(ptr.status).toBe('fail');
    expect(ptr.reason).toMatch(/not forward-confirmed/);
    const wrong = goodZone();
    wrong.records[EDGE] = [{ type: 'PTR', value: 'ec2-203-0-113-7.compute-1.amazonaws.com' }];
    expect(find(await run(wrong), 'PTR').reason).toMatch(/not mail\.d3cloud\.io/);
  });

  it('go-live records absent before go-live are pending, not missing', async () => {
    const zone = goodZone();
    zone.records = Object.fromEntries(Object.entries(zone.records).filter(([k]) => !['_mta-sts.d3cloud.io', 'mta-sts.d3cloud.io', '_submissions._tcp.d3cloud.io', '_imaps._tcp.d3cloud.io'].includes(k)));
    zone.records['d3cloud.io'] = [{ type: 'TXT', value: `v=spf1 ip4:${EDGE} -all` }];
    const rows = await run(zone);
    expect(find(rows, 'MX').status).toBe('pending');
    expect(find(rows, 'MX').reason).toMatch(/expected after go-live/);
    expect(find(rows, 'MTA-STS').status).toBe('pending');
    expect(find(rows, 'SRV', '_imaps._tcp.d3cloud.io').status).toBe('pending');
    // CalDAV is not a go-live record: absent is missing.
    delete zone.records['_caldavs._tcp.d3cloud.io'];
    expect(find(await run(zone), 'SRV', '_caldavs._tcp.d3cloud.io').status).toBe('missing');
  });

  it('SRV pointing at the wrong port fails; MX elsewhere fails', async () => {
    const zone = goodZone();
    zone.records['_imaps._tcp.d3cloud.io'] = [{ type: 'SRV', priority: 0, weight: 1, port: 143, target: 'mail.d3cloud.io' }];
    zone.records['d3cloud.io'] = [{ type: 'MX', preference: 10, exchange: 'd3cloud-io.mail.protection.outlook.com' }, { type: 'TXT', value: `v=spf1 ip4:${EDGE} -all` }];
    const rows = await run(zone);
    expect(find(rows, 'SRV', '_imaps._tcp.d3cloud.io').status).toBe('fail');
    expect(find(rows, 'MX').status).toBe('fail');
  });

  it('a resolver timeout is unknown, never pass', async () => {
    const zone = goodZone();
    zone.timeouts = ['d3cloud.io', '_dmarc.d3cloud.io'];
    const rows = await run(zone);
    for (const r of [find(rows, 'SPF'), find(rows, 'MX'), find(rows, 'DMARC')]) {
      expect(r.status).toBe('unknown');
      expect(r.reason).toMatch(/did not answer|temporary DNS error/);
    }
  });

  it('never queries the no-reply subdomain', async () => {
    const resolver = fakeResolver(goodZone());
    const i = input();
    await checkRecords({ resolver, domain: i.domain, helo: i.mxHostname }, expectedRecords(i));
    expect(resolver.queries.some((q) => q.includes('no-reply'))).toBe(false);
  });
});
