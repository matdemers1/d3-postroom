// The explainable rule pass over `Signals` (PST-ADR-007: no LLM in v1; explainable rules + a
// per-account naive Bayes that PST-T-5.3 adds later). `decide` never returns an empty `reasons`
// array (PST-REQ-103): every filed message's sorting decision stores what produced it.

import type { Signals } from './signals.js';

export type Bucket = 'priority' | 'people' | 'other';

export interface Decision {
  readonly bucket: Bucket;
  readonly reasons: string[];
  readonly scores: Record<string, number>;
}

function scoresOf(signals: Signals): Record<string, number> {
  return {
    bulk: signals.bulk.value ? 1 : 0,
    automated: signals.automated.value ? 1 : 0,
    human: signals.human.value ? 1 : 0,
    directTo: signals.directness.value === 'to' ? 1 : 0,
    directCc: signals.directness.value === 'cc' ? 1 : 0,
    toCount: signals.directness.toCount,
    replyGraph: signals.membership.replyGraph.value ? 1 : 0,
    contact: signals.membership.contact.value ? 1 : 0,
    vip: signals.membership.vip.value ? 1 : 0,
    blocked: signals.membership.blocked.value ? 1 : 0,
    threadReply: signals.threadReply.value ? 1 : 0,
    authenticated: signals.authenticated.value ? 1 : 0,
  };
}

/** Implements PST-REQ-102 (Priority) and PST-REQ-173 (People): Priority requires a human sender in
 * the reply graph, contacts or an authenticated VIP pin, addressed directly (To), and not bulk. A
 * VIP match only counts when the message authenticated — an unauthenticated VIP-name spoof never
 * reaches Priority through that channel alone (a spoofed sender who is also in the reply graph or
 * contacts still can, since that channel does not require authentication). Human mail that misses
 * Priority is People (PST-REQ-173); anything else — bulk, automated, or a first-time human who is
 * also not directly addressed — is left as Other for the later stages (naive Bayes, Feeds, Receipts)
 * to refine. */
export function decide(signals: Signals): Decision {
  const reasons: string[] = [];
  const scores = scoresOf(signals);

  if (signals.membership.blocked.value) {
    reasons.push(signals.membership.blocked.reason);
    reasons.push('other: sender is blocked');
    return { bucket: 'other', reasons, scores };
  }

  if (signals.bulk.value) reasons.push(signals.bulk.reason);
  if (signals.automated.value) reasons.push(signals.automated.reason);
  reasons.push(signals.human.reason);

  if (!signals.human.value) {
    reasons.push('other: not a human sender');
    return { bucket: 'other', reasons, scores };
  }

  const replyGraphOrContact = signals.membership.replyGraph.value || signals.membership.contact.value;
  const vipMatch = signals.membership.vip.value;
  const vipCounts = vipMatch && signals.authenticated.value;

  if (replyGraphOrContact) reasons.push(signals.membership.replyGraph.value ? signals.membership.replyGraph.reason : signals.membership.contact.reason);
  if (vipMatch) {
    reasons.push(signals.membership.vip.reason);
    reasons.push(signals.authenticated.value ? signals.authenticated.reason : `${signals.authenticated.reason}; VIP match does not count unauthenticated`);
  }

  const known = replyGraphOrContact || vipCounts;
  if (!known) {
    reasons.push('people: human sender not in reply graph, contacts, or an authenticated VIP pin');
    return { bucket: 'people', reasons, scores };
  }

  reasons.push(signals.directness.reason);
  if (signals.directness.value !== 'to') {
    reasons.push('people: known sender but not addressed directly (To)');
    return { bucket: 'people', reasons, scores };
  }

  if (signals.bulk.value) {
    reasons.push('people: known sender but message is bulk');
    return { bucket: 'people', reasons, scores };
  }

  reasons.push('priority: human, known sender, addressed directly, not bulk');
  return { bucket: 'priority', reasons, scores };
}
