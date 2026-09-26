// Sequence sets (RFC 3501 §9 sequence-set, RFC 9051, RFC 5182 "$").

import type { SeqNumber, SeqRange, SequenceSet } from './ast.js';

export const MAX_NZ_NUMBER = 0xffffffff;

function formatSeqNumber(n: SeqNumber): string {
  return n === '*' ? '*' : String(n);
}

/** Wire form: "$", or ranges joined by ",", a range with from === to written as one number. */
export function formatSequenceSet(set: SequenceSet): string {
  if (set.type === 'saved') return '$';
  return set.ranges
    .map((r) => (r.from === r.to ? formatSeqNumber(r.from) : `${formatSeqNumber(r.from)}:${formatSeqNumber(r.to)}`))
    .join(',');
}

/** Parse a sequence set on its own; `null` when it is not one. */
export function parseSequenceSet(text: string): SequenceSet | null {
  if (text === '$') return { type: 'saved' };
  if (text.length === 0) return null;
  const ranges: SeqRange[] = [];
  for (const piece of text.split(',')) {
    const bounds = piece.split(':');
    if (bounds.length > 2) return null;
    const nums: SeqNumber[] = [];
    for (const b of bounds) {
      if (b === '*') nums.push('*');
      else if (/^[1-9][0-9]{0,9}$/.test(b) && Number(b) <= MAX_NZ_NUMBER) nums.push(Number(b));
      else return null;
    }
    const from = nums[0];
    if (from === undefined) return null;
    ranges.push({ from, to: nums[1] ?? from });
  }
  return { type: 'set', ranges };
}

/**
 * Resolve a sequence set against a mailbox: `*` becomes `max` (the largest sequence number or
 * UID), ranges are ordered, sorted and merged. Returns inclusive [lo, hi] pairs, ascending and
 * disjoint, never containing 0. The saved set ("$") must be resolved by the caller; it returns [].
 */
export function normalizeSequenceSet(set: SequenceSet, max: number): [number, number][] {
  if (set.type === 'saved') return [];
  const resolved: [number, number][] = [];
  for (const r of set.ranges) {
    const a = r.from === '*' ? max : r.from;
    const b = r.to === '*' ? max : r.to;
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.max(a, b);
    if (hi >= lo) resolved.push([lo, hi]);
  }
  resolved.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of resolved) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/** Whether `n` is in the set, with `*` meaning `max`. */
export function sequenceSetHas(set: SequenceSet, n: number, max: number): boolean {
  if (set.type === 'saved') return false;
  return set.ranges.some((r) => {
    const a = r.from === '*' ? max : r.from;
    const b = r.to === '*' ? max : r.to;
    return n >= Math.min(a, b) && n <= Math.max(a, b);
  });
}

/** The most compact sequence set naming exactly these numbers (for COPYUID, VANISHED, ESEARCH). */
export function sequenceSetFromNumbers(numbers: Iterable<number>): SequenceSet {
  const sorted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const ranges: SeqRange[] = [];
  let start: number | undefined;
  let prev = 0;
  for (const n of sorted) {
    if (start === undefined) {
      start = n;
    } else if (n !== prev + 1) {
      ranges.push({ from: start, to: prev });
      start = n;
    }
    prev = n;
  }
  if (start !== undefined) ranges.push({ from: start, to: prev });
  return { type: 'set', ranges };
}
