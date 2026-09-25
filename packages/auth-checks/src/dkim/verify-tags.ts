// Parsing and validating what the DKIM verifier reads: the DKIM-Signature field (RFC 6376 §3.5) and
// the key record at <s>._domainkey.<d> (§3.6.1). Nothing here throws on bad input — every problem
// becomes a human-readable reason, because an auth decision always stores why it was made.

import { createPublicKey, type KeyObject } from 'node:crypto';
import { asciiLower, parseCanonicalization, type Canonicalization } from './canon.js';
import { DkimError } from './errors.js';
import { ed25519PublicFromRaw, type DkimAlgorithm } from './keys.js';
import { parseTagList, splitColonList, stripWhitespace } from './tags.js';

/** What can be said about a signature's identity even when it is malformed. */
export interface SignatureIdentity {
  /** d= lowercased. */
  readonly domain?: string;
  /** d= as written, for header.d. */
  readonly headerD?: string;
  readonly selector?: string;
  /** a= as written (lowercased), even when unsupported. */
  readonly algorithm?: string;
  /** i= as written. */
  readonly identity?: string;
  /** First 8 characters of b=, for header.b. */
  readonly headerB?: string;
}

/** A DKIM-Signature that passed every syntax check. */
export interface VerifiableSignature extends SignatureIdentity {
  readonly raw: string;
  readonly domain: string;
  readonly headerD: string;
  readonly selector: string;
  readonly algorithm: DkimAlgorithm;
  readonly headerB: string;
  readonly headerCanon: Canonicalization;
  readonly bodyCanon: Canonicalization;
  readonly signedHeaders: readonly string[];
  readonly bodyHash: Buffer;
  readonly signature: Buffer;
  /** l=, when present. */
  readonly length: number | undefined;
  /** The domain part of i= (or d= when i= is absent), lowercased. */
  readonly identityDomain: string;
  /** t= in seconds since the epoch. */
  readonly timestamp: number | undefined;
  /** x= in seconds since the epoch. */
  readonly expires: number | undefined;
}

export type SignatureParse =
  | { readonly ok: true; readonly sig: VerifiableSignature }
  | { readonly ok: false; readonly reason: string; readonly id: SignatureIdentity };

const REQUIRED = ['a', 'b', 'bh', 'd', 'h', 's'] as const;
// RFC 6376 §3.5: d= is a domain name; s= is a sub-domain (dot-separated labels). Underscores are
// seen in real selectors, so they are allowed.
const DOMAIN_NAME = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DIGITS = /^[0-9]+$/;

/** Parse and validate one DKIM-Signature field (raw latin1 text, field name included). */
export function parseDkimSignature(raw: string): SignatureParse {
  const colon = raw.indexOf(':');
  if (colon === -1) return { ok: false, reason: 'DKIM-Signature is not a header field', id: {} };
  let tags: Map<string, string>;
  try {
    tags = parseTagList(raw.slice(colon + 1));
  } catch (err) {
    if (err instanceof DkimError) return { ok: false, reason: `malformed tag list: ${err.message}`, id: {} };
    throw err;
  }

  const d = tags.get('d');
  const b = tags.get('b');
  const bStripped = b === undefined ? undefined : stripWhitespace(b);
  const a = tags.get('a');
  const i = tags.get('i');
  const s = tags.get('s');
  const id: SignatureIdentity = {
    ...(d === undefined || d === '' ? {} : { domain: asciiLower(d).replace(/\.$/, ''), headerD: d }),
    ...(s === undefined || s === '' ? {} : { selector: s }),
    ...(a === undefined || a === '' ? {} : { algorithm: asciiLower(a) }),
    ...(i === undefined ? {} : { identity: i }),
    ...(bStripped === undefined || bStripped === '' ? {} : { headerB: bStripped.slice(0, 8) }),
  };
  const bad = (reason: string): SignatureParse => ({ ok: false, reason, id });

  const v = tags.get('v');
  if (v === undefined) return bad('missing required tag v=');
  if (v !== '1') return bad(`unsupported version v=${v}`);
  for (const name of REQUIRED) {
    const value = tags.get(name);
    if (value === undefined || stripWhitespace(value) === '') return bad(`missing required tag ${name}=`);
  }
  if (a === undefined || d === undefined || s === undefined || bStripped === undefined) {
    return bad('missing required tag'); // unreachable: checked above; narrows the types
  }

  const algorithm = asciiLower(a);
  if (algorithm === 'rsa-sha1') return bad('rsa-sha1 is not accepted (RFC 8301: sha1 must not be used)');
  if (algorithm !== 'rsa-sha256' && algorithm !== 'ed25519-sha256') return bad(`unsupported algorithm a=${a}`);

  const c = parseCanonicalization(tags.get('c'));
  if (c === undefined) return bad(`unsupported canonicalization c=${tags.get('c') ?? ''}`);

  if (!DOMAIN_NAME.test(d)) return bad(`d= is not a domain name`);
  if (!DOMAIN_NAME.test(s)) return bad(`s= is not a valid selector`);
  const domain = asciiLower(d).replace(/\.$/, '');

  const signedHeaders = splitColonList(tags.get('h') ?? '');
  if (!signedHeaders.some((h) => asciiLower(h) === 'from')) return bad('h= does not include From');
  if (signedHeaders.some((h) => !/^[\x21-\x39\x3b-\x7e]+$/.test(h))) return bad('h= contains an invalid header name');

  let identityDomain = domain;
  if (i !== undefined) {
    const at = i.lastIndexOf('@');
    if (at === -1) return bad('i= has no "@"');
    identityDomain = asciiLower(i.slice(at + 1)).replace(/\.$/, '');
    if (identityDomain !== domain && !identityDomain.endsWith(`.${domain}`)) {
      return bad(`i= domain ${identityDomain} is not d= (${domain}) or a subdomain of it`);
    }
  }

  const l = tags.get('l');
  let length: number | undefined;
  if (l !== undefined) {
    if (!DIGITS.test(l) || l.length > 76) return bad('l= is not a decimal length');
    length = Number(l);
    if (!Number.isSafeInteger(length)) return bad('l= is too large');
  }

  const q = tags.get('q');
  if (q !== undefined && !splitColonList(q).some((m) => asciiLower(m) === 'dns/txt')) {
    return bad(`unsupported query method q=${q}`);
  }

  const timestamp = parseTime(tags.get('t'));
  if (timestamp === null) return bad('t= is not a timestamp');
  const expires = parseTime(tags.get('x'));
  if (expires === null) return bad('x= is not a timestamp');
  if (timestamp !== undefined && expires !== undefined && expires < timestamp) return bad('x= is before t=');

  const bh = stripWhitespace(tags.get('bh') ?? '');
  if (!BASE64.test(bh)) return bad('bh= is not base64');
  const bodyHash = Buffer.from(bh, 'base64');
  if (bodyHash.length !== 32) return bad('bh= is not a SHA-256 digest');
  if (!BASE64.test(bStripped)) return bad('b= is not base64');

  return {
    ok: true,
    sig: {
      ...id,
      raw,
      domain,
      headerD: d,
      selector: s,
      algorithm,
      headerB: bStripped.slice(0, 8),
      headerCanon: c.header,
      bodyCanon: c.body,
      signedHeaders,
      bodyHash,
      signature: Buffer.from(bStripped, 'base64'),
      length,
      identityDomain,
      timestamp,
      expires,
    },
  };
}

