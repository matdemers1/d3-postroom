// Modified UTF-7 mailbox names (RFC 3501 §5.1.3), used by IMAP4rev1 clients. Under IMAP4rev2 and
// UTF8=ACCEPT names travel as UTF-8 instead.
//
// Printable US-ASCII (0x20–0x7e) stands for itself except "&", written "&-". Everything else is
// UTF-16BE, base64-encoded with "," for "/" and no padding, between "&" and "-". Decoding is strict:
// a shifted run that encodes printable ASCII, has non-zero leftover bits, an odd octet count, or a
// raw character outside 0x20–0x7e is refused, so every name has exactly one wire spelling.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,';
const B64_INDEX = new Map<number, number>(Array.from({ length: B64.length }, (_, i) => [B64.charCodeAt(i), i]));

function isDirect(unit: number): boolean {
  return unit >= 0x20 && unit <= 0x7e;
}

function encodeRun(units: number[]): string {
  const bytes: number[] = [];
  for (const u of units) bytes.push(u >> 8, u & 0xff);
  let out = '&';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(n >> 18) & 63] ?? '';
    out += B64[(n >> 12) & 63] ?? '';
    if (b1 !== undefined) out += B64[(n >> 6) & 63] ?? '';
    if (b2 !== undefined) out += B64[n & 63] ?? '';
  }
  return `${out}-`;
}

/** Encode a mailbox name (any JS string) as modified UTF-7. */
export function encodeMailboxName(name: string): string {
  let out = '';
  let run: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const unit = name.charCodeAt(i);
    if (isDirect(unit)) {
      if (run.length > 0) {
        out += encodeRun(run);
        run = [];
      }
      out += unit === 0x26 ? '&-' : String.fromCharCode(unit);
    } else {
      run.push(unit);
    }
  }
  if (run.length > 0) out += encodeRun(run);
  return out;
}

/** Decode a modified UTF-7 mailbox name; `null` when it is not valid (strictly) modified UTF-7. */
export function decodeMailboxName(wire: string): string | null {
  let out = '';
  let i = 0;
  let afterRun = false;
  while (i < wire.length) {
    const c = wire.charCodeAt(i);
    if (!isDirect(c)) return null;
    if (c !== 0x26) {
      out += String.fromCharCode(c);
      i++;
      afterRun = false;
      continue;
    }
    const end = wire.indexOf('-', i + 1);
    if (end < 0) return null;
    if (end === i + 1) {
      out += '&';
      i = end + 1;
      afterRun = false;
      continue;
    }
    // Two adjacent shifted runs would be a second spelling of one run.
    if (afterRun) return null;
    let bits = 0;
    let nbits = 0;
    const bytes: number[] = [];
    for (let j = i + 1; j < end; j++) {
      const v = B64_INDEX.get(wire.charCodeAt(j));
      if (v === undefined) return null;
      bits = ((bits << 6) | v) & 0xffffff;
      nbits += 6;
      if (nbits >= 8) {
        nbits -= 8;
        bytes.push((bits >> nbits) & 0xff);
      }
    }
    // Leftover bits must be fewer than 6 and all zero; the octets must pair into UTF-16 units.
    if (nbits >= 6 || (bits & ((1 << nbits) - 1)) !== 0 || bytes.length % 2 !== 0) return null;
    for (let k = 0; k < bytes.length; k += 2) {
      const unit = ((bytes[k] ?? 0) << 8) | (bytes[k + 1] ?? 0);
      if (isDirect(unit)) return null;
      out += String.fromCharCode(unit);
    }
    i = end + 1;
    afterRun = true;
  }
  return out;
}
