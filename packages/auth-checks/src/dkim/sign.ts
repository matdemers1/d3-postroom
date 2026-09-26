// The DKIM signer (RFC 6376 §5, RFC 8463): one pass over the body, one signature per key.
//
// PST-REQ-038: every outbound message carries an Ed25519 and an RSA-2048 signature for the sender's
// domain. Both use c=relaxed/relaxed and share a single body hash. From is oversigned (listed once
// more than it occurs) so a From added in transit breaks both signatures.

import type { KeyObject } from 'node:crypto';
import { BodyHasher, type Canonicalization } from './canon.js';
import { DkimError } from './errors.js';
import { headerHashInput, signHeaderData } from './header-hash.js';
import { assertKeyType, RSA_MODULUS_BITS, type DkimAlgorithm } from './keys.js';
import { splitMessage, type MessageInput } from './message.js';

export interface DkimSigningKey {
  readonly selector: string;
  readonly algorithm: DkimAlgorithm;
  readonly privateKey: KeyObject;
}

export interface SignOptions {
  /** The signing domain (d=): the sender's domain, aligned with From for DMARC. */
  readonly domain: string;
  readonly keys: readonly DkimSigningKey[];
  /** Header names to sign when present. Defaults to DEFAULT_SIGNED_HEADERS. From is always signed. */
  readonly headers?: readonly string[];
  /** Signature timestamp (t=). Defaults to now. */
  readonly now?: Date;
  /** header/body canonicalization. Defaults to relaxed/relaxed; simple exists for tests. */
  readonly canonicalization?: `${Canonicalization}/${Canonicalization}`;
  /** Bound on the header block. Default 1 MB. */
  readonly maxHeaderBytes?: number;
}

/** Headers signed when present (§5.4.1's recommended set, plus list and feedback headers). */
export const DEFAULT_SIGNED_HEADERS: readonly string[] = [
  'from',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'reply-to',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'feedback-id',
];

/** Longest line the signer writes, CRLF excluded (RFC 5322 §2.1.1's SHOULD). */
export const MAX_LINE = 78;

const DOMAIN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * Sign a message. Returns the DKIM-Signature header fields — Ed25519 first, then RSA — each ending
 * in CRLF, to be prepended to the message in the order returned: `Buffer.concat([...sigs, message])`.
 * The message is read once; its body is streamed and hashed once for all keys.
 */
export async function signMessage(message: MessageInput, options: SignOptions): Promise<string[]> {
  const { domain } = options;
  if (!DOMAIN.test(domain)) throw new DkimError('invalid signing domain');
  if (options.keys.length === 0) throw new DkimError('no signing keys');
  for (const k of options.keys) {
    if (!DOMAIN.test(k.selector)) throw new DkimError('invalid selector');
    if (k.privateKey.type !== 'private') throw new DkimError(`${k.algorithm} key is not a private key`);
    assertKeyType(k.privateKey, k.algorithm);
    if (k.algorithm === 'rsa-sha256') {
      const bits = k.privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
      if (bits < RSA_MODULUS_BITS) throw new DkimError(`RSA key must be at least ${RSA_MODULUS_BITS} bits`);
    }
  }
  const [headerCanon, bodyCanon] = (options.canonicalization ?? 'relaxed/relaxed').split('/') as [
    Canonicalization,
    Canonicalization,
  ];

  const split = await splitMessage(
    message,
    options.maxHeaderBytes === undefined ? {} : { maxHeaderBytes: options.maxHeaderBytes },
  );
  const hNames = signedHeaderNames(split.fields.map((f) => f.key), options.headers ?? DEFAULT_SIGNED_HEADERS);

  const hasher = new BodyHasher(bodyCanon);
  for await (const chunk of split.body) hasher.update(chunk);
  const bh = hasher.digest().toString('base64');

  const t = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const ordered = [...options.keys].sort((a, b) => rank(a.algorithm) - rank(b.algorithm));
  return ordered.map((key) => {
    const folder = new Folder('DKIM-Signature: ');
    folder.add('v=1;', '');
    folder.add(`a=${key.algorithm};`, ' ');
    folder.add(`c=${headerCanon}/${bodyCanon};`, ' ');
    folder.add(`d=${domain};`, ' ');
    folder.add(`s=${key.selector};`, ' ');
    folder.add(`t=${t};`, ' ');
    hNames.forEach((name, i) => {
      const last = i === hNames.length - 1;
      folder.add(`${i === 0 ? 'h=' : ''}${name}${last ? ';' : ':'}`, i === 0 ? ' ' : '');
    });
    folder.add(`bh=${bh};`, ' ');
    folder.add('b=', ' ');
    const unsigned = folder.text;
    const data = headerHashInput(split.fields, hNames, unsigned, headerCanon);
    const b = signHeaderData(key.algorithm, key.privateKey, data).toString('base64');
    folder.addSplittable(b);
    return `${folder.text}\r\n`;
  });
}

function rank(algorithm: DkimAlgorithm): number {
  return algorithm === 'ed25519-sha256' ? 0 : 1;
}

/**
 * The h= list: From once more than it occurs (oversigned), first; then every other configured
 * name once per instance present in the message, in configured order.
 */
export function signedHeaderNames(present: readonly string[], configured: readonly string[]): string[] {
  const count = new Map<string, number>();
  for (const k of present) count.set(k, (count.get(k) ?? 0) + 1);
  const fromCount = count.get('from') ?? 0;
  if (fromCount === 0) throw new DkimError('message has no From header');
  const names: string[] = Array.from({ length: fromCount + 1 }, () => 'from');
  const seen = new Set<string>(['from']);
  for (const raw of configured) {
    const name = raw.trim().toLowerCase();
    if (seen.has(name) || name.includes(':') || name === '') continue;
    seen.add(name);
    for (let i = 0; i < (count.get(name) ?? 0); i++) names.push(name);
  }
  return names;
}

/** Folds a header field at MAX_LINE with CRLF + TAB. */
class Folder {
  text: string;
  private lineLen: number;

  constructor(prefix: string) {
    this.text = prefix;
    this.lineLen = prefix.length;
  }

  /** Append an unbreakable piece, preceded by `sep` unless it starts a new continuation line. */
  add(piece: string, sep: '' | ' '): void {
    if (this.lineLen + sep.length + piece.length > MAX_LINE) {
      this.text += `\r\n\t${piece}`;
      this.lineLen = 1 + piece.length;
    } else {
      this.text += sep + piece;
      this.lineLen += sep.length + piece.length;
    }
  }

  /** Append a value that may be broken anywhere (base64: FWS inside it is ignored). */
  addSplittable(value: string): void {
    let rest = value;
    while (rest.length > 0) {
      let room = MAX_LINE - this.lineLen;
      if (room <= 0) {
        this.text += '\r\n\t';
        this.lineLen = 1;
        room = MAX_LINE - 1;
      }
      const part = rest.slice(0, room);
      this.text += part;
      this.lineLen += part.length;
      rest = rest.slice(part.length);
    }
  }
}
