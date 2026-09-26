// A test-only DKIM signer that writes whatever tags a fixture needs — rsa-sha1, l=, i=, x=, 512-bit
// keys — none of which the production signer (sign.ts) will produce. It shares canonicalization and
// the header-hash construction with the package, and the production signer is used wherever it can
// express the fixture.

import { createHash, sign, type KeyObject } from 'node:crypto';
import {
  canonicalizeBody,
  headerHashInput,
  parseHeaderFields,
  type Canonicalization,
  type DkimDns,
} from '../../../../src/index.js';

export type ForgeAlgorithm = 'rsa-sha256' | 'ed25519-sha256' | 'rsa-sha1';

export interface ForgeOptions {
  readonly key: KeyObject;
  readonly algorithm: ForgeAlgorithm;
  readonly domain: string;
  readonly selector: string;
  readonly headers: readonly string[];
  readonly canon?: `${Canonicalization}/${Canonicalization}`;
  /** Extra tags, written in order before bh= (e.g. { i: '@x', l: '20', x: '123' }). */
  readonly tags?: Readonly<Record<string, string>>;
  /** Hash only the first N canonical body bytes and write l=N. */
  readonly length?: number;
  /** Use this bh= (base64) instead of hashing the body in `message` — for streamed bodies. */
  readonly bodyHash?: string;
  /** Omit a tag entirely (for missing-tag fixtures), after signing. */
  readonly omit?: string;
}

/** Split a CRLF message into its header block (with final CRLF) and body. */
export function parts(message: string): { head: string; body: string } {
  const i = message.indexOf('\r\n\r\n');
  if (i === -1) return { head: message, body: '' };
  return { head: message.slice(0, i + 2), body: message.slice(i + 4) };
}

/** Return the DKIM-Signature field (with CRLF) that signs `message` under `opts`. */
export function forgeSignature(message: string, opts: ForgeOptions): string {
  const { head, body } = parts(message);
  const canon = opts.canon ?? 'relaxed/relaxed';
  const [hc, bc] = canon.split('/') as [Canonicalization, Canonicalization];
  const canonical = canonicalizeBody(Buffer.from(body, 'latin1'), bc);
  const hashed = opts.length === undefined ? canonical : canonical.subarray(0, opts.length);
  const bodyAlg = opts.algorithm === 'rsa-sha1' ? 'sha1' : 'sha256';
  const bh = opts.bodyHash ?? createHash(bodyAlg).update(hashed).digest('base64');
  const tags: [string, string][] = [
    ['v', '1'],
    ['a', opts.algorithm],
    ['c', canon],
    ['d', opts.domain],
    ['s', opts.selector],
    ...Object.entries(opts.tags ?? {}),
    ...(opts.length === undefined ? [] : ([['l', String(opts.length)]] as [string, string][])),
    ['h', opts.headers.join(':')],
    ['bh', bh],
  ];
  const unsigned = `DKIM-Signature: ${tags.map(([k, v]) => `${k}=${v};`).join('\r\n\t')}\r\n\tb=`;
  const data = headerHashInput(parseHeaderFields(Buffer.from(head, 'latin1')), opts.headers, unsigned, hc);
  let b: Buffer;
  if (opts.algorithm === 'ed25519-sha256') b = sign(null, createHash('sha256').update(data).digest(), opts.key);
  else b = sign(bodyAlg, data, opts.key);
  let field = `${unsigned}${b.toString('base64')}`;
  if (opts.omit !== undefined) {
    field = field.replace(new RegExp(`\\r\\n\\t${opts.omit}=[^;]*;`), '');
  }
  return `${field}\r\n`;
}

export class DnsServfail extends Error {}

/** A fake DNS: name → TXT records; 'SERVFAIL' throws; a missing name is NXDOMAIN ([]). */
/** Fake DNS records; the string 'SERVFAIL' stands for a temporary failure. */
export function fakeDns(records: Readonly<Record<string, string | readonly string[]>>): DkimDns & {
  readonly queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    txt(name: string): Promise<readonly string[]> {
      queries.push(name);
      const r = Object.hasOwn(records, name) ? records[name] : undefined;
      if (r === 'SERVFAIL') return Promise.reject(new DnsServfail(`SERVFAIL resolving ${name}`));
      if (r === undefined) return Promise.resolve([]);
      return Promise.resolve(typeof r === 'string' ? [r] : r);
    },
  };
}
