// Term parsing for an SPF record, RFC 7208 SS12 (ABNF) and SS4-6 (semantics of each term).

import { SpfPermError } from './errors.js';

export type Qualifier = '+' | '-' | '~' | '?';

export interface AllMechanism {
  type: 'all';
  qualifier: Qualifier;
}
export interface IncludeMechanism {
  type: 'include';
  qualifier: Qualifier;
  domainSpec: string;
}
export interface AMechanism {
  type: 'a';
  qualifier: Qualifier;
  domainSpec?: string | undefined;
  ip4Prefix: number;
  ip6Prefix: number;
}
export interface MxMechanism {
  type: 'mx';
  qualifier: Qualifier;
  domainSpec?: string | undefined;
  ip4Prefix: number;
  ip6Prefix: number;
}
export interface PtrMechanism {
  type: 'ptr';
  qualifier: Qualifier;
  domainSpec?: string | undefined;
}
export interface Ip4Mechanism {
  type: 'ip4';
  qualifier: Qualifier;
  ip: string;
  prefix: number;
}
export interface Ip6Mechanism {
  type: 'ip6';
  qualifier: Qualifier;
  ip: string;
  prefix: number;
}
export interface ExistsMechanism {
  type: 'exists';
  qualifier: Qualifier;
  domainSpec: string;
}

export type Mechanism =
  | AllMechanism
  | IncludeMechanism
  | AMechanism
  | MxMechanism
  | PtrMechanism
  | Ip4Mechanism
  | Ip6Mechanism
  | ExistsMechanism;

export interface RedirectModifier {
  type: 'redirect';
  domainSpec: string;
}
export interface ExpModifier {
  type: 'exp';
  domainSpec: string;
}
export interface UnknownModifier {
  type: 'unknown';
  name: string;
  value: string;
}

export type Modifier = RedirectModifier | ExpModifier | UnknownModifier;

export type Term = { kind: 'mechanism'; mechanism: Mechanism } | { kind: 'modifier'; modifier: Modifier };

function stripQualifier(token: string): { qualifier: Qualifier; rest: string } {
  const first = token[0];
  if (first === '+' || first === '-' || first === '~' || first === '?') {
    return { qualifier: first, rest: token.slice(1) };
  }
  return { qualifier: '+', rest: token };
}

const MECHANISM_KEYWORDS = ['include', 'exists', 'ip4', 'ip6', 'all', 'ptr', 'mx', 'a'] as const;

function parseAOrMxTail(tail: string): { domainSpec?: string | undefined; ip4Prefix: number; ip6Prefix: number } {
  const m = /^(?::(?<domain>[^/]+))?(?:\/(?<v4>\d{1,3}))?(?:\/\/(?<v6>\d{1,3}))?$/.exec(tail);
  if (!m) throw new SpfPermError(`invalid a/mx argument: ${tail}`);
  const domain = m.groups?.['domain'];
  const v4raw = m.groups?.['v4'];
  const v6raw = m.groups?.['v6'];
  const ip4Prefix = v4raw !== undefined ? Number(v4raw) : 32;
  const ip6Prefix = v6raw !== undefined ? Number(v6raw) : 128;
  if (ip4Prefix > 32 || ip6Prefix > 128) throw new SpfPermError(`cidr length out of range: ${tail}`);
  if (domain === '') throw new SpfPermError('empty domain-spec');
  return { domainSpec: domain, ip4Prefix, ip6Prefix };
}

