// PST-T-14.11: one mapping from "how did this check come out" to a badge, shared by Admin › Health
// and the Inspect drawer so the same result never reads two ways.
//
// @d3cloud/ui's Badge has three tones by design (D-016: no green, no amber), so the four outcomes are
// told apart by tone AND a glyph drawn by CSS (status.css), never by colour alone:
//
//   good     neutral   ✓   OK, pass, "not listed" on a blocklist, TLS, a verified signature
//   unknown  neutral   ?   not yet checked, "none", not signed / not encrypted — no verdict at all
//   warning  attention !   degraded, softfail, temperror, anything short of a pass that is not a fail
//   bad      danger    ✕   down, fail, permerror, listed on a blocklist, a bad signature
//
// Warning is the only attention tone, so it stands apart from Unknown; OK and Unknown share the quiet
// neutral tone and differ by glyph and word.
import type { BadgeTone } from '@d3cloud/ui';

export type StatusKind = 'good' | 'unknown' | 'warning' | 'bad';

export const STATUS_TONE: Readonly<Record<StatusKind, BadgeTone>> = {
  good: 'neutral',
  unknown: 'neutral',
  warning: 'attention',
  bad: 'danger',
};

/** A stored authentication verdict (SPF, DKIM, DMARC, ARC, DNSBL) as a status. */
export function verdictKind(result: string): StatusKind {
  const r = result.trim().toLowerCase();
  if (r === 'pass' || r === 'not listed') return 'good';
  if (r === 'fail' || r === 'permerror' || r === 'listed') return 'bad';
  if (r === 'none' || r === '') return 'unknown';
  return 'warning';
}

/** A tone the crypto view already decided, told apart from "nothing to say" by whether it passed. */
export function toneKind(tone: BadgeTone, passed: boolean): StatusKind {
  if (tone === 'danger') return 'bad';
  if (tone === 'attention') return 'warning';
  return passed ? 'good' : 'unknown';
}
