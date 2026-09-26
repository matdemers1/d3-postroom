// A minimal, pure RFC 3492 punycode decoder — no DNS, no dependency, just the bootstring algorithm
// — used only to look inside an `xn--` label so a mixed-script IDN can state which scripts it mixes
// (PST-T-6.5, PST-REQ-120). Never throws: a malformed label decodes to `null`.

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = '-';

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) / 2) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digitValue(codeUnit: number): number | null {
  if (codeUnit >= 0x30 && codeUnit <= 0x39) return codeUnit - 0x30 + 26; // 0-9
  if (codeUnit >= 0x41 && codeUnit <= 0x5a) return codeUnit - 0x41; // A-Z
  if (codeUnit >= 0x61 && codeUnit <= 0x7a) return codeUnit - 0x61; // a-z
  return null;
}

/** Decode one punycode label (without its `xn--` prefix) to the Unicode string it encodes. */
export function decodePunycode(input: string): string | null {
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  const output: number[] = [];

  const lastDelimiter = input.lastIndexOf(DELIMITER);
  const basic = lastDelimiter < 0 ? '' : input.slice(0, lastDelimiter);
  for (const ch of basic) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x80) return null; // basic code points must be ASCII
    output.push(code);
  }

  let pos = lastDelimiter < 0 ? 0 : lastDelimiter + 1;
  const n_ = input.length;
  while (pos < n_) {
    const oldI = i;
    let w = 1;
    let k = BASE;
    for (;;) {
      if (pos >= n_) return null;
      const digit = digitValue(input.charCodeAt(pos));
      pos++;
      if (digit === null) return null;
      i += digit * w;
      if (i < 0 || i > Number.MAX_SAFE_INTEGER) return null;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      k += BASE;
    }
    bias = adapt(i - oldI, output.length + 1, oldI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n < 0 || n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i++;
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
}

/** Decode one DNS label: `xn--...` → the Unicode label; anything else is returned unchanged. */
export function decodeIdnLabel(label: string): string | null {
  const lower = label.toLowerCase();
  if (!lower.startsWith('xn--')) return label;
  return decodePunycode(lower.slice(4));
}
