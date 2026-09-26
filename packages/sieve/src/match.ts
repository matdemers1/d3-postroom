// Comparators (RFC 4790 via RFC 5228 §2.7.3) and match types (RFC 5228 §2.7.1).
//
//   i;octet          exact code-unit comparison
//   i;ascii-casemap  A–Z folded to a–z first, everything else compared exactly
//
//   :is        equality
//   :contains  substring (the empty key is contained in everything)
//   :matches   glob: `*` is any run of characters, `?` exactly one, `\` escapes the next character
//
// `:matches` also returns what each wildcard matched, for the variables extension's `${1}` … (RFC
// 5229 §3.2). Each wildcard matches as little as it can, left to right — the RFC's own example
// ("[*] *" against "[acme-users] [fwd] version 1.0 is out" gives ${1} = "acme-users") needs exactly
// that. The algorithm is the classic linear-space glob with a single backtrack point (the last `*`),
// which is both correct for a boolean answer and yields the leftmost-shortest captures, in O(n·m)
// time; every step is charged to a work budget so a hostile script cannot spin.

export type Comparator = 'i;octet' | 'i;ascii-casemap';
export type MatchType = 'is' | 'contains' | 'matches';

export interface Budget {
  /** Charge `n` units of work; throws when the script has spent its allowance. */
  charge(n: number): void;
}

export function foldAscii(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

interface PatternPiece {
  readonly kind: 'lit' | 'star' | 'one';
  readonly ch: string;
}

function compilePattern(pattern: string): PatternPiece[] {
  const out: PatternPiece[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '\\' && i + 1 < pattern.length) {
      out.push({ kind: 'lit', ch: pattern[i + 1] as string });
      i++;
    } else if (ch === '*') {
      out.push({ kind: 'star', ch });
    } else if (ch === '?') {
      out.push({ kind: 'one', ch });
    } else {
      out.push({ kind: 'lit', ch });
    }
  }
  return out;
}

/**
 * Glob match. Returns null on no match, else the [start, end) range of each wildcard, in pattern
 * order.
 */
export function globRanges(text: string, pattern: string, budget: Budget): [number, number][] | null {
  const p = compilePattern(pattern);
  const wildcardIndex: number[] = [];
  let wildcards = 0;
  for (const piece of p) wildcardIndex.push(piece.kind === 'lit' ? -1 : wildcards++);
  const ranges: [number, number][] = [];
  for (let w = 0; w < wildcards; w++) ranges.push([0, 0]);

  let ti = 0;
  let pi = 0;
  let starP = -1; // index in p of the last star seen
  let starT = 0; // text index where that star's match currently ends
  while (ti < text.length) {
    budget.charge(1);
    const piece = p[pi];
    if (piece !== undefined && piece.kind === 'star') {
      ranges[wildcardIndex[pi] as number] = [ti, ti];
      starP = pi;
      starT = ti;
      pi++;
    } else if (piece !== undefined && piece.kind === 'one') {
      // One character: a surrogate pair counts as one.
      const c = text.charCodeAt(ti);
      const width = c >= 0xd800 && c <= 0xdbff && ti + 1 < text.length ? 2 : 1;
      ranges[wildcardIndex[pi] as number] = [ti, ti + width];
      pi++;
      ti += width;
    } else if (piece !== undefined && piece.kind === 'lit' && piece.ch === text[ti]) {
      pi++;
      ti++;
    } else if (starP >= 0) {
      // Grow the last star by one character and retry everything after it.
      starT++;
      const w = wildcardIndex[starP] as number;
      ranges[w] = [(ranges[w] as [number, number])[0], starT];
      pi = starP + 1;
      ti = starT;
    } else {
      return null;
    }
  }
  while (pi < p.length && (p[pi] as PatternPiece).kind === 'star') {
    ranges[wildcardIndex[pi] as number] = [text.length, text.length];
    pi++;
  }
  if (pi !== p.length) return null;
  return ranges;
}

/**
 * Glob match. Returns null on no match, else the captures: index 0 is the whole value, then one
 * entry per wildcard in pattern order.
 */
export function globMatch(text: string, pattern: string, budget: Budget): string[] | null {
  const ranges = globRanges(text, pattern, budget);
  if (ranges === null) return null;
  return [text, ...ranges.map(([a, b]) => text.slice(a, b))];
}

export interface MatchOutcome {
  readonly matched: boolean;
  /** Set for a successful `:matches`. */
  readonly captures: string[] | null;
}

const NO: MatchOutcome = { matched: false, captures: null };

/** Compare one value against one key. */
export function matchOne(value: string, key: string, type: MatchType, comparator: Comparator, budget: Budget): MatchOutcome {
  const v = comparator === 'i;ascii-casemap' ? foldAscii(value) : value;
  const k = comparator === 'i;ascii-casemap' ? foldAscii(key) : key;
  switch (type) {
    case 'is':
      budget.charge(1 + Math.min(v.length, k.length));
      return v === k ? { matched: true, captures: null } : NO;
    case 'contains':
      budget.charge(1 + v.length + k.length);
      return v.includes(k) ? { matched: true, captures: null } : NO;
    case 'matches': {
      // Case folding never changes length, so the ranges found on the folded value slice the original.
      const ranges = globRanges(v, k, budget);
      if (ranges === null) return NO;
      return { matched: true, captures: [value, ...ranges.map(([a, b]) => value.slice(a, b))] };
    }
  }
}

/** Every value against every key; the first match wins (and its captures are the ones kept). */
export function matchAny(values: readonly string[], keys: readonly string[], type: MatchType, comparator: Comparator, budget: Budget): MatchOutcome {
  for (const value of values) {
    for (const key of keys) {
      const r = matchOne(value, key, type, comparator, budget);
      if (r.matched) return r;
    }
  }
  return NO;
}
