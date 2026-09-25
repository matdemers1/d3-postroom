// Macro expansion examples in the style of RFC 7208 Appendix D/E: sender
// strong-bad@email.example.com, and separately IP 192.0.2.3 (IPv4) and 2001:db8::cb01 (IPv6).
// These are RECOMPUTED from the SS7.3 algorithm (split on delimiters, keep the right-most
// `digits` parts, then reverse, then join with "."), not copied from the RFC's own table (no
// network access here) - see the task notes for the honest accounting.

import type { MacroContext } from '../../../../src/spf/macro.js';

const baseCtx = {
  sender: 'strong-bad@email.example.com',
  domain: 'email.example.com',
  helo: 'email.example.com',
  inExp: false,
} as const;

export interface MacroExampleCase {
  name: string;
  template: string;
  ctx: MacroContext;
  expected: string;
}

const v4Ctx: MacroContext = { ...baseCtx, ip: '192.0.2.3', ipVersion: 4 };
const v6Ctx: MacroContext = { ...baseCtx, ip: '2001:db8::cb01', ipVersion: 6 };

export const macroExampleCases: MacroExampleCase[] = [
  { name: '%{s}', template: '%{s}', ctx: v4Ctx, expected: 'strong-bad@email.example.com' },
  { name: '%{o}', template: '%{o}', ctx: v4Ctx, expected: 'email.example.com' },
  { name: '%{d}', template: '%{d}', ctx: v4Ctx, expected: 'email.example.com' },
  { name: '%{d4}', template: '%{d4}', ctx: v4Ctx, expected: 'email.example.com' },
  { name: '%{d3}', template: '%{d3}', ctx: v4Ctx, expected: 'email.example.com' },
  { name: '%{d2}', template: '%{d2}', ctx: v4Ctx, expected: 'example.com' },
  { name: '%{d1}', template: '%{d1}', ctx: v4Ctx, expected: 'com' },
  { name: '%{dr}', template: '%{dr}', ctx: v4Ctx, expected: 'com.example.email' },
  { name: '%{d2r}', template: '%{d2r}', ctx: v4Ctx, expected: 'com.example' },
  { name: '%{l}', template: '%{l}', ctx: v4Ctx, expected: 'strong-bad' },
  { name: '%{l-}', template: '%{l-}', ctx: v4Ctx, expected: 'strong.bad' },
  { name: '%{lr}', template: '%{lr}', ctx: v4Ctx, expected: 'strong-bad' },
  { name: '%{lr-}', template: '%{lr-}', ctx: v4Ctx, expected: 'bad.strong' },
  { name: '%{l1r-}', template: '%{l1r-}', ctx: v4Ctx, expected: 'bad' },
  {
    name: 'IPv4 SPF classic query name',
    template: '%{ir}.%{v}._spf.%{d2}',
    ctx: v4Ctx,
    expected: '3.2.0.192.in-addr._spf.example.com',
  },
  {
    name: 'local-part-keyed query name',
    template: '%{lr-}.lp._spf.%{d2}',
    ctx: v4Ctx,
    expected: 'bad.strong.lp._spf.example.com',
  },
  {
    name: 'local-part and IP keyed query name',
    template: '%{lr-}.lp.%{ir}.%{v}._spf.%{d2}',
    ctx: v4Ctx,
    expected: 'bad.strong.lp.3.2.0.192.in-addr._spf.example.com',
  },
  {
    name: 'domain-anchored trusted-domains query',
    template: '%{d2}.trusted-domains.example.net',
    ctx: v4Ctx,
    expected: 'example.com.trusted-domains.example.net',
  },
  {
    name: 'IP and truncated-local-part keyed query name',
    template: '%{ir}.%{v}.%{l1r-}.lp._spf.%{d2}',
    ctx: v4Ctx,
    expected: '3.2.0.192.in-addr.bad.lp._spf.example.com',
  },
  {
    name: 'IPv6 SPF classic query name (32 dot-separated nibbles, reversed)',
    template: '%{ir}.%{v}._spf.%{d2}',
    ctx: v6Ctx,
    expected: '1.0.b.c.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6._spf.example.com',
  },
];
