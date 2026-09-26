// A small, curated UTS #39-style "skeleton" for the Latin/Cyrillic/Greek confusables that show up
// in real lookalike-domain phishing (PST-T-6.5, PST-REQ-120). This is deliberately not the full
// Unicode confusables table (that is thousands of entries and needs no DNS lookup to matter here):
// it covers the handful of letters attackers actually substitute — Cyrillic а/е/о/р/с/х/у/і/ѕ/ј and
// Greek α/β/ε/ι/κ/ν/ο/ρ/τ/υ/χ — plus the ASCII look-alikes (0↔o, 1↔l, 5↔s, 3↔e, rn↔m at the
// "same skeleton" level is out of scope; it needs n-gram logic, not a char map).
//
// `skeleton()` lowercases and maps each code point through this table (identity for anything not
// listed), so `skeleton('paypal.com') === skeleton('раypal.com')` when the Cyrillic а (U+0430)
// replaces the Latin a.

const CONFUSABLES: Record<string, string> = {
  // Cyrillic → Latin
  'а': 'a', // а CYRILLIC SMALL LETTER A
  'е': 'e', // е CYRILLIC SMALL LETTER IE
  'о': 'o', // о CYRILLIC SMALL LETTER O
  'р': 'p', // р CYRILLIC SMALL LETTER ER
  'с': 'c', // с CYRILLIC SMALL LETTER ES
  'х': 'x', // х CYRILLIC SMALL LETTER HA
  'у': 'y', // у CYRILLIC SMALL LETTER U
  'і': 'i', // і CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  'ѕ': 's', // ѕ CYRILLIC SMALL LETTER DZE
  'ј': 'j', // ј CYRILLIC SMALL LETTER JE
  'һ': 'h', // һ CYRILLIC SMALL LETTER SHHA
  'ԁ': 'd', // ԁ CYRILLIC SMALL LETTER KOMI DE
  'ԛ': 'q', // ԛ CYRILLIC SMALL LETTER QA
  'в': 'b', // в CYRILLIC SMALL LETTER VE (loose, but a common lookalike in practice)
  // Greek → Latin
  'α': 'a', // α GREEK SMALL LETTER ALPHA
  'β': 'b', // β GREEK SMALL LETTER BETA
  'ε': 'e', // ε GREEK SMALL LETTER EPSILON
  'ι': 'i', // ι GREEK SMALL LETTER IOTA
  'κ': 'k', // κ GREEK SMALL LETTER KAPPA
  'ν': 'v', // ν GREEK SMALL LETTER NU
  'ο': 'o', // ο GREEK SMALL LETTER OMICRON
  'ρ': 'p', // ρ GREEK SMALL LETTER RHO
  'τ': 't', // τ GREEK SMALL LETTER TAU
  'υ': 'u', // υ GREEK SMALL LETTER UPSILON
  'χ': 'x', // χ GREEK SMALL LETTER CHI
  // ASCII digit/letter confusables
  '0': 'o',
  '1': 'l',
  '5': 's',
  '3': 'e',
};

/** Which script a code point belongs to, for "mixed-script" detection; `'other'` covers ASCII/digits. */
export type Script = 'latin' | 'cyrillic' | 'greek' | 'other';

export function scriptOf(codePoint: number): Script {
  if (codePoint >= 0x0041 && codePoint <= 0x024f) return 'latin';
  if (codePoint >= 0x0370 && codePoint <= 0x03ff) return 'greek';
  if (codePoint >= 0x0400 && codePoint <= 0x04ff) return 'cyrillic';
  return 'other';
}

/** The scripts present in `label`, excluding `'other'` (ASCII digits/punctuation are script-neutral). */
export function scriptsOf(label: string): Set<Script> {
  const out = new Set<Script>();
  for (const ch of label) {
    const s = scriptOf(ch.codePointAt(0) ?? 0);
    if (s !== 'other') out.add(s);
  }
  return out;
}

/** Maps `input` through the confusables table, lowercased first. Unknown characters pass through. */
export function skeleton(input: string): string {
  let out = '';
  for (const ch of input.toLowerCase()) out += CONFUSABLES[ch] ?? ch;
  return out;
}

/** Levenshtein edit distance, capped: returns `cap + 1` once it is certain the distance exceeds `cap`. */
export function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((prev[j] ?? Infinity) + 1, (next[j - 1] ?? Infinity) + 1, (prev[j - 1] ?? Infinity) + cost);
      next.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return cap + 1;
    prev = next;
  }
  return prev[b.length] ?? cap + 1;
}
