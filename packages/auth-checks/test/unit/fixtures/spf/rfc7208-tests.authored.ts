// Postroom-authored RFC 7208 conformance cases (not upstream content), organised the way the
// canonical OpenSPF "rfc7208-tests.yml" (Stuart Gathman / pyspf) is organised by section. These
// were written from RFC 7208's own text (SS4-SS7, SS4.6.4) before the real upstream suite was
// available in this environment - it now lives at rfc7208-tests.upstream.json/.yml and runs in
// full via ../spf-rfc7208-upstream.test.ts. This file is kept because spf-fuzz.test.ts and
// spf-dns-adapter.test.ts still build on zone-dns.ts, and because its cases read more like
// documentation of *why* each RFC section behaves the way it does.

import type { SpfResult } from '../../../../src/spf/types.js';
import type { SpfZone } from './zone-dns.js';

export interface RfcTestCase {
  section: string;
  name: string;
  zone: SpfZone;
  ptrZone?: Record<string, string[]>;
  ip: string;
  mailFrom?: string | null;
  helo?: string;
  result: SpfResult;
  explanation?: string;
}

export const rfc7208TestCases: RfcTestCase[] = [
  // ---- initial processing (RFC 7208 SS4.1, SS4.3) ----
  {
    section: 'initial-processing',
    name: 'null MAIL FROM uses postmaster@HELO as the identity',
    zone: { 'example.com': { txt: ['v=spf1 -all'] } },
    ip: '1.2.3.4',
    mailFrom: null,
    helo: 'example.com',
    result: 'fail',
  },
  {
    section: 'initial-processing',
    name: 'MAIL FROM with an empty local-part is treated as postmaster',
    zone: { 'example.com': { txt: ['v=spf1 +all'] } },
    ip: '1.2.3.4',
    mailFrom: '@example.com',
    helo: 'mail.example.com',
    result: 'pass',
  },

  // ---- record lookup (SS4.4) ----
  {
    section: 'record-lookup',
    name: 'no TXT records at all is "none", not an error',
    zone: { 'example.com': {} },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'none',
  },
  {
    section: 'record-lookup',
    name: 'SERVFAIL fetching the TXT record is a temperror',
    zone: { 'example.com': 'SERVFAIL' },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'temperror',
  },

  // ---- selecting records (SS4.5) ----
  {
    section: 'selecting-records',
    name: 'more than one v=spf1 record is a permerror',
    zone: { 'example.com': { txt: ['v=spf1 -all', 'v=spf1 +all'] } },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'permerror',
  },
  {
    section: 'selecting-records',
    name: 'the v=spf1 record is picked out from unrelated TXT strings',
    zone: { 'example.com': { txt: ['unrelated=1', 'v=spf1 +all'] } },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'pass',
  },

  // ---- record evaluation (SS4.6): first match wins, left to right ----
  {
    section: 'record-evaluation',
    name: 'the first matching mechanism decides the result',
    zone: { 'example.com': { txt: ['v=spf1 -all ip4:9.9.9.9'] } },
    ip: '9.9.9.9',
    mailFrom: 'user@example.com',
    result: 'fail',
  },

  // ---- ALL (SS5.1) ----
  { section: 'all', name: '"all" with the default "+" qualifier passes', zone: { 'example.com': { txt: ['v=spf1 all'] } }, ip: '1.2.3.4', mailFrom: 'user@example.com', result: 'pass' },
  { section: 'all', name: '"-all" fails', zone: { 'example.com': { txt: ['v=spf1 -all'] } }, ip: '1.2.3.4', mailFrom: 'user@example.com', result: 'fail' },
  { section: 'all', name: '"~all" softfails', zone: { 'example.com': { txt: ['v=spf1 ~all'] } }, ip: '1.2.3.4', mailFrom: 'user@example.com', result: 'softfail' },
  { section: 'all', name: '"?all" is neutral', zone: { 'example.com': { txt: ['v=spf1 ?all'] } }, ip: '1.2.3.4', mailFrom: 'user@example.com', result: 'neutral' },
  {
    section: 'all',
    name: 'falling off the end of the record with no terms is neutral',
    zone: { 'example.com': { txt: ['v=spf1'] } },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'neutral',
  },

  // ---- PTR (SS5.5, deprecated but still evaluated) ----
  {
    section: 'ptr',
    name: 'a forward-confirmed PTR name under the domain passes',
    zone: {
      'example.com': { txt: ['v=spf1 ptr -all'] },
      'mail.example.com': { a: ['5.5.5.5'] },
    },
    ptrZone: { '5.5.5.5': ['mail.example.com'] },
    ip: '5.5.5.5',
    mailFrom: 'user@example.com',
    result: 'pass',
  },
  {
    section: 'ptr',
    name: 'a PTR name outside the domain does not match, falls through to -all',
    zone: {
      'example.com': { txt: ['v=spf1 ptr -all'] },
      'mail.other.com': { a: ['5.5.5.5'] },
    },
    ptrZone: { '5.5.5.5': ['mail.other.com'] },
    ip: '5.5.5.5',
    mailFrom: 'user@example.com',
    result: 'fail',
  },

  // ---- A (SS5.3) ----
  {
    section: 'a',
    name: 'the domain\'s own A record matches exactly',
    zone: { 'example.com': { txt: ['v=spf1 a -all'], a: ['10.0.0.1'] } },
    ip: '10.0.0.1',
    mailFrom: 'user@example.com',
    result: 'pass',
  },
  {
    section: 'a',
    name: 'a dual-cidr-length on "a" matches the whole /24',
    zone: { 'example.com': { txt: ['v=spf1 a/24 -all'], a: ['10.0.0.1'] } },
    ip: '10.0.0.99',
    mailFrom: 'user@example.com',
    result: 'pass',
  },
  {
    section: 'a',
    name: 'no A record at all is a void lookup, mechanism does not match',
    zone: { 'example.com': { txt: ['v=spf1 a -all'] } },
    ip: '10.0.0.1',
    mailFrom: 'user@example.com',
    result: 'fail',
  },

  // ---- include (SS5.2) ----
  {
    section: 'include',
    name: 'include of a domain that passes makes the include match',
    zone: {
      'example.com': { txt: ['v=spf1 include:included.example -all'] },
      'included.example': { txt: ['v=spf1 +all'] },
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'pass',
  },
  {
    section: 'include',
    name: 'include of a domain that fails does not match; evaluation continues',
    zone: {
      'example.com': { txt: ['v=spf1 include:included.example ip4:9.9.9.9 -all'] },
      'included.example': { txt: ['v=spf1 -all'] },
    },
    ip: '9.9.9.9',
    mailFrom: 'user@example.com',
    result: 'pass',
  },
  {
    section: 'include',
    name: 'include of a domain with no SPF record is a permerror',
    zone: {
      'example.com': { txt: ['v=spf1 include:missing.example -all'] },
      'missing.example': {},
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'permerror',
  },

  // ---- MX (SS5.4) ----
  {
    section: 'mx',
    name: 'mx matches the second-preference exchange',
    zone: {
      'example.com': {
        txt: ['v=spf1 mx -all'],
        mx: [
          { preference: 20, exchange: 'mx2.example.com' },
          { preference: 10, exchange: 'mx1.example.com' },
        ],
      },
      'mx1.example.com': { a: ['1.1.1.1'] },
      'mx2.example.com': { a: ['2.2.2.2'] },
    },
    ip: '2.2.2.2',
    mailFrom: 'user@example.com',
    result: 'pass',
  },
  {
    section: 'mx',
    name: 'more than 10 MX records is a permerror (SS4.6.4)',
    zone: {
      'example.com': {
        txt: ['v=spf1 mx -all'],
        mx: Array.from({ length: 11 }, (_, i) => ({ preference: i, exchange: `mx${String(i)}.example.com` })),
      },
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'permerror',
  },

  // ---- EXISTS (SS5.7) ----
  {
    section: 'exists',
    name: 'a resolvable sentinel name makes exists match',
    zone: {
      'example.com': { txt: ['v=spf1 exists:sentinel.example.com -all'] },
      'sentinel.example.com': { a: ['127.0.0.2'] },
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'pass',
  },
  {
    section: 'exists',
    name: 'a non-resolvable sentinel name does not match',
    zone: {
      'example.com': { txt: ['v=spf1 exists:sentinel.example.com -all'] },
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'fail',
  },

  // ---- IP4 (SS5.6) ----
  { section: 'ip4', name: 'exact /32 match', zone: { 'example.com': { txt: ['v=spf1 ip4:192.0.2.1 -all'] } }, ip: '192.0.2.1', mailFrom: 'user@example.com', result: 'pass' },
  { section: 'ip4', name: 'cidr match', zone: { 'example.com': { txt: ['v=spf1 ip4:192.0.2.0/24 -all'] } }, ip: '192.0.2.200', mailFrom: 'user@example.com', result: 'pass' },
  { section: 'ip4', name: 'no match falls through to -all', zone: { 'example.com': { txt: ['v=spf1 ip4:192.0.2.0/24 -all'] } }, ip: '198.51.100.1', mailFrom: 'user@example.com', result: 'fail' },
  { section: 'ip4', name: 'a malformed network is a permerror', zone: { 'example.com': { txt: ['v=spf1 ip4:bad -all'] } }, ip: '192.0.2.1', mailFrom: 'user@example.com', result: 'permerror' },

  // ---- IP6 (SS5.6) ----
  { section: 'ip6', name: 'exact match', zone: { 'example.com': { txt: ['v=spf1 ip6:2001:db8::1 -all'] } }, ip: '2001:db8::1', mailFrom: 'user@example.com', result: 'pass' },
  { section: 'ip6', name: 'cidr match', zone: { 'example.com': { txt: ['v=spf1 ip6:2001:db8::/32 -all'] } }, ip: '2001:db8:1234::5', mailFrom: 'user@example.com', result: 'pass' },
  {
    section: 'ip6',
    name: 'an IPv4 client never matches an ip6 mechanism',
    zone: { 'example.com': { txt: ['v=spf1 ip6:2001:db8::/32 -all'] } },
    ip: '192.0.2.1',
    mailFrom: 'user@example.com',
    result: 'fail',
  },

  // ---- semantics of exp= and other modifiers (SS6) ----
  {
    section: 'modifiers',
    name: 'exp= is resolved and macro-expanded on a matching fail',
    zone: {
      'example.com': { txt: ['v=spf1 -all exp=explain.example.com'] },
      'explain.example.com': { txt: ['Denied for %{i}'] },
    },
    ip: '10.20.30.40',
    mailFrom: 'user@example.com',
    result: 'fail',
    explanation: 'Denied for 10.20.30.40',
  },
  {
    section: 'modifiers',
    name: 'an unrecognized modifier is ignored',
    zone: { 'example.com': { txt: ['v=spf1 foo=bar +all'] } },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'pass',
  },
  {
    section: 'modifiers',
    name: 'redirect= hands evaluation to another domain\'s record',
    zone: {
      'example.com': { txt: ['v=spf1 redirect=redirected.example'] },
      'redirected.example': { txt: ['v=spf1 -all'] },
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'fail',
  },
  {
    section: 'modifiers',
    name: 'redirect= to a domain with no SPF record is a permerror',
    zone: {
      'example.com': { txt: ['v=spf1 redirect=missing.example'] },
      'missing.example': {},
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'permerror',
  },

  // ---- processing limits (SS4.6.4) ----
  {
    section: 'processing-limits',
    name: 'an 11th DNS-querying term exceeds the 10-lookup limit',
    zone: {
      'example.com': {
        txt: [`v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:i${String(i)}.example`).join(' ')} -all`],
      },
      ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`i${String(i)}.example`, { txt: ['v=spf1 ?all'] }])),
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'permerror',
  },
  {
    section: 'processing-limits',
    name: 'a third void lookup exceeds the 2-void-lookup limit',
    zone: {
      'example.com': { txt: ['v=spf1 a:void1.example a:void2.example a:void3.example -all'] },
    },
    ip: '1.2.3.4',
    mailFrom: 'user@example.com',
    result: 'permerror',
  },
];
