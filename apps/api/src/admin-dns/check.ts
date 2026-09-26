// The live half of the DNS checker (PST-REQ-099): for each expected record, what the resolver
// answers now, and a verdict with its reason. Every verdict is conservative:
//
//   pass     the live answer is what Postroom needs (SPF is *evaluated* for the edge IP, DKIM compares
//            p=, DMARC is parsed, PTR is forward-confirmed) — never assumed.
//   fail     something is published and it is wrong; the reason says what.
//   missing  nothing is published and it should be by now.
//   pending  nothing to check yet: a go-live record before go-live, or the edge is not provisioned.
//   unknown  the resolver did not answer (timeout, SERVFAIL, a malformed reply). Never a pass.
import {
  adaptDnsResolver,
  evaluateSpf,
  parseDkimKeyRecord,
  parseDmarcRecord,
  stripWhitespace,
  type SpfDns,
} from '@postroom/auth-checks';
import { RCode, RRType, type DnsAnswer, type Resolver, type ResolverResult } from '@postroom/dns';
import { bare, type ExpectedRecord } from './expected.js';

export type CheckStatus = 'pass' | 'fail' | 'missing' | 'pending' | 'unknown';

export interface CheckRow {
  readonly record: ExpectedRecord['record'];
  readonly name: string;
  readonly type: ExpectedRecord['type'];
  readonly expected: string | null;
  readonly afterGoLive: boolean;
  readonly note: string | null;
  readonly live: string[];
  readonly status: CheckStatus;
  readonly reason: string;
}

export const RRTYPE_SRV = 33;

/** The resolver did not give a usable answer; the row becomes `unknown`. */
export class LookupUnavailable extends Error {}

type Answer<K extends DnsAnswer['kind']> = Extract<DnsAnswer, { kind: K }>;

async function ask(resolver: Resolver, name: string, type: number): Promise<ResolverResult> {
  let result: ResolverResult;
  try {
    result = await resolver.query(name, type);
  } catch (error) {
    throw new LookupUnavailable(error instanceof Error ? error.message : String(error));
  }
  if (result.rcode !== RCode.NOERROR && result.rcode !== RCode.NXDOMAIN) {
    throw new LookupUnavailable(`the resolver answered rcode ${String(result.rcode)}`);
  }
  return result;
}

function of<K extends DnsAnswer['kind']>(result: ResolverResult, kind: K): Answer<K>[] {
  return result.answers.filter((a): a is Answer<K> => a.kind === kind);
}

async function txt(resolver: Resolver, name: string): Promise<string[]> {
  return of(await ask(resolver, name, RRType.TXT), 'TXT').map((a) => a.text);
}

