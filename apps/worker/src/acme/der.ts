// A minimal DER writer (X.690) for the one structure the ACME job builds by hand: the PKCS#10
// certificate request (PST-T-0.15). packages/pgp has a fuller DER codec, but the worker does not
// depend on it and a workspace edge for six helpers is not worth the coupling; this is writer-only.

/** Tag, definite length, content. Lengths above 127 use the long form, minimal octets. */
export function tlv(tag: number, content: Uint8Array): Buffer {
  const len = content.length;
  let header: Buffer;
  if (len < 0x80) {
    header = Buffer.of(tag, len);
  } else {
    const octets: number[] = [];
    for (let n = len; n > 0; n = Math.floor(n / 256)) octets.unshift(n & 0xff);
    header = Buffer.of(tag, 0x80 | octets.length, ...octets);
  }
  return Buffer.concat([header, content]);
}

export const sequence = (...items: Uint8Array[]): Buffer => tlv(0x30, Buffer.concat(items));

/** SET OF: DER orders the encoded elements bytewise (X.690 11.6). */
export function setOf(...items: Uint8Array[]): Buffer {
  const sorted = items.map((i) => Buffer.from(i)).sort((a, b) => Buffer.compare(a, b));
  return tlv(0x31, Buffer.concat(sorted));
}

/** A non-negative INTEGER, minimal two's complement (a leading 0x00 only when the high bit is set). */
export function integer(value: number | bigint): Buffer {
  let n = BigInt(value);
  if (n < 0n) throw new RangeError('only non-negative INTEGERs are supported');
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function base128(n: number): number[] {
  const out = [n & 0x7f];
  for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) out.unshift(0x80 | (v & 0x7f));
  return out;
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((a) => {
    if (!/^\d+$/.test(a)) throw new Error(`bad OID arc in ${dotted}`);
    return Number(a);
  });
  const [first, second, ...rest] = arcs;
  if (first === undefined || second === undefined || first > 2 || (first < 2 && second > 39)) throw new Error(`bad OID ${dotted}`);
  const bytes = [...base128(first * 40 + second), ...rest.flatMap(base128)];
  return tlv(0x06, Buffer.from(bytes));
}

export const nullValue = (): Buffer => Buffer.of(0x05, 0x00);
export const utf8String = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
export const octetString = (b: Uint8Array): Buffer => tlv(0x04, b);
/** BIT STRING with no unused bits (signatures, keys). */
export const bitString = (b: Uint8Array): Buffer => tlv(0x03, Buffer.concat([Buffer.of(0), b]));
/** [n] IMPLICIT, constructed (e.g. the CSR's attributes [0]). */
export const contextConstructed = (n: number, content: Uint8Array): Buffer => tlv(0xa0 | n, content);
/** [n] IMPLICIT, primitive (e.g. GeneralName dNSName [2] IA5String). */
export const contextPrimitive = (n: number, content: Uint8Array): Buffer => tlv(0x80 | n, content);
