// The DKIM verifier (RFC 6376 §6, RFC 8463, RFC 8301), streaming (PST-REQ-055).
//
// smtp-in pipes DATA through `createDkimVerifierStream()`: bytes pass through untouched while the
// header block (bounded, 1 MiB) is collected. The moment the blank line arrives every DKIM-Signature
// is parsed, its key lookup starts, and one BodyHasher per distinct (body canonicalization, l=) is
// created — signatures that share one share the hasher. The body is then hashed as it streams and
// never retained. When the stream ends the hashes are finished, the lookups awaited, and each
// signature gets a result with the reasons behind it.

import { Transform, type TransformCallback } from 'node:stream';
import type { ResolverResult } from '@postroom/dns';
import { RCode } from '@postroom/dns';
import { decodeHeaderBytes, parseMailboxes } from '@postroom/mime';
import { BodyHasher } from './canon.js';
import { HeaderTooLargeError } from './errors.js';
import { headerHashInput, verifyHeaderData } from './header-hash.js';
import { keyTypeFor } from './keys.js';
import { DEFAULT_MAX_HEADER_BYTES, findSeparator, parseHeaderFields, type HeaderField } from './message.js';
import { withEmptyB } from './tags.js';
import {
  parseDkimKeyRecord,
  parseDkimSignature,
  type DkimKeyRecord,
  type SignatureIdentity,
  type SignatureParse,
  type VerifiableSignature,
} from './verify-tags.js';

export type DkimResultCode = 'pass' | 'fail' | 'neutral' | 'temperror' | 'permerror' | 'policy';

export interface DkimResult {
  readonly result: DkimResultCode;
  /** Position of this DKIM-Signature among the message's DKIM-Signature fields, top first. */
  readonly index: number;
  /** d=, lowercased: the signing domain DMARC aligns against. */
  readonly domain?: string;
  /** d= as written, for Authentication-Results header.d. */
  readonly headerD?: string;
  readonly selector?: string;
  readonly algorithm?: string;
  /** i= as written. */
  readonly identity?: string;
  /** The first 8 characters of b=, for header.b (RFC 6008). */
  readonly headerB?: string;
  /** Whether bh= matched the body; undefined when the body hash was never compared. */
  readonly bodyHashMatches: boolean | undefined;
  /** RSA modulus length of the key used. */
  readonly keyBits?: number;
  /** The key record carries t=y: the signer is testing, and the result should not be relied on. */
  readonly testing: boolean;
  /**
   * The domain of the message's From header — DMARC's alignment input. Set only when there is
   * exactly one From header holding exactly one address.
   */
  readonly fromDomain?: string;
  /** Human-readable reasons. Never empty for a result other than pass; notes on a pass. */
  readonly reasons: readonly string[];
}

/** Anything that can look up TXT records: a plain lookup, or @postroom/dns's resolver directly. */
export interface DkimDns {
  /**
   * TXT records at `name`, each already joined from its character-strings. Resolve to [] when the
   * name or record does not exist (NXDOMAIN, NODATA). Throw for a temporary failure (SERVFAIL,
   * timeout). A @postroom/dns `ResolverResult` is also accepted and interpreted.
   */
  txt(name: string): Promise<readonly string[] | ResolverResult>;
}

export interface DkimVerifierOptions {
  readonly dns: DkimDns;
  /** The clock for t=/x= checks. */
  readonly now?: Date | (() => Date);
  /** Signatures beyond this many are not evaluated (result 'neutral'). Default 10. */
  readonly maxSignatures?: number;
  /** RSA keys shorter than this are a permerror. Default 1024 (RFC 8301: MUST NOT accept < 1024). */
  readonly minRsaBits?: number;
  /** Bound on the header block. Default 1 MiB. */
  readonly maxHeaderBytes?: number;
  /** Tolerance for x= and future t=, in seconds. Default 300. */
  readonly clockSkewSeconds?: number;
}

export interface VerificationStats {
  /** Bytes of the header block (including the blank line). */
  readonly headerBytes: number;
  /** Body bytes seen. */
  readonly bodyBytes: number;
  /** The most bytes the verifier ever held at once. Bounded by the header cap, not the body. */
  readonly maxRetainedBytes: number;
  /** How many body hashers ran (one per distinct canonicalization and l=). */
  readonly bodyHashers: number;
}

