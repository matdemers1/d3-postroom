import { domainToASCII } from 'node:url';

// Addresses and domains are stored lowercased; the migration CHECK-enforces it. These are the one
// place that decides what "lowercased" means, so every surface stores the same spelling.

/** Lowercase, trim, drop one trailing root dot, and convert an IDN to its ASCII (punycode) form. */
export function normalizeDomain(input: string): string {
  let name = input.trim().toLowerCase();
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (name.length === 0) throw new Error('empty domain name');
  const ascii = domainToASCII(name);
  if (ascii.length === 0) throw new Error(`invalid domain name: ${input}`);
  return ascii;
}

/** Lowercase and trim a local part. Postroom treats local parts case-insensitively. */
export function normalizeLocalPart(input: string): string {
  const local = input.trim().toLowerCase();
  if (local.length === 0) throw new Error('empty local part');
  if (local.includes('@')) throw new Error(`local part contains '@': ${input}`);
  return local;
}

export interface ParsedAddress {
  readonly localPart: string;
  readonly domain: string;
}

/** Split `local@domain` at the last '@' and normalise both halves. */
export function parseAddress(input: string): ParsedAddress {
  const at = input.lastIndexOf('@');
  if (at <= 0 || at === input.length - 1) throw new Error(`not an address: ${input}`);
  return {
    localPart: normalizeLocalPart(input.slice(0, at)),
    domain: normalizeDomain(input.slice(at + 1)),
  };
}

/** A random UIDVALIDITY: a positive signed 32-bit integer, as the mailbox CHECK requires. */
export function randomUidValidity(random: (min: number, max: number) => number): number {
  return random(1, 2 ** 31);
}
