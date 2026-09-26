// QRESYNC (RFC 7162 §3.2; PST-REQ-071).
//
// A client that remembers (UIDVALIDITY, HIGHESTMODSEQ) of a mailbox resynchronises in one round
// trip: SELECT box (QRESYNC (uidvalidity modseq [known-uids])) answers, beside the usual SELECT
// data, "* VANISHED (EARLIER) <uids>" for every message expunged since that modseq, and a FETCH
// (UID FLAGS MODSEQ) for every message changed since it. The expunged UIDs come from
// expunged_message, which store.ts writes in the same transaction as every EXPUNGE and MOVE-out.
// When the UIDVALIDITY does not match, the cache is worthless and the SELECT is a plain one.
//
// Once QRESYNC is enabled (ENABLE QRESYNC, which implies CONDSTORE):
//   - expunges are announced as "* VANISHED <uids>" instead of "* n EXPUNGE";
//   - UID FETCH … (CHANGEDSINCE m VANISHED) reports the UIDs of the set expunged since m first;
//   - selecting another mailbox closes the current one with "* OK [CLOSED]".
// seq-match data is accepted and not needed: expunged_message keeps every expunge, so the VANISHED
// answer is always exact.
import { fetchResponse, sequenceSetHas, vanishedResponse, type QresyncParams, type Response, type SequenceSet } from '@postroom/imap-proto';
import type { ImapExtension } from '../capabilities.js';
import type { MailStore } from '../store.js';
import type { MailboxView } from '../view.js';

export const QRESYNC = 'QRESYNC';

export const qresyncExtension: ImapExtension = {
  name: QRESYNC,
  capabilities: (s) => (s.authenticated ? [QRESYNC] : []),
  enables: [QRESYNC],
};

/** UIDs of `set` (or all, when null) expunged from the mailbox after `since`, ascending. */
export async function vanishedSince(store: MailStore, mailboxId: string, since: bigint, set: SequenceSet | null, uidnext: number): Promise<number[]> {
  const uids = await store.expungedSince(mailboxId, since);
  if (set === null) return uids;
  const max = Math.max(uidnext - 1, 1);
  return uids.filter((u) => sequenceSetHas(set, u, max));
}

/**
 * The QRESYNC part of a SELECT answer (RFC 7162 §3.2.5), sent after the usual responses; nothing
 * when the UIDVALIDITY the client remembers is not the mailbox's.
 */
export async function qresyncSelectResponses(store: MailStore, view: MailboxView, params: QresyncParams, uidnext: number): Promise<Response[]> {
  if (params.uidValidity !== view.uidvalidity) return [];
  const out: Response[] = [];
  const known = params.knownUids;
  const max = Math.max(uidnext - 1, 1);
  const inKnown = (uid: number): boolean => known === null || sequenceSetHas(known, uid, max);
  const gone = await vanishedSince(store, view.mailboxId, params.modseq, known, uidnext);
  if (gone.length > 0) out.push(vanishedResponse(gone, true));
  for (const r of await store.changedSince(view.mailboxId, params.modseq)) {
    if (!inKnown(r.uid)) continue;
    const seq = view.seqOf(r.uid);
    if (seq === null) continue;
    view.noteModseq(r.uid, r.modseq);
    out.push(
      fetchResponse(seq, [
        { name: 'UID', value: r.uid },
        { name: 'FLAGS', flags: r.flags },
        { name: 'MODSEQ', value: r.modseq },
      ]),
    );
  }
  return out;
}