export type DkimSource = AsyncIterable<Uint8Array | string> | Uint8Array;

export interface DkimVerifierStream extends Transform {
  /** Per-signature results, available once the stream has ended. Rejects if the header block is too large. */
  results(): Promise<DkimResult[]>;
  stats(): VerificationStats;
}

export interface DkimVerifier {
  verifyStream(source: DkimSource): Promise<DkimResult[]>;
  /** A pass-through Transform that verifies the bytes flowing through it. */
  createStream(): DkimVerifierStream;
}

const DEFAULT_MAX_SIGNATURES = 10;
const DEFAULT_MIN_RSA_BITS = 1024;
const RECOMMENDED_RSA_BITS = 2048;
const DEFAULT_SKEW_SECONDS = 300;

export function createDkimVerifier(options: DkimVerifierOptions): DkimVerifier {
  return {
    async verifyStream(source: DkimSource): Promise<DkimResult[]> {
      const run = new Verification(options);
      if (source instanceof Uint8Array) {
        run.push(source);
      } else {
        for await (const chunk of source) run.push(chunk);
      }
      return run.finish();
    },
    createStream(): DkimVerifierStream {
      return new VerifierTransform(options);
    },
  };
}

/** Shorthand for `createDkimVerifier(options).createStream()`. */
export function createDkimVerifierStream(options: DkimVerifierOptions): DkimVerifierStream {
  return new VerifierTransform(options);
}

class VerifierTransform extends Transform implements DkimVerifierStream {
  private readonly run: Verification;
  private readonly outcome: Promise<DkimResult[]>;
  private settle: ((p: Promise<DkimResult[]>) => void) | undefined;

  constructor(options: DkimVerifierOptions) {
    super();
    this.run = new Verification(options);
    this.outcome = new Promise<DkimResult[]>((resolve) => {
      this.settle = resolve;
    });
    // A caller that never asks for results must not see an unhandled rejection.
    this.outcome.catch(() => undefined);
  }

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    this.run.push(chunk);
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback): void {
    this.resolveWith(() => this.run.finish());
    cb();
  }

  override _destroy(err: Error | null, cb: (error: Error | null) => void): void {
    this.resolveWith(() => Promise.reject(err ?? new Error('DKIM verifier stream destroyed before it ended')));
    cb(err);
  }

  private resolveWith(make: () => Promise<DkimResult[]>): void {
    const settle = this.settle;
    if (settle === undefined) return;
    this.settle = undefined;
    settle(make());
  }

  results(): Promise<DkimResult[]> {
    return this.outcome;
  }

  stats(): VerificationStats {
    return this.run.stats();
  }
}

type KeyLookup =
  | { readonly kind: 'key'; readonly key: DkimKeyRecord }
  | { readonly kind: 'temperror' | 'permerror'; readonly reason: string };

type Slot =
  | { readonly kind: 'invalid'; readonly reason: string; readonly id: SignatureIdentity }
  | { readonly kind: 'skipped'; readonly id: SignatureIdentity }
  | { readonly kind: 'sig'; readonly sig: VerifiableSignature; readonly hasher: BodyHasher; readonly key: Promise<KeyLookup> };

/** One message's verification: push bytes, then finish. */
class Verification {
  private readonly options: DkimVerifierOptions;
  private readonly maxHeader: number;
  private head: Buffer = Buffer.alloc(0);
  private phase: 'head' | 'body' | 'overflow' = 'head';
  private fields: readonly HeaderField[] = [];
  private slots: Slot[] = [];
  private readonly hashers = new Map<string, BodyHasher>();
  private readonly lookups = new Map<string, Promise<KeyLookup>>();
  private headerBytes = 0;
  private bodyBytes = 0;
  private maxRetained = 0;
  private finished: Promise<DkimResult[]> | undefined;

  constructor(options: DkimVerifierOptions) {
    this.options = options;
    this.maxHeader = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  }

