// OpenPGP packet framing (RFC 9580 §4.2, RFC 4880 §4.2): old-format (legacy) and new-format
// (OpenPGP) headers, one/two/five-octet lengths, partial body lengths, and the old format's
// indeterminate length. Returns bodies as subarrays of the input where it can (no copy), and
// concatenates partial chunks when it must.

import { Reader } from './bytes.js';
import { PgpError } from './errors.js';

export const Tag = {
  PKESK: 1,
  Signature: 2,
  SKESK: 3,
  OnePassSignature: 4,
  SecretKey: 5,
  PublicKey: 6,
  SecretSubkey: 7,
  Compressed: 8,
  SED: 9,
  Marker: 10,
  Literal: 11,
  Trust: 12,
  UserId: 13,
  PublicSubkey: 14,
  UserAttribute: 17,
  SEIPD: 18,
  MDC: 19,
  OCB: 20,
  Padding: 21,
} as const;

export interface Packet {
  tag: number;
  format: 'old' | 'new';
  /** True when the body arrived in partial-length chunks. */
  partial: boolean;
  body: Buffer;
  /** Offset of the packet header in the input. */
  offset: number;
}

/** Data packets are the only ones RFC 9580 §4.2.1.4 allows partial lengths on. */
const PARTIAL_OK = new Set<number>([Tag.Compressed, Tag.SED, Tag.Literal, Tag.SEIPD, Tag.OCB]);

const fail = (m: string): PgpError => new PgpError('packet-truncated', `packet framing: ${m}`);

export interface ReadPacketsOptions {
  /** Stop after this many packets (default 100 000). */
  maxPackets?: number;
}

export function readPackets(input: Uint8Array, opts: ReadPacketsOptions = {}): Packet[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.length);
  const max = opts.maxPackets ?? 100_000;
  const r = new Reader(buf, fail);
  const out: Packet[] = [];
  while (r.remaining > 0) {
    if (out.length >= max) throw new PgpError('too-many-packets');
    const offset = r.pos;
    const ctb = r.u8();
    if ((ctb & 0x80) === 0) throw new PgpError('packet-bad-header', `octet 0x${ctb.toString(16)} at ${String(offset)} is not a packet header`);
    if ((ctb & 0x40) === 0) {
      // Old format: tag in bits 5..2, length type in bits 1..0.
      const tag = (ctb >> 2) & 0x0f;
      const lt = ctb & 0x03;
      let len: number;
      if (lt === 0) len = r.u8();
      else if (lt === 1) len = r.u16();
      else if (lt === 2) len = r.u32();
      else len = r.remaining; // indeterminate: to the end of the input
      out.push({ tag, format: 'old', partial: false, body: r.bytes(len), offset });
      continue;
    }
    const tag = ctb & 0x3f;
    const first = r.u8();
    if (first < 224 || first === 255) {
      out.push({ tag, format: 'new', partial: false, body: r.bytes(newLength(first, r)), offset });
      continue;
    }
    // Partial body lengths.
    if (!PARTIAL_OK.has(tag)) throw new PgpError('packet-partial-not-allowed', `partial length on packet tag ${String(tag)}`);
    const chunks: Buffer[] = [];
    let o = first;
    let firstChunk = true;
    for (;;) {
      if (o >= 224 && o < 255) {
        const size = 1 << (o & 0x1f);
        if (firstChunk && size < 512) throw new PgpError('packet-partial-too-small', 'the first partial length must be at least 512 octets');
        firstChunk = false;
        chunks.push(r.bytes(size));
        o = r.u8();
        continue;
      }
      chunks.push(r.bytes(newLength(o, r)));
      break;
    }
    out.push({ tag, format: 'new', partial: true, body: Buffer.concat(chunks), offset });
  }
  return out;
}

function newLength(first: number, r: Reader): number {
  if (first < 192) return first;
  if (first < 224) return ((first - 192) << 8) + r.u8() + 192;
  return r.u32(); // 255
}

/** Encode a new-format packet (definite length). Used by tests and the fuzz round-trip. */
export function encodePacket(tag: number, body: Uint8Array): Buffer {
  if (tag < 0 || tag > 63) throw new RangeError('tag out of range');
  const n = body.length;
  let len: Buffer;
  if (n < 192) len = Buffer.of(n);
  else if (n < 8384) len = Buffer.of(((n - 192) >> 8) + 192, (n - 192) & 0xff);
  else {
    len = Buffer.alloc(5);
    len[0] = 255;
    len.writeUInt32BE(n, 1);
  }
  return Buffer.concat([Buffer.of(0xc0 | tag), len, body]);
}

/** Reads an MPI (RFC 9580 §3.2): a two-octet bit count, then the big-endian magnitude. */
export function readMpi(r: Reader): Buffer {
  const bits = r.u16();
  return r.bytes((bits + 7) >> 3);
}
