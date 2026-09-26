// A session's view of its selected mailbox: the sequence-number → UID map the client believes in,
// and what it has been told about each message (PST-REQ-070, PST-REQ-072).
//
// Other sessions change the mailbox underneath. `sync` compares the view with the database and
// produces the untagged responses that bring the client up to date:
//   - expunges, as "* n EXPUNGE" — only when the command allows them. RFC 9051 §7.5.1 forbids an
//     EXPUNGE while answering FETCH, STORE or SEARCH (the non-UID forms), and when none is in
//     progress, because the client would renumber mid-response. Until then an expunged message stays
//     in the view as a placeholder (it still has its sequence number; FETCH skips it and answers
//     [EXPUNGEISSUED]).
//   - new messages, as "* n EXISTS";
//   - flag changes, as "* n FETCH (UID u FLAGS (...))".
// Detection is by polling the mailbox row at command boundaries (NOOP, and after every command);
// IDLE's push (extensions/idle.ts) calls the same `sync` when the mailbox is notified.
// Once CONDSTORE is enabled a flag change carries MODSEQ; once QRESYNC is, expunges are announced
// as "* VANISHED uids" instead (RFC 7162 §3.2.10), under the same restrictions as EXPUNGE.
import { fetchResponse, normalizeSequenceSet, numberResponse, vanishedResponse, type FetchResponseItem, type Response, type SequenceSet } from '@postroom/imap-proto';
import type { MailStore } from './store.js';

export interface SyncOptions {
  /** May "* n EXPUNGE" be sent now? */
  readonly allowExpunge: boolean;
  readonly utf8: boolean;
  /** CONDSTORE is enabled: FETCH FLAGS carries MODSEQ. */
  readonly condstore?: boolean;
  /** QRESYNC is enabled: VANISHED instead of EXPUNGE. */
  readonly qresync?: boolean;
}

export type SyncOutcome = { readonly gone: false; readonly responses: Response[] } | { readonly gone: true };

export class MailboxView {
  /** Sequence number − 1 → UID, ascending; includes expunged placeholders. */
  private uids: number[] = [];
  /** UID → the modseq the client last heard about. */
  private readonly known = new Map<number, bigint>();
  /** UIDs expunged in the database whose EXPUNGE the client has not been sent. */
  private readonly pending = new Set<number>();
  private highestModseq = 0n;

  constructor(
    readonly mailboxId: string,
    readonly name: string,
    readonly uidvalidity: number,
    readonly readOnly: boolean,
  ) {}

  /** Load the view at SELECT time. */
  static async open(
    store: MailStore,
    mb: { id: string; name: string; uidvalidity: number; highestModseq: bigint },
    readOnly: boolean,
  ): Promise<{ view: MailboxView; firstUnseen: number | null; highestModseq: bigint; uidnext: number }> {
    const view = new MailboxView(mb.id, mb.name, mb.uidvalidity, readOnly);
    // Read the modseq first: a change racing the snapshot is then seen again at the next sync.
    const probe = await store.probe(mb.id);
    const rows = await store.snapshot(mb.id);
    let firstUnseen: number | null = null;
    rows.forEach((r, i) => {
      view.uids.push(r.uid);
      view.known.set(r.uid, r.modseq);
      if (!r.seen && firstUnseen === null) firstUnseen = i + 1;
    });
    view.highestModseq = probe?.highestModseq ?? mb.highestModseq;
    const uidnext = Math.max(probe?.uidnext ?? 1, view.maxUid + 1);
    return { view, firstUnseen, highestModseq: view.highestModseq, uidnext };
  }

  get exists(): number {
    return this.uids.length;
  }

  get maxUid(): number {
    return this.uids[this.uids.length - 1] ?? 0;
  }

  /** Live UIDs (placeholders excluded), ascending. */
  liveUids(): number[] {
    return this.uids.filter((u) => !this.pending.has(u));
  }

  isExpunged(uid: number): boolean {
    return this.pending.has(uid);
  }

