// Adapts @postroom/dns's Resolver to the narrow SpfDns interface the evaluator is written
// against. A temporary resolver failure (SERVFAIL, timeout, malformed response) becomes an
// SpfTempError; NXDOMAIN becomes a void lookup with no records, never a thrown error.

import { DnsProtocolError, DnsServfailError, DnsTimeoutError, RCode } from '@postroom/dns';
import type { DnsAnswer, Resolver } from '@postroom/dns';
import { SpfTempError } from './errors.js';
import type { SpfDns, SpfLookupResult, SpfMxRecord } from './types.js';

async function run<T>(
  query: () => Promise<{ rcode: number; answers: DnsAnswer[] }>,
  extract: (answers: DnsAnswer[]) => T[],
): Promise<SpfLookupResult<T>> {
  let response: { rcode: number; answers: DnsAnswer[] };
  try {
    response = await query();
  } catch (err) {
    if (err instanceof DnsServfailError || err instanceof DnsTimeoutError || err instanceof DnsProtocolError) {
      throw new SpfTempError(err.message);
    }
    throw err;
  }
  if (response.rcode === RCode.NXDOMAIN) {
    return { records: [], void: true };
  }
  if (response.rcode !== RCode.NOERROR) {
    throw new SpfTempError(`unexpected DNS rcode ${String(response.rcode)}`);
  }
  const records = extract(response.answers);
  return { records, void: records.length === 0 };
}

function txtOf(answers: DnsAnswer[]): string[] {
  return answers.filter((a): a is Extract<DnsAnswer, { kind: 'TXT' }> => a.kind === 'TXT').map((a) => a.text);
}
function aOf(answers: DnsAnswer[]): string[] {
  return answers.filter((a): a is Extract<DnsAnswer, { kind: 'A' }> => a.kind === 'A').map((a) => a.address);
}
function aaaaOf(answers: DnsAnswer[]): string[] {
  return answers.filter((a): a is Extract<DnsAnswer, { kind: 'AAAA' }> => a.kind === 'AAAA').map((a) => a.address);
}
function mxOf(answers: DnsAnswer[]): SpfMxRecord[] {
  return answers
    .filter((a): a is Extract<DnsAnswer, { kind: 'MX' }> => a.kind === 'MX')
    .map((a) => ({ preference: a.preference, exchange: a.exchange }));
}
function ptrOf(answers: DnsAnswer[]): string[] {
  return answers.filter((a): a is Extract<DnsAnswer, { kind: 'PTR' }> => a.kind === 'PTR').map((a) => a.target);
}

export function adaptDnsResolver(resolver: Resolver): SpfDns {
  return {
    txt: (name) => run(() => resolver.txt(name), txtOf),
    a: (name) => run(() => resolver.a(name), aOf),
    aaaa: (name) => run(() => resolver.aaaa(name), aaaaOf),
    mx: (name) => run(() => resolver.mx(name), mxOf),
    ptr: (ip) => run(() => resolver.ptr(ip), ptrOf),
  };
}
