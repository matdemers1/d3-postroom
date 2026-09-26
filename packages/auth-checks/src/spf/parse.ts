// Term parsing for an SPF record, RFC 7208 SS12 (ABNF) and SS4-6 (semantics of each term).

import { SpfPermError } from './errors.js';
import { expandMacros, type MacroContext } from './macro.js';

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

/** A dummy context for macro-*syntax* validation only - its expanded values are never used, so
 * any well-formed values work. Used so a syntax error in a domain-spec (e.g. `%q`, or `%{c}`
 * used outside exp=) is caught eagerly, before evaluation, rather than only where it happens to
 * be expanded for real. */
const SYNTAX_CHECK_CTX: MacroContext = {
  sender: 'syntax-check@syntax-check.example',
  domain: 'syntax-check.example',
  ip: '0.0.0.0',
  ipVersion: 4,
  helo: 'syntax-check.example',
  inExp: false,
};

function assertMacroSyntax(text: string, label: string): void {
  try {
    expandMacros(text, SYNTAX_CHECK_CTX);
  } catch (err) {
    if (err instanceof SpfPermError) throw new SpfPermError(`invalid macro syntax in ${label}: ${text}`);
    throw err;
  }
}

/** RFC 7208 SS7.1: a domain-spec must end either in a macro-expansion (whose eventual value is
 * unknown until expanded) or in "." toplabel ["."], where toplabel is letters/digits/hyphens,
 * not all-numeric, and does not start or end with a hyphen. A bare single label with no dot at
 * all (e.g. "museum") never satisfies this, even with a trailing dot. */
function hasValidDomainEnd(raw: string): boolean {
  if (raw === '') return false;
  if (/%(?:\{[^}]*\}|%|_|-)$/.test(raw)) return true;
  const trimmed = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot === -1) return false;
  const toplabel = trimmed.slice(lastDot + 1);
  if (toplabel === '' || !/^[A-Za-z0-9-]+$/.test(toplabel)) return false;
  if (/^[0-9]+$/.test(toplabel)) return false;
  if (toplabel.startsWith('-') || toplabel.endsWith('-')) return false;
  return true;
}

function assertDomainSpec(spec: string, label: string): void {
  assertMacroSyntax(spec, label);
  if (!hasValidDomainEnd(spec)) {
    throw new SpfPermError(`invalid domain-spec in ${label} (must end in a macro-expand or a valid top-label): ${spec}`);
  }
}

/** Strip a trailing dual-cidr-length ("/n" and/or "//n6") from an a/mx argument's tail, working
 * from the end so that a domain-spec legitimately containing "/" (RFC 7208 SS7.1: "any visible
 * character other than '%'") is only ever mistaken for a cidr-length when it ends in one. */
function stripTrailingDualCidr(body: string): { domain: string; ip4Prefix: number; ip6Prefix: number } {
  let rest = body;
  let ip6Prefix = 128;
  let ip4Prefix = 32;
  const v6 = /\/\/(\d{1,3})$/.exec(rest);
  if (v6 !== null) {
    ip6Prefix = Number(v6[1]);
    if (ip6Prefix > 128) throw new SpfPermError(`ip6 cidr length out of range: ${body}`);
    rest = rest.slice(0, -v6[0].length);
  }
  const v4 = /\/(\d{1,3})$/.exec(rest);
  if (v4 !== null) {
    ip4Prefix = Number(v4[1]);
    if (ip4Prefix > 32) throw new SpfPermError(`ip4 cidr length out of range: ${body}`);
    rest = rest.slice(0, -v4[0].length);
  }
  return { domain: rest, ip4Prefix, ip6Prefix };
}

function parseAOrMxTail(tail: string, label: string): { domainSpec?: string | undefined; ip4Prefix: number; ip6Prefix: number } {
  if (tail === '') return { domainSpec: undefined, ip4Prefix: 32, ip6Prefix: 128 };
  if (tail.startsWith('/')) {
    // No domain-spec, just a dual-cidr-length: "/n" and/or "//n6".
    const { domain, ip4Prefix, ip6Prefix } = stripTrailingDualCidr(tail);
    if (domain !== '') throw new SpfPermError(`invalid dual-cidr-length in ${label}: ${tail}`);
    return { domainSpec: undefined, ip4Prefix, ip6Prefix };
  }
  if (!tail.startsWith(':')) throw new SpfPermError(`invalid ${label}: ${tail}`);
  const body = tail.slice(1);
  if (body === '') throw new SpfPermError(`empty domain-spec in ${label}`);
  const { domain, ip4Prefix, ip6Prefix } = stripTrailingDualCidr(body);
  if (domain === '') throw new SpfPermError(`empty domain-spec in ${label}`);
  assertDomainSpec(domain, label);
  return { domainSpec: domain, ip4Prefix, ip6Prefix };
}