  seqOf(uid: number): number | null {
    let lo = 0;
    let hi = this.uids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.uids[mid] ?? 0;
      if (v === uid) return mid + 1;
      if (v < uid) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  uidAt(seq: number): number | null {
    return this.uids[seq - 1] ?? null;
  }

  /** Remember what the client was just told (our own STORE / FETCH). */
  noteModseq(uid: number, modseq: bigint): void {
    if (this.known.has(uid)) this.known.set(uid, modseq);
  }

  /**
   * Message sequence numbers → [seq, uid] pairs (placeholders included; callers decide), ascending.
   * `saved` is the SEARCHRES result, as UIDs.
   */
  resolveSeqs(set: SequenceSet, saved: readonly number[] | null): [number, number][] {
    if (set.type === 'saved') return this.pairsForUids(saved ?? []);
    const out: [number, number][] = [];
    if (this.uids.length === 0) return out;
    for (const [lo, hi] of normalizeSequenceSet(set, this.uids.length)) {
      for (let s = lo; s <= Math.min(hi, this.uids.length); s++) {
        const uid = this.uids[s - 1];
        if (uid !== undefined) out.push([s, uid]);
      }
    }
    return out;
  }

  /** UIDs → [seq, uid] pairs for the messages in the view, ascending. `*` is the largest UID. */
  resolveUids(set: SequenceSet, saved: readonly number[] | null): [number, number][] {
    if (set.type === 'saved') return this.pairsForUids(saved ?? []);
    const out: [number, number][] = [];
    if (this.uids.length === 0) return out;
    for (const [lo, hi] of normalizeSequenceSet(set, this.maxUid)) {
      let i = this.lowerBound(lo);
      for (; i < this.uids.length; i++) {
        const uid = this.uids[i] ?? 0;
        if (uid > hi) break;
        out.push([i + 1, uid]);
      }
    }
    return out;
  }

  private pairsForUids(uids: readonly number[]): [number, number][] {
    const out: [number, number][] = [];
    for (const u of [...uids].sort((a, b) => a - b)) {
      const s = this.seqOf(u);
      if (s !== null) out.push([s, u]);
    }
    return out;
  }

  private lowerBound(uid: number): number {
    let lo = 0;
    let hi = this.uids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.uids[mid] ?? 0) < uid) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Our own EXPUNGE / MOVE removed these: answer "* n EXPUNGE" now (descending, so no renumbering),
   * or one "* VANISHED uids" under QRESYNC.
   */
  expungeNow(uids: readonly number[], vanished = false): Response[] {
    const out: Response[] = [];
    const seqs: number[] = [];
    if (vanished) {
      const gone: number[] = [];
      for (const u of uids) {
        const s = this.seqOf(u);
        if (s === null) continue;
        this.uids.splice(s - 1, 1);
        this.known.delete(u);
        this.pending.delete(u);
        gone.push(u);
      }
      if (gone.length > 0) out.push(vanishedResponse(gone.sort((a, b) => a - b), false));
      return out;
    }
    for (const u of uids) {
      const s = this.seqOf(u);
      if (s !== null) seqs.push(s);
    }
    seqs.sort((a, b) => b - a);
    for (const s of seqs) {
      const uid = this.uids[s - 1];
      this.uids.splice(s - 1, 1);
      if (uid !== undefined) {
        this.known.delete(uid);
        this.pending.delete(uid);
      }
      out.push(numberResponse(s, 'EXPUNGE'));
    }
    return out;
  }

  /** Deliver pending expunges (a command that allows them is completing). */
  private flushPending(vanished: boolean): Response[] {
    if (this.pending.size === 0) return [];
    return this.expungeNow([...this.pending], vanished);
  }

  async sync(store: MailStore, opts: SyncOptions): Promise<SyncOutcome> {
    const probe = await store.probe(this.mailboxId);
    if (probe === null) return { gone: true };
    const responses: Response[] = [];
    if (probe.highestModseq === this.highestModseq) {
      if (opts.allowExpunge) responses.push(...this.flushPending(opts.qresync === true));
      return { gone: false, responses };
    }
    const since = this.highestModseq;
    const changed = await store.changedSince(this.mailboxId, since);
    const maxUid = this.maxUid;
    // Expunges: only UIDs we know about can have gone; count first, list only when something did.
    const known = this.uids.length - this.pending.size;
    if (known > 0 && (await store.countUpTo(this.mailboxId, maxUid)) !== known) {
      const present = new Set(await store.uidsUpTo(this.mailboxId, maxUid));
      for (const u of this.uids) if (!present.has(u)) this.pending.add(u);
    }
    if (opts.allowExpunge) responses.push(...this.flushPending(opts.qresync === true));
    // Arrivals: UIDs above everything we know, in UID order.
    const arrivals = changed.filter((r) => r.uid > maxUid);
    for (const r of arrivals) {
      this.uids.push(r.uid);
      this.known.set(r.uid, r.modseq);
    }
    if (arrivals.length > 0) responses.push(numberResponse(this.uids.length, 'EXISTS'));
    // Flag changes to messages the client already has.
    for (const r of changed) {
      if (r.uid > maxUid || this.pending.has(r.uid)) continue;
      const seen = this.known.get(r.uid);
      if (seen !== undefined && r.modseq <= seen) continue;
      const seq = this.seqOf(r.uid);
      if (seq === null) continue;
      this.known.set(r.uid, r.modseq);
      const items: FetchResponseItem[] = [
        { name: 'UID', value: r.uid },
        { name: 'FLAGS', flags: r.flags },
      ];
      if (opts.condstore === true) items.push({ name: 'MODSEQ', value: r.modseq });
      responses.push(fetchResponse(seq, items));
    }
    this.highestModseq = probe.highestModseq;
    return { gone: false, responses };
  }
}