export interface SrvRecord {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

/**
 * SRV rdata (RFC 2782): priority, weight, port, then the target name — which RFC 2782 says is
 * never compressed, so a compression pointer here is reported rather than followed.
 */
export function parseSrvRdata(raw: Uint8Array): SrvRecord | null {
  if (raw.length < 7) return null;
  const u16 = (i: number): number => ((raw[i] ?? 0) << 8) | (raw[i + 1] ?? 0);
  const labels: string[] = [];
  let i = 6;
  for (;;) {
    const len = raw[i];
    if (len === undefined) return null;
    if (len === 0) break;
    if ((len & 0xc0) !== 0) return null;
    const label = raw.subarray(i + 1, i + 1 + len);
    if (label.length !== len) return null;
    labels.push(Buffer.from(label).toString('latin1'));
    i += 1 + len;
  }
  return { priority: u16(0), weight: u16(2), port: u16(4), target: labels.join('.').toLowerCase() };
}

const row = (e: ExpectedRecord, live: string[], status: CheckStatus, reason: string): CheckRow => ({
  record: e.record,
  name: e.name,
  type: e.type,
  expected: e.expected,
  afterGoLive: e.afterGoLive,
  note: e.note,
  live,
  status,
  reason,
});

/** Nothing published: `pending` for a go-live record, else `missing`. */
const absent = (e: ExpectedRecord, what: string): CheckRow =>
  e.afterGoLive ? row(e, [], 'pending', `No ${what} yet — expected after go-live.`) : row(e, [], 'missing', `No ${what} is published at ${e.name}.`);

async function checkMx(resolver: Resolver, e: ExpectedRecord, host: string): Promise<CheckRow> {
  const mx = of(await ask(resolver, e.name, RRType.MX), 'MX');
  const live = mx.map((m) => `${String(m.preference)} ${bare(m.exchange)}.`);
  if (mx.length === 0) return absent(e, 'MX record');
  if (mx.some((m) => bare(m.exchange) === host)) return row(e, live, 'pass', `Mail for the domain is routed to ${host}.`);
  return row(e, live, 'fail', `MX points at ${mx.map((m) => bare(m.exchange)).join(', ')}, not ${host}.`);
}

async function checkSpf(resolver: Resolver, e: ExpectedRecord, ip: string | null, domain: string, helo: string, spfDns: SpfDns): Promise<CheckRow> {
  const records = (await txt(resolver, e.name)).filter((t) => /^v=spf1(?:$|\s)/i.test(t));
  if (ip === null) {
    return row(e, records, 'pending', records.length === 0 ? 'The edge is not provisioned, so there is no address to authorise yet.' : 'The edge is not provisioned, so the published record cannot be evaluated against its address yet.');
  }
  if (records.length === 0) return row(e, [], 'missing', `No v=spf1 record is published at ${e.name}.`);
  if (records.length > 1) return row(e, records, 'fail', 'More than one v=spf1 record is published: receivers treat that as a permanent error (RFC 7208 §4.5).');
  const result = await evaluateSpf({ ip, mailFrom: `postmaster@${domain}`, helo, dns: spfDns });
  const by = result.mechanism === undefined ? '' : ` (matched ${result.mechanism})`;
  switch (result.result) {
    case 'pass':
      return row(e, records, 'pass', `Evaluated for the edge ${ip}: pass${by}.`);
    case 'temperror':
      return row(e, records, 'unknown', `Evaluating it hit a temporary DNS error: ${result.trace.at(-1) ?? 'no answer'}.`);
    case 'permerror':
      return row(e, records, 'fail', `The record is broken (permerror): ${result.trace.at(-1) ?? 'syntax error'}.`);
    default:
      return row(e, records, 'fail', `Evaluated for the edge ${ip}: ${result.result}${by} — the edge is not authorised to send for ${domain}.`);
  }
}

async function checkDkim(resolver: Resolver, e: ExpectedRecord, publicKey: string | null): Promise<CheckRow> {
  if (publicKey === null) return row(e, [], 'pending', e.note ?? 'No DKIM key yet.');
  const live = await txt(resolver, e.name);
  if (live.length === 0) return row(e, [], 'missing', `No key record is published at ${e.name}.`);
  const problems: string[] = [];
  for (const value of live) {
    const parsed = parseDkimKeyRecord(value);
    if (!parsed.ok) {
      problems.push(parsed.reason);
      continue;
    }
    const p = /(?:^|;)\s*p=([^;]*)/.exec(value)?.[1];
    if (p !== undefined && stripWhitespace(p) === publicKey) return row(e, live, 'pass', 'The published p= is this selector’s public key.');
    problems.push(p === undefined || stripWhitespace(p) === '' ? 'the published key is revoked (empty p=)' : 'the published p= is a different key');
  }
  return row(e, live, 'fail', `${problems.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()));
}

async function checkDmarc(resolver: Resolver, e: ExpectedRecord): Promise<CheckRow> {
  const live = (await txt(resolver, e.name)).filter((t) => /^v\s*=\s*DMARC1/i.test(t));
  if (live.length === 0) return row(e, [], 'missing', `No v=DMARC1 record is published at ${e.name}.`);
  if (live.length > 1) return row(e, live, 'fail', 'More than one DMARC record is published: receivers ignore them all (RFC 7489 §6.6.3).');
  const parsed = parseDmarcRecord(live[0] ?? '');
  if (!parsed.ok) return row(e, live, 'fail', `Not a usable DMARC record: ${parsed.reason}.`);
  const { record } = parsed;
  if (record.rua.length === 0) return row(e, live, 'fail', `p=${record.p}, but no rua=: aggregate reports would go nowhere.`);
  const stricter = record.p === 'none' ? '' : ' (stricter than the p=none Postroom starts with — fine once reports are clean)';
  return row(e, live, 'pass', `p=${record.p}${stricter}; reports to ${record.rua.join(', ')}.`);
}

async function checkPtr(resolver: Resolver, e: ExpectedRecord, ip: string | null, host: string): Promise<CheckRow> {
  if (ip === null) return row(e, [], 'pending', 'The edge is not provisioned, so there is no address to look up.');
  const ptr = of(await ask(resolver, e.name, RRType.PTR), 'PTR').map((p) => bare(p.target));
  const live = ptr.map((p) => `${p}.`);
  if (ptr.length === 0) return row(e, [], 'missing', `${ip} has no reverse DNS: many receivers refuse mail from it.`);
  if (!ptr.includes(host)) return row(e, live, 'fail', `${ip} reverses to ${ptr.join(', ')}, not ${host}.`);
  const forward = ip.includes(':') ? of(await ask(resolver, host, RRType.AAAA), 'AAAA').map((a) => a.address) : of(await ask(resolver, host, RRType.A), 'A').map((a) => a.address);
  if (!forward.includes(ip)) {
    return row(e, live, 'fail', `${ip} reverses to ${host}, but ${host} resolves to ${forward.length === 0 ? 'nothing' : forward.join(', ')}: not forward-confirmed.`);
  }
  return row(e, live, 'pass', `${ip} reverses to ${host}, and ${host} resolves back to ${ip} (forward-confirmed).`);
}

async function checkMtaSts(resolver: Resolver, e: ExpectedRecord): Promise<CheckRow> {
  const live = (await txt(resolver, e.name)).filter((t) => /^v=STSv1/i.test(t.trim()));
  if (live.length === 0) return absent(e, 'MTA-STS record');
  if (live.length > 1) return row(e, live, 'fail', 'More than one v=STSv1 record: senders ignore MTA-STS (RFC 8461 §3.1).');
  const id = /(?:^|;)\s*id=([A-Za-z0-9]{1,32})\s*(?:;|$)/.exec(live[0] ?? '')?.[1];
  if (id === undefined) return row(e, live, 'fail', 'The record has no valid id= (1–32 letters and digits).');
  return row(e, live, 'pass', `Policy id ${id}.`);
}

async function checkTlsRpt(resolver: Resolver, e: ExpectedRecord): Promise<CheckRow> {
  const live = (await txt(resolver, e.name)).filter((t) => /^v=TLSRPTv1/i.test(t.trim()));
  if (live.length === 0) return absent(e, 'TLS-RPT record');
  if (!/(?:^|;)\s*rua=\S/.test(live[0] ?? '')) return row(e, live, 'fail', 'The record has no rua=: reports would go nowhere.');
  return row(e, live, 'pass', 'Senders can report TLS failures.');
}

async function checkSrv(resolver: Resolver, e: ExpectedRecord, port: number, target: string): Promise<CheckRow> {
  const answers = (await ask(resolver, e.name, RRTYPE_SRV)).answers;
  const records = answers.filter((a): a is Answer<'UNKNOWN'> => a.kind === 'UNKNOWN' && a.type === RRTYPE_SRV).map((a) => parseSrvRdata(a.raw));
  if (records.length === 0) return absent(e, 'SRV record');
  const live = records.map((r) => (r === null ? '(unreadable SRV record)' : `${String(r.priority)} ${String(r.weight)} ${String(r.port)} ${r.target}.`));
  if (records.some((r) => r !== null && r.port === port && bare(r.target) === target)) return row(e, live, 'pass', `Clients are pointed at ${target}:${String(port)}.`);
  return row(e, live, 'fail', `Expected ${target} on port ${String(port)}.`);
}

async function checkHost(resolver: Resolver, e: ExpectedRecord, target: string): Promise<CheckRow> {
  const cname = of(await ask(resolver, e.name, RRType.CNAME), 'CNAME').map((c) => bare(c.target));
  if (cname.length > 0) {
    const live = cname.map((c) => `CNAME ${c}.`);
    if (cname.includes(target)) return row(e, live, 'pass', `An alias of ${target}.`);
    return row(e, live, 'fail', `An alias of ${cname.join(', ')}, not ${target}.`);
  }
  const a = of(await ask(resolver, e.name, RRType.A), 'A').map((x) => x.address);
  if (a.length === 0) return absent(e, 'record');
  // An A record is acceptable when it is the same address the web host has.
  const web = of(await ask(resolver, target, RRType.A), 'A').map((x) => x.address);
  const live = a.map((x) => `A ${x}`);
  if (a.some((x) => web.includes(x))) return row(e, live, 'pass', `Resolves to ${target}’s address.`);
  return row(e, live, 'fail', `Resolves to ${a.join(', ')}, which is not ${target} (${web.length === 0 ? 'unresolved' : web.join(', ')}).`);
}

export interface CheckContext {
  readonly resolver: Resolver;
  readonly domain: string;
  /** Our EHLO / MX host, for SPF's %{h}. */
  readonly helo: string;
}

/** One expected record, checked live. Never throws: an unavailable resolver is `unknown`. */
export async function checkRecord(ctx: CheckContext, e: ExpectedRecord): Promise<CheckRow> {
  const { resolver } = ctx;
  try {
    const d = e.detail;
    switch (d.kind) {
      case 'mx':
        return await checkMx(resolver, e, d.host);
      case 'spf':
        return await checkSpf(resolver, e, d.ip, ctx.domain, ctx.helo, adaptDnsResolver(resolver));
      case 'dkim':
        return await checkDkim(resolver, e, d.publicKey);
      case 'dmarc':
        return await checkDmarc(resolver, e);
      case 'ptr':
        return await checkPtr(resolver, e, d.ip, d.host);
      case 'mta-sts':
        return await checkMtaSts(resolver, e);
      case 'tls-rpt':
        return await checkTlsRpt(resolver, e);
      case 'srv':
        return await checkSrv(resolver, e, d.port, d.target);
      case 'host':
        return await checkHost(resolver, e, d.target);
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return row(e, [], 'unknown', `The resolver did not answer (${why}), so this could not be checked. Try again.`);
  }
}

/** Every expected record, checked concurrently, in the expected order. */
export async function checkRecords(ctx: CheckContext, expected: readonly ExpectedRecord[]): Promise<CheckRow[]> {
  return Promise.all(expected.map((e) => checkRecord(ctx, e)));
}
