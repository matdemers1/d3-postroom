// RFC 1035 §4.1.4 name encoding/decoding, including compression-pointer decompression.
// decodeName never throws and never loops forever: pointer targets are deduplicated, a hard cap
// bounds the number of jumps, and every offset is bounds-checked before it is read.

const MAX_NAME_OCTETS = 255;
const MAX_LABEL_OCTETS = 63;
const MAX_POINTER_JUMPS = 128;
const POINTER_MASK = 0xc0;

export type DecodeNameResult = { ok: true; name: string; end: number } | { ok: false; error: string };

function decodeLabel(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

/** Decode a (possibly compressed) domain name starting at `start` within the full message `buf`.
 * `end` is the offset immediately after the name as it appears in the original stream (i.e. after
 * the terminating zero byte, or after the two-byte pointer that redirected elsewhere) — this is
 * what callers advance their cursor by, regardless of how many pointer jumps were followed. */
export function decodeName(buf: Uint8Array, start: number): DecodeNameResult {
  const labels: string[] = [];
  let offset = start;
  let end: number | null = null;
  let jumps = 0;
  let totalOctets = 0;
  const visitedPointers = new Set<number>();

  for (;;) {
    if (offset < 0 || offset >= buf.length) {
      return { ok: false, error: `name offset ${String(offset)} out of bounds` };
    }
    const lengthByte = buf[offset];
    if (lengthByte === undefined) {
      return { ok: false, error: 'name offset out of bounds' };
    }
    if (lengthByte === 0) {
      end ??= offset + 1;
      break;
    }
    const top2 = lengthByte & POINTER_MASK;
    if (top2 === POINTER_MASK) {
      const second = buf[offset + 1];
      if (second === undefined) {
        return { ok: false, error: 'truncated compression pointer' };
      }
      const pointer = ((lengthByte & 0x3f) << 8) | second;
      end ??= offset + 2;
      jumps += 1;
      if (jumps > MAX_POINTER_JUMPS) {
        return { ok: false, error: 'too many compression pointer jumps' };
      }
      if (visitedPointers.has(pointer)) {
        return { ok: false, error: 'compression pointer loop detected' };
      }
      visitedPointers.add(pointer);
      offset = pointer;
      continue;
    }
    if (top2 !== 0x00) {
      return { ok: false, error: 'reserved label length prefix' };
    }
    const labelLength = lengthByte & 0x3f;
    const labelStart = offset + 1;
    const labelEnd = labelStart + labelLength;
    if (labelEnd > buf.length) {
      return { ok: false, error: 'truncated label' };
    }
    totalOctets += labelLength + 1;
    if (totalOctets > MAX_NAME_OCTETS) {
      return { ok: false, error: 'name exceeds 255 octets' };
    }
    labels.push(decodeLabel(buf.subarray(labelStart, labelEnd)));
    offset = labelEnd;
  }

  // The loop only exits via `break`, which always runs `end ??= offset + 1` first.
  return { ok: true, name: labels.length === 0 ? '.' : labels.join('.'), end };
}

/** Encode a presentation-format name (e.g. "example.com." or "example.com") with no compression;
 * queries always spell the question name out in full. */
export function encodeName(name: string): Uint8Array {
  const trimmed = name === '.' ? '' : name.replace(/\.$/, '');
  const labels = trimmed.length === 0 ? [] : trimmed.split('.');
  const out: number[] = [];
  let total = 0;
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length === 0) {
      throw new RangeError(`empty DNS label in name "${name}"`);
    }
    if (bytes.length > MAX_LABEL_OCTETS) {
      throw new RangeError(`DNS label exceeds 63 octets in name "${name}"`);
    }
    total += bytes.length + 1;
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  total += 1;
  if (total > MAX_NAME_OCTETS) {
    throw new RangeError(`DNS name "${name}" exceeds 255 octets`);
  }
  return Uint8Array.from(out);
}

/** Case-insensitive, trailing-dot-insensitive comparison per RFC 1035 §3.1. */
export function normalizeName(name: string): string {
  const lower = name.toLowerCase();
  return lower === '.' ? '' : lower.replace(/\.$/, '');
}