  push(input: Uint8Array | string): void {
    if (this.finished !== undefined) throw new Error('DKIM verification: push after finish');
    const chunk = toBuffer(input);
    if (chunk.length === 0) return;
    if (this.phase === 'body') {
      this.body(chunk);
      return;
    }
    if (this.phase === 'overflow') return;
    const searchFrom = Math.max(0, this.head.length - 3);
    // Copied: a caller may reuse its chunk buffer once push() returns.
    this.head = this.head.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.head, chunk]);
    this.maxRetained = Math.max(this.maxRetained, this.head.length);
    const at = findSeparator(this.head, searchFrom);
    if (at === undefined) {
      if (this.head.length > this.maxHeader) this.overflow();
      return;
    }
    if (at.headEnd > this.maxHeader) {
      this.overflow();
      return;
    }
    const rest = this.head.subarray(at.bodyStart);
    this.headerBytes = at.bodyStart;
    this.startBody(this.head.subarray(0, at.headEnd));
    if (rest.length > 0) this.body(rest);
  }

  finish(): Promise<DkimResult[]> {
    this.finished ??= this.complete();
    return this.finished;
  }

  stats(): VerificationStats {
    return {
      headerBytes: this.headerBytes,
      bodyBytes: this.bodyBytes,
      maxRetainedBytes: this.maxRetained,
      bodyHashers: this.hashers.size,
    };
  }

  private overflow(): void {
    this.phase = 'overflow';
    this.head = Buffer.alloc(0);
  }

  private body(chunk: Buffer): void {
    this.bodyBytes += chunk.length;
    for (const h of this.hashers.values()) h.update(chunk);
  }

  /** The header block is complete: parse signatures, start key lookups, create body hashers. */
  private startBody(headerBlock: Buffer): void {
    this.phase = 'body';
    // Copied so the fields do not pin the body bytes that arrived in the same chunk.
    this.head = Buffer.from(headerBlock);
    this.maxRetained = Math.max(this.maxRetained, this.head.length);
    this.fields = parseHeaderFields(this.head);
    const max = this.options.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
    const sigFields = this.fields.filter((f) => f.key === 'dkim-signature');
    this.slots = sigFields.map((f, n): Slot => {
      const parsed: SignatureParse = parseDkimSignature(f.raw.toString('latin1'));
      if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason, id: parsed.id };
      if (n >= max) return { kind: 'skipped', id: parsed.sig };
      const sig = parsed.sig;
      const hk = `${sig.bodyCanon}:${sig.length === undefined ? '' : String(sig.length)}`;
      let hasher = this.hashers.get(hk);
      if (hasher === undefined) {
        hasher = new BodyHasher(sig.bodyCanon, sig.length);
        this.hashers.set(hk, hasher);
      }
      return { kind: 'sig', sig, hasher, key: this.lookup(`${sig.selector}._domainkey.${sig.domain}`) };
    });
  }

  private lookup(name: string): Promise<KeyLookup> {
    let p = this.lookups.get(name);
    if (p === undefined) {
      p = fetchKey(this.options.dns, name);
      this.lookups.set(name, p);
    }
    return p;
  }

  private async complete(): Promise<DkimResult[]> {
    if (this.phase === 'overflow') throw new HeaderTooLargeError(`header block exceeds ${this.maxHeader} bytes`);
    if (this.phase === 'head') {
      // No blank line: the whole message is header, the body empty.
      this.headerBytes = this.head.length;
      this.startBody(this.head);
    }
    for (const h of this.hashers.values()) h.digest();
    const fromDomain = singleFromDomain(this.fields);
    const out: DkimResult[] = [];
    for (const [index, slot] of this.slots.entries()) {
      out.push(await this.evaluate(slot, index, fromDomain));
    }
    return out;
  }

  private async evaluate(slot: Slot, index: number, fromDomain: string | undefined): Promise<DkimResult> {
    const base = { index, ...(fromDomain === undefined ? {} : { fromDomain }) };
    if (slot.kind === 'invalid') {
      return { ...base, ...identityOf(slot.id), result: 'permerror', bodyHashMatches: undefined, testing: false, reasons: [slot.reason] };
    }
    const max = this.options.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
    if (slot.kind === 'skipped') {
      return {
        ...base,
        ...identityOf(slot.id),
        result: 'neutral',
        bodyHashMatches: undefined,
        testing: false,
        reasons: [`not evaluated: only the first ${max} signatures are checked`],
      };
    }

    const { sig, hasher } = slot;
    const notes: string[] = [];
    let bodyHashMatches: boolean | undefined = hasher.digest().equals(sig.bodyHash);
    let bodyReason: string | undefined = bodyHashMatches ? undefined : 'body hash mismatch';
    if (sig.length !== undefined) {
      if (sig.length > hasher.canonicalLength) {
        bodyHashMatches = false;
        bodyReason = `l=${sig.length} exceeds the canonical body length (${hasher.canonicalLength})`;
      } else if (sig.length < hasher.canonicalLength) {
        notes.push(`l=${sig.length} signs only ${sig.length} of ${hasher.canonicalLength} body bytes; the rest is unsigned`);
      }
    }
    // Filled in once the key is known; results before that carry neither.
    const keyInfo: { testing: boolean; bits: number | undefined } = { testing: false, bits: undefined };
    const done = (result: DkimResultCode, reasons: readonly string[]): DkimResult => ({
      ...base,
      ...identityOf(sig),
      result,
      bodyHashMatches,
      ...(keyInfo.bits === undefined ? {} : { keyBits: keyInfo.bits }),
      testing: keyInfo.testing,
      reasons: [...reasons, ...notes],
    });

    // Time (RFC 6376 §3.5 t=, x=).
    const nowSec = Math.floor(currentTime(this.options.now).getTime() / 1000);
    const skew = this.options.clockSkewSeconds ?? DEFAULT_SKEW_SECONDS;
    if (sig.expires !== undefined && sig.expires + skew < nowSec) {
      return done('fail', [`signature expired at ${new Date(sig.expires * 1000).toISOString()}`]);
    }
    if (sig.timestamp !== undefined && sig.timestamp - skew > nowSec) {
      return done('permerror', [`signature timestamp ${new Date(sig.timestamp * 1000).toISOString()} is in the future`]);
    }

    // Key.
    const lookup = await slot.key;
    if (lookup.kind !== 'key') return done(lookup.kind, [lookup.reason]);
    const key = lookup.key;
    keyInfo.testing = key.testing;
    keyInfo.bits = key.bits;
    if (key.testing) notes.push('key is in testing mode (t=y)');
    if (key.publicKey === undefined) return done('fail', ['key revoked (empty p=)']);
    if (key.keyType !== keyTypeFor(sig.algorithm)) {
      return done('permerror', [`key type ${key.keyType} does not match a=${sig.algorithm}`]);
    }
    if (key.strict && sig.identityDomain !== sig.domain) {
      return done('permerror', [`key record t=s requires i= to use exactly ${sig.domain}`]);
    }
    if (key.keyType === 'rsa') {
      const bits = key.bits ?? 0;
      const min = this.options.minRsaBits ?? DEFAULT_MIN_RSA_BITS;
      if (bits < min) return done('permerror', [`RSA key is ${bits} bits; at least ${min} required (RFC 8301)`]);
      if (bits < RECOMMENDED_RSA_BITS) notes.push(`weak key: ${bits}-bit RSA (RFC 8301 recommends ${RECOMMENDED_RSA_BITS})`);
    }

    // Body, then header hash.
    if (bodyReason !== undefined) return done('fail', [bodyReason]);
    const data = headerHashInput(this.fields, sig.signedHeaders, withEmptyB(sig.raw), sig.headerCanon);
    let ok: boolean;
    try {
      ok = verifyHeaderData(sig.algorithm, key.publicKey, data, sig.signature);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      return done('fail', [`signature did not verify (${err.message})`]);
    }
    if (!ok) return done('fail', ['signature did not verify (signed headers or b= changed)']);
    return done('pass', []);
  }
}

