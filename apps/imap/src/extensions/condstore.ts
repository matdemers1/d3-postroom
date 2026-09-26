// CONDSTORE (RFC 7162 §3.1; PST-REQ-071).
//
// Every mailbox always tracks mod-sequences (store.ts), so there is never a NOMODSEQ. What changes
// once a session is "CONDSTORE-aware" is what it is told: MODSEQ rides along in every untagged FETCH
// that carries FLAGS (solicited or not), STORE answers include MODSEQ, and SEARCH / ESEARCH with a
// MODSEQ criterion report the highest mod-sequence of what they return.
//
// A session becomes aware through ENABLE CONDSTORE (or ENABLE QRESYNC) or, implicitly, through the
// first "CONDSTORE enabling command" (§3.1): SELECT/EXAMINE (CONDSTORE), STATUS (HIGHESTMODSEQ),
// FETCH with MODSEQ or CHANGEDSINCE, SEARCH MODSEQ, STORE (UNCHANGEDSINCE).
import type { Command, FetchAtt, SearchKey } from '@postroom/imap-proto';
import { fetchItems } from '@postroom/imap-proto';
import type { ImapExtension } from '../capabilities.js';

export const CONDSTORE = 'CONDSTORE';

export const condstoreExtension: ImapExtension = {
  name: CONDSTORE,
  capabilities: (s) => (s.authenticated ? [CONDSTORE] : []),
  enables: [CONDSTORE],
};

/** Does any criterion (at any depth) use MODSEQ? */
export function mentionsModseq(keys: readonly SearchKey[]): boolean {
  return keys.some((k) => {
    switch (k.type) {
      case 'MODSEQ':
        return true;
      case 'NOT':
        return mentionsModseq([k.key]);
      case 'OR':
        return mentionsModseq([k.left, k.right]);
      case 'AND':
        return mentionsModseq(k.keys);
      default:
        return false;
    }
  });
}

/** Is this a CONDSTORE enabling command (RFC 7162 §3.1)? */
export function enablesCondstore(cmd: Command): boolean {
  switch (cmd.name) {
    case 'SELECT':
    case 'EXAMINE':
      return cmd.condstore || cmd.qresync !== null;
    case 'STATUS':
      return cmd.items.includes('HIGHESTMODSEQ');
    case 'FETCH':
      return cmd.changedSince !== null || fetchItems(cmd).some((i) => i.type === 'MODSEQ');
    case 'SEARCH':
      return mentionsModseq(cmd.criteria);
    case 'STORE':
      return cmd.unchangedSince !== null;
    default:
      return false;
  }
}

/**
 * The FETCH a CONDSTORE-aware session gets: MODSEQ added whenever FLAGS is asked for, and whenever
 * CHANGEDSINCE is used (which implies it, §3.1.4.1).
 */
export function withModseq(cmd: Extract<Command, { name: 'FETCH' }>, aware: boolean): Extract<Command, { name: 'FETCH' }> {
  const items: FetchAtt[] = fetchItems(cmd);
  if (items.some((i) => i.type === 'MODSEQ')) return cmd;
  const wants = cmd.changedSince !== null || (aware && items.some((i) => i.type === 'FLAGS'));
  if (!wants) return cmd;
  return { ...cmd, macro: null, items: [...items, { type: 'MODSEQ' }] };
}
