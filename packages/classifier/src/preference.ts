// Sender preferences recorded by a sorting correction (PST-T-14.9, PST-ADR-011). A preference is a
// sender pin (PST-REQ-105) on either the From address or the whole sending domain, stored in the
// same sender_pin table: a domain preference's address is "@domain". The classify stage looks the
// address up first and falls back to the domain, so a person-level choice always beats a domain one.
//
// "Always put github.com in Notifications" is a domain preference; "Always put jane@gmail.com in
// People" is an address one — a domain preference on a mailbox provider would sweep up everyone
// who uses it, so those domains only ever get address preferences.

import { normalizeAddress } from './signals.js';

/** Domains shared by unrelated people: a preference there is always on the address. */
const SHARED_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'fastmail.com',
  'fastmail.fm',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'hey.com',
  'tuta.io',
  'tutanota.com',
  'comcast.net',
  'verizon.net',
  'att.net',
]);

/** The sender_pin key of a domain preference: "@domain", or null when there is no domain. */
export function domainPreferenceKey(address: string): string | null {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf('@');
  if (at < 0) return null;
  const domain = normalized.slice(at + 1);
  return domain === '' ? null : `@${domain}`;
}

/** True for a key written by domainPreferenceKey. */
export function isDomainPreference(key: string): boolean {
  return key.startsWith('@') && key.length > 1 && !key.slice(1).includes('@');
}

/**
 * Whether "Always put <sender or domain> in <bucket>" should offer the domain: only for automated
 * buckets (a person's own mail is never routed by their domain), and never for a mailbox provider.
 */
export function prefersDomain(address: string, bucket: string): boolean {
  if (bucket === 'priority' || bucket === 'people') return false;
  const key = domainPreferenceKey(address);
  if (key === null) return false;
  return !SHARED_DOMAINS.has(key.slice(1));
}
