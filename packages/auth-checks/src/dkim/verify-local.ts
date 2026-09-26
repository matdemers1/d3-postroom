// A minimal local DKIM verifier: keys come from a selector -> public key map instead of DNS.
//
// It exists to prove the signer (PST-T-1.8's doneWhen) and to check published vectors. It parses
// every DKIM-Signature, hashes the body once per distinct (canonicalization, l=) pair, and checks
// bh= and b=. PST-T-2.4 grows this into the full streaming verifier with DNS lookups, t=/x= policy,
// i= alignment and Authentication-Results.

import type { KeyObject } from 'node:crypto';
import { BodyHasher, parseCanonicalization, type Canonicalization } from './canon.js';
import { DkimError } from './errors.js';
import { headerHashInput, verifyHeaderData } from './header-hash.js';
import { keyTypeFor, type DkimAlgorithm } from './keys.js';
import { splitMessage, type MessageInput, type SplitOptions } from './message.js';
import { parseTagList, splitColonList, stripWhitespace, withEmptyB } from './tags.js';

export type LocalKeys = ReadonlyMap<string, KeyObject> | Readonly<Record<string, KeyObject>>;

export interface LocalVerifyResult {
  readonly result: 'pass' | 'fail' | 'permerror';
  readonly domain?: string;
  readonly selector?: string;
  readonly algorithm?: string;
  /** Why it did not pass. Never contains key material. */
  readonly reason?: string;
}

/** A parsed DKIM-Signature field. */
export interface ParsedSignature {
  readonly raw: string;
  readonly algorithm: DkimAlgorithm;
  readonly domain: string;
  readonly selector: string;
  readonly headerCanon: Canonicalization;
  readonly bodyCanon: Canonicalization;
  readonly signedHeaders: readonly string[];
  readonly bodyHash: Buffer;
  readonly signature: Buffer;
  readonly length: number | undefined;
}

/** Parse and validate one DKIM-Signature field's raw text (latin1, name included). */
export function parseSignatureField(raw: string): ParsedSignature {
  const colon = raw.indexOf(':');
  if (colon === -1) throw new DkimError('not a header field');
  const tags = parseTagList(raw.slice(colon + 1));
  const need = (name: string): string => {
    const v = tags.get(name);
    if (v === undefined || v === '') throw new DkimError(`missing ${name}= tag`);
    return v;
  };
  if (need('v') !== '1') throw new DkimError('unsupported v=');
  const a = need('a').toLowerCase();
  if (a !== 'rsa-sha256' && a !== 'ed25519-sha256') throw new DkimError('unsupported a=');
  const c = parseCanonicalization(tags.get('c'));
  if (c === undefined) throw new DkimError('unsupported c=');
  const signedHeaders = splitColonList(need('h'));
  if (!signedHeaders.some((h) => h.toLowerCase() === 'from')) throw new DkimError('h= does not include From');
  const l = tags.get('l');
  if (l !== undefined && !/^[0-9]{1,76}$/.test(l)) throw new DkimError('invalid l=');
  const length = l === undefined ? undefined : Number(l);
  if (length !== undefined && !Number.isSafeInteger(length)) throw new DkimError('l= too large');
  return {
    raw,
    algorithm: a,
    domain: need('d'),
    selector: need('s'),
    headerCanon: c.header,
    bodyCanon: c.body,
    signedHeaders,
    bodyHash: Buffer.from(stripWhitespace(need('bh')), 'base64'),
    signature: Buffer.from(stripWhitespace(need('b')), 'base64'),
    length,
  };
}

function lookup(keys: LocalKeys, selector: string): KeyObject | undefined {
  if (keys instanceof Map) return (keys as ReadonlyMap<string, KeyObject>).get(selector);
  const record = keys as Readonly<Record<string, KeyObject>>;
  return Object.hasOwn(record, selector) ? record[selector] : undefined;
}

/** Verify every DKIM-Signature in `message`, in header order. An unsigned message yields []. */
export async function verifyLocal(
  message: MessageInput,
  keys: LocalKeys,
  options: SplitOptions = {},
): Promise<LocalVerifyResult[]> {
  const split = await splitMessage(message, options);
  const sigFields = split.fields.filter((f) => f.key === 'dkim-signature');

  const parsed: (ParsedSignature | LocalVerifyResult)[] = sigFields.map((f) => {
    try {
      return parseSignatureField(f.raw.toString('latin1'));
    } catch (err) {
      if (err instanceof DkimError) return { result: 'permerror', reason: err.message };
      throw err;
    }
  });

  // One body pass, one hasher per distinct (canonicalization, l=).
  const hashers = new Map<string, BodyHasher>();
  const hasherKey = (s: ParsedSignature): string => `${s.bodyCanon}:${s.length ?? ''}`;
  for (const p of parsed) {
    if (!('raw' in p)) continue;
    const k = hasherKey(p);
    if (!hashers.has(k)) hashers.set(k, new BodyHasher(p.bodyCanon, p.length));
  }
  for await (const chunk of split.body) for (const h of hashers.values()) h.update(chunk);

  return parsed.map((p): LocalVerifyResult => {
    if (!('raw' in p)) return p;
    const id = { domain: p.domain, selector: p.selector, algorithm: p.algorithm };
    const hasher = hashers.get(hasherKey(p));
    if (hasher === undefined) return { ...id, result: 'permerror', reason: 'internal: no body hasher' };
    const digest = hasher.digest();
    if (p.length !== undefined && p.length > hasher.canonicalLength) {
      return { ...id, result: 'fail', reason: 'l= exceeds the canonical body length' };
    }
    if (!digest.equals(p.bodyHash)) return { ...id, result: 'fail', reason: 'body hash did not verify' };
    const key = lookup(keys, p.selector);
    if (key === undefined) return { ...id, result: 'permerror', reason: 'no key for selector' };
    if (key.asymmetricKeyType !== keyTypeFor(p.algorithm)) {
      return { ...id, result: 'permerror', reason: 'key type does not match a=' };
    }
    const data = headerHashInput(split.fields, p.signedHeaders, withEmptyB(p.raw), p.headerCanon);
    let ok: boolean;
    try {
      ok = verifyHeaderData(p.algorithm, key, data, p.signature);
    } catch (err) {
      return { ...id, result: 'fail', reason: `signature did not verify (${(err as Error).message})` };
    }
    return ok ? { ...id, result: 'pass' } : { ...id, result: 'fail', reason: 'signature did not verify' };
  });
}