/** undefined when absent, null when malformed. */
function parseTime(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!DIGITS.test(value) || value.length > 12) return null;
  return Number(value);
}

// ---- key records ----

export interface DkimKeyRecord {
  /** k=, lowercased (default rsa). */
  readonly keyType: 'rsa' | 'ed25519';
  /** undefined when p= is empty: the key is revoked. */
  readonly publicKey: KeyObject | undefined;
  /** RSA modulus length. */
  readonly bits: number | undefined;
  /** t=y */
  readonly testing: boolean;
  /** t=s: i= must use exactly d=, not a subdomain. */
  readonly strict: boolean;
}

export type KeyRecordParse = { readonly ok: true; readonly key: DkimKeyRecord } | { readonly ok: false; readonly reason: string };

/** Parse one key record TXT value (already joined from its character-strings). */
export function parseDkimKeyRecord(txt: string): KeyRecordParse {
  let tags: Map<string, string>;
  try {
    tags = parseTagList(txt);
  } catch (err) {
    if (err instanceof DkimError) return { ok: false, reason: `key record is malformed: ${err.message}` };
    throw err;
  }
  const v = tags.get('v');
  if (v !== undefined && v !== 'DKIM1') return { ok: false, reason: `key record has unsupported v=${v}` };
  const k = asciiLower(tags.get('k') ?? 'rsa');
  if (k !== 'rsa' && k !== 'ed25519') return { ok: false, reason: `key record has unsupported key type k=${k}` };
  const h = tags.get('h');
  if (h !== undefined && !splitColonList(h).some((x) => asciiLower(x) === 'sha256')) {
    return { ok: false, reason: `key record h=${h} does not allow sha256` };
  }
  const s = tags.get('s');
  if (s !== undefined && !splitColonList(s).some((x) => x === '*' || asciiLower(x) === 'email')) {
    return { ok: false, reason: `key record service type s=${s} excludes email` };
  }
  const flags = splitColonList(tags.get('t') ?? '').map(asciiLower);
  const testing = flags.includes('y');
  const strict = flags.includes('s');
  const pRaw = tags.get('p');
  if (pRaw === undefined) return { ok: false, reason: 'key record has no p= tag' };
  const p = stripWhitespace(pRaw);
  if (p === '') return { ok: true, key: { keyType: k, publicKey: undefined, bits: undefined, testing, strict } };
  if (!BASE64.test(p)) return { ok: false, reason: 'key record p= is not base64' };
  const der = Buffer.from(p, 'base64');
  if (k === 'ed25519') {
    if (der.length !== 32) return { ok: false, reason: 'ed25519 key record p= must be 32 bytes' };
    return { ok: true, key: { keyType: k, publicKey: ed25519PublicFromRaw(der), bits: undefined, testing, strict } };
  }
  const publicKey = rsaFromDer(der);
  if (publicKey?.asymmetricKeyType !== 'rsa') return { ok: false, reason: 'key record p= is not an RSA public key' };
  const bits = publicKey.asymmetricKeyDetails?.modulusLength;
  return { ok: true, key: { keyType: k, publicKey, bits, testing, strict } };
}

/** SubjectPublicKeyInfo as RFC 6376 says; a bare PKCS#1 RSAPublicKey is also seen in the wild. */
function rsaFromDer(der: Buffer): KeyObject | undefined {
  for (const type of ['spki', 'pkcs1'] as const) {
    try {
      return createPublicKey({ key: der, format: 'der', type });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      // not this encoding; try the next
    }
  }
  return undefined;
}