export function parseTerm(token: string): Term {
  if (token === '') throw new SpfPermError('empty term');

  const modMatch = /^([A-Za-z][A-Za-z0-9_.-]*)=(.*)$/.exec(token);
  if (modMatch) {
    const name = modMatch[1] ?? '';
    const value = modMatch[2] ?? '';
    if (value === '') throw new SpfPermError(`empty value for modifier ${name}`);
    const lower = name.toLowerCase();
    if (lower === 'redirect') {
      assertDomainSpec(value, 'redirect=');
      return { kind: 'modifier', modifier: { type: 'redirect', domainSpec: value } };
    }
    if (lower === 'exp') {
      assertDomainSpec(value, 'exp=');
      return { kind: 'modifier', modifier: { type: 'exp', domainSpec: value } };
    }
    // unknown-modifier = name "=" macro-string: no domain-end requirement, but the macro syntax
    // itself must still be valid (RFC 7208 SS12, "A/3" of the real conformance suite).
    assertMacroSyntax(value, `modifier ${name}=`);
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
      const domainSpec = tail.slice(1);
      assertDomainSpec(domainSpec, 'include:');
      return { kind: 'mechanism', mechanism: { type: 'include', qualifier, domainSpec } };
    }
    case 'exists': {
      if (!tail.startsWith(':') || tail.length <= 1) throw new SpfPermError(`exists requires a domain-spec: ${token}`);
      const domainSpec = tail.slice(1);
      assertDomainSpec(domainSpec, 'exists:');
      return { kind: 'mechanism', mechanism: { type: 'exists', qualifier, domainSpec } };
    }
    case 'ptr': {
      if (tail === '') return { kind: 'mechanism', mechanism: { type: 'ptr', qualifier } };
      if (!tail.startsWith(':') || tail.length <= 1) throw new SpfPermError(`invalid ptr argument: ${token}`);
      const domainSpec = tail.slice(1);
      assertDomainSpec(domainSpec, 'ptr:');
      return { kind: 'mechanism', mechanism: { type: 'ptr', qualifier, domainSpec } };
    }
    case 'ip4': {
      if (!tail.startsWith(':')) throw new SpfPermError(`ip4 requires a network: ${token}`);
      const body = tail.slice(1);
      const parts = body.split('/');
      if (parts.length > 2) throw new SpfPermError(`ip4 does not take a dual-cidr-length: ${token}`);
      const ip = parts[0] ?? '';
      const cidrStr = parts[1];
      if (ip === '' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        throw new SpfPermError(`invalid ip4 network: ${token}`);
      }
      let prefix = 32;
      if (cidrStr !== undefined) {
        if (!/^(?:0|[1-9]\d?)$/.test(cidrStr)) throw new SpfPermError(`invalid ip4 cidr length: ${token}`);
        prefix = Number(cidrStr);
        if (prefix > 32) throw new SpfPermError(`ip4 cidr length out of range: ${token}`);
      }
      return { kind: 'mechanism', mechanism: { type: 'ip4', qualifier, ip, prefix } };
    }
    case 'ip6': {
      if (!tail.startsWith(':')) throw new SpfPermError(`ip6 requires a network: ${token}`);
      const body = tail.slice(1);
      const parts = body.split('/');
      if (parts.length > 2) throw new SpfPermError(`ip6 does not take a dual-cidr-length: ${token}`);
      const ip = parts[0] ?? '';
      const cidrStr = parts[1];
      if (ip === '') throw new SpfPermError(`empty ip6 network: ${token}`);
      let prefix = 128;
      if (cidrStr !== undefined) {
        if (!/^(?:0|[1-9]\d{0,2})$/.test(cidrStr)) throw new SpfPermError(`invalid ip6 cidr length: ${token}`);
        prefix = Number(cidrStr);
        if (prefix > 128) throw new SpfPermError(`ip6 cidr length out of range: ${token}`);
      }
      return { kind: 'mechanism', mechanism: { type: 'ip6', qualifier, ip, prefix } };
    }
    case 'a': {
      const { domainSpec, ip4Prefix, ip6Prefix } = parseAOrMxTail(tail, 'a');
      return { kind: 'mechanism', mechanism: { type: 'a', qualifier, domainSpec, ip4Prefix, ip6Prefix } };
    }
    case 'mx': {
      const { domainSpec, ip4Prefix, ip6Prefix } = parseAOrMxTail(tail, 'mx');
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

/** RFC 7208 SS3.1: SPF records are 7-bit US-ASCII; a control character or any byte outside the
 * printable range is a syntax error wherever it appears in the record, not just where a
 * mechanism happens to notice it. Term separation (SS4.6.1) is one-or-more literal SP (0x20),
 * not general whitespace - a bare CR or LF between terms is exactly this same error. */
function assertPrintableAscii(text: string): void {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      throw new SpfPermError('SPF records are restricted to printable 7-bit ASCII (RFC 7208 SS3.1)');
    }
  }
}

export function parseRecord(record: string): Term[] {
  const m = /^v=spf1(?:$| (.*))?$/i.exec(record);
  if (!m) throw new SpfPermError('record does not begin with v=spf1');
  const rest = m[1] ?? '';
  assertPrintableAscii(rest);
  const tokens = rest.split(/ +/).filter((t) => t !== '');
  return tokens.map(parseTerm);
}