function identityOf(id: SignatureIdentity): SignatureIdentity {
  return {
    ...(id.domain === undefined ? {} : { domain: id.domain }),
    ...(id.headerD === undefined ? {} : { headerD: id.headerD }),
    ...(id.selector === undefined ? {} : { selector: id.selector }),
    ...(id.algorithm === undefined ? {} : { algorithm: id.algorithm }),
    ...(id.identity === undefined ? {} : { identity: id.identity }),
    ...(id.headerB === undefined ? {} : { headerB: id.headerB }),
  };
}

function currentTime(now: DkimVerifierOptions['now']): Date {
  if (now === undefined) return new Date();
  return typeof now === 'function' ? now() : now;
}

function toBuffer(chunk: Uint8Array | string): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'latin1');
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
}

/** Look up and parse the key record. Never throws. */
async function fetchKey(dns: DkimDns, name: string): Promise<KeyLookup> {
  let records: readonly string[];
  try {
    const answer = await dns.txt(name);
    if (isResolverResult(answer)) {
      if (answer.rcode !== RCode.NOERROR && answer.rcode !== RCode.NXDOMAIN) {
        return { kind: 'temperror', reason: `DNS temporary failure looking up ${name} (rcode ${answer.rcode})` };
      }
      records = answer.answers.flatMap((a) => (a.kind === 'TXT' ? [a.strings.join('')] : []));
    } else {
      records = answer;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'temperror', reason: `DNS temporary failure looking up ${name}: ${message}` };
  }
  if (records.length === 0) return { kind: 'permerror', reason: `key record not found at ${name}` };
  let firstError: string | undefined;
  for (const txt of records) {
    const parsed = parseDkimKeyRecord(txt);
    if (parsed.ok) return { kind: 'key', key: parsed.key };
    firstError ??= parsed.reason;
  }
  return { kind: 'permerror', reason: firstError ?? `no usable key record at ${name}` };
}