export function parseTerm(token: string): Term {
  if (token === '') throw new SpfPermError('empty term');

  const modMatch = /^([A-Za-z][A-Za-z0-9_.]*)=(.*)$/.exec(token);
  if (modMatch) {
    const name = modMatch[1] ?? '';
    const value = modMatch[2] ?? '';
    if (value === '') throw new SpfPermError(`empty value for modifier ${name}`);
    const lower = name.toLowerCase();
    if (lower === 'redirect') return { kind: 'modifier', modifier: { type: 'redirect', domainSpec: value } };
    if (lower === 'exp') return { kind: 'modifier', modifier: { type: 'exp', domainSpec: value } };
    return { kind: 'modifier', modifier: { type: 'unknown', name, value } };
  }

  const { qualifier, rest } = stripQualifier(token);
  let keyword: (typeof MECHANISM_KEYWORDS)[number] | undefined;
  for (const kw of MECHANISM_KEYWORDS) {
    if (rest === kw || rest.startsWith(`${kw}:`) || rest.startsWith(`${kw}/`)) {
      keyword = kw;
      break;
    }
  }
  if (keyword === undefined) throw new SpfPermError(`unrecognized term: ${token}`);
  const tail = rest.slice(keyword.length);

  switch (keyword) {
    case 'all': {
      if (tail !== '') throw new SpfPermError(`"all" takes no argument: ${token}`);
      return { kind: 'mechanism', mechanism: { type: 'all', qualifier } };
    }
    case 'include': {
      if (!tail.startsWith(':') || tail.length <= 1) throw new SpfPermError(`include requires a domain-spec: ${token}`);
      return { kind: 'mechanism', mechanism: { type: 'include', qualifier, domainSpec: tail.slice(1) } };
    }
    case 'exists': {
      if (!tail.startsWith(':') || tail.length <= 1) throw new SpfPermError(`exists requires a domain-spec: ${token}`);
      return { kind: 'mechanism', mechanism: { type: 'exists', qualifier, domainSpec: tail.slice(1) } };
    }
    case 'ptr': {
      if (tail === '') return { kind: 'mechanism', mechanism: { type: 'ptr', qualifier } };
      if (!tail.startsWith(':') || tail.length <= 1) throw new SpfPermError(`invalid ptr argument: ${token}`);
      return { kind: 'mechanism', mechanism: { type: 'ptr', qualifier, domainSpec: tail.slice(1) } };
    }
    case 'ip4': {
      if (!tail.startsWith(':')) throw new SpfPermError(`ip4 requires a network: ${token}`);
      const body = tail.slice(1);
      const [ip, cidr] = body.split('/');
      if (ip === undefined || ip === '') throw new SpfPermError(`invalid ip4 network: ${token}`);
      const prefix = cidr === undefined ? 32 : Number(cidr);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        throw new SpfPermError(`invalid ip4 network: ${token}`);
      }
      return { kind: 'mechanism', mechanism: { type: 'ip4', qualifier, ip, prefix } };
    }
    case 'ip6': {
      if (!tail.startsWith(':')) throw new SpfPermError(`ip6 requires a network: ${token}`);
      const body = tail.slice(1);
      const lastSlash = body.lastIndexOf('/');
      const hasCidr = lastSlash !== -1 && !body.includes('::', lastSlash) && /^\d+$/.test(body.slice(lastSlash + 1));
      const ip = hasCidr ? body.slice(0, lastSlash) : body;
      const cidr = hasCidr ? body.slice(lastSlash + 1) : undefined;
      const prefix = cidr === undefined ? 128 : Number(cidr);
      if (ip === '' || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
        throw new SpfPermError(`invalid ip6 network: ${token}`);
      }
      return { kind: 'mechanism', mechanism: { type: 'ip6', qualifier, ip, prefix } };
    }
    case 'a': {
      const { domainSpec, ip4Prefix, ip6Prefix } = parseAOrMxTail(tail);
      return { kind: 'mechanism', mechanism: { type: 'a', qualifier, domainSpec, ip4Prefix, ip6Prefix } };
    }
    case 'mx': {
      const { domainSpec, ip4Prefix, ip6Prefix } = parseAOrMxTail(tail);
      return { kind: 'mechanism', mechanism: { type: 'mx', qualifier, domainSpec, ip4Prefix, ip6Prefix } };
    }
  }
}

/** Select the single "v=spf1" record among a domain's TXT records (RFC 7208 SS4.5). Zero
 * matches is not an error - it is reported by the caller as the "none" result. */
export const NO_SPF_RECORD = Symbol('no-spf-record');

export function selectSpfRecord(txtRecords: string[]): string | typeof NO_SPF_RECORD {
  const matches = txtRecords.filter((r) => /^v=spf1(?:$| )/i.test(r));
  if (matches.length === 0) return NO_SPF_RECORD;
  if (matches.length > 1) throw new SpfPermError('multiple v=spf1 records');
  return matches[0] ?? NO_SPF_RECORD;
}

export function parseRecord(record: string): Term[] {
  const m = /^v=spf1(?:$| (.*))?$/i.exec(record);
  if (!m) throw new SpfPermError('record does not begin with v=spf1');
  const rest = m[1] ?? '';
  const tokens = rest.split(/\s+/).filter((t) => t !== '');
  return tokens.map(parseTerm);
}