function isResolverResult(x: readonly string[] | ResolverResult): x is ResolverResult {
  return !Array.isArray(x);
}

function singleFromDomain(fields: readonly HeaderField[]): string | undefined {
  const froms = fields.filter((f) => f.key === 'from');
  const only = froms[0];
  if (froms.length !== 1 || only === undefined) return undefined;
  const colon = only.raw.indexOf(0x3a);
  const value = decodeHeaderBytes(only.raw.subarray(colon + 1)).text.replace(/\r\n/g, '');
  const boxes = parseMailboxes(value);
  const box = boxes[0];
  if (boxes.length !== 1 || box === undefined) return undefined;
  const at = box.address.lastIndexOf('@');
  if (at === -1) return undefined;
  const domain = box.address.slice(at + 1).toLowerCase().replace(/\.$/, '');
  return domain === '' ? undefined : domain;
}

// ---- Authentication-Results (RFC 8601, RFC 6008) ----

const TSPECIALS = /[()<>@,;:\\"/[\]?=\s]/;

/**
 * One Authentication-Results method result per signature, e.g.
 * `dkim=pass header.d=example.com header.s=sel header.a=ed25519-sha256 header.b=AbCdEfGh`.
 * Reasons go in a comment. No signatures → `dkim=none`.
 */
export function authResultsDkim(results: readonly DkimResult[]): string[] {
  if (results.length === 0) return ['dkim=none'];
  return results.map((r) => {
    const parts = [`dkim=${r.result}`];
    if (r.reasons.length > 0) parts.push(`(${r.reasons.map(commentSafe).join('; ')})`);
    if (r.headerD !== undefined) parts.push(`header.d=${pvalue(r.headerD)}`);
    if (r.identity !== undefined) parts.push(`header.i=${pvalue(r.identity, true)}`);
    if (r.selector !== undefined) parts.push(`header.s=${pvalue(r.selector)}`);
    if (r.algorithm !== undefined) parts.push(`header.a=${pvalue(r.algorithm)}`);
    if (r.headerB !== undefined) parts.push(`header.b=${pvalue(r.headerB)}`);
    return parts.join(' ');
  });
}

/** Comment text: parentheses become brackets so the comment stays balanced; no CR, LF or backslash. */
function commentSafe(s: string): string {
  return s.replace(/\(/g, '[').replace(/\)/g, ']').replace(/[\\\r\n]/g, ' ');
}

/** A token as-is, else a quoted-string. `@` is allowed bare in header.i (RFC 8601 pvalue). */
function pvalue(v: string, allowAt = false): string {
  const test = allowAt ? v.replace(/@/g, '') : v;
  if (v !== '' && !TSPECIALS.test(test)) return v;
  return `"${v.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n]/g, '')}"`;
}
