// The three-pane webmail (PST-REQ-077): mailboxes in the shell's sidebar, the message list, and the
// reading pane. From tablet width the list and the reader sit side by side; below it the view is
// push navigation — mailboxes → list → message — with the URL naming each step, so the browser's
// back button walks it. Gmail's keys drive it (PST-REQ-084), and the list follows the server live
// over SSE (PST-REQ-083). Flag changes and moves are optimistic, and a refused write (412/409)
// refetches rather than guessing.
//
// PST-T-14.5 (PST-REQ-190, PST-REQ-192, PST-REQ-193, PST-ADR-011) — the triage loop. Archive, Delete,
// Move and Snooze, from a key, a row's actions, the selection toolbar, the reading pane or the palette,
// all go through triage() below:
//  - the scope: the x-selection when there is one; else, for the OPEN message, every member of its
//    thread in the same mailbox (the list stays per-message; one e files the whole conversation);
//    else the one row it was asked for;
//  - the rows leave on --motion-row-exit over their fixed slots, then drop in one frame;
//  - the NEXT message opens at once: the one below (older), or above when nothing below is left;
//  - a Toast says what happened and offers Undo (z), which moves each moved copy — by the NEW id the
//    server gave it in the destination — back where it came from, on the server.
import { useCallback, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, type SyntheticEvent } from 'react';
import { Link as RouterLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, EmptyState, IconButton, SearchField, SegmentedControl, Skeleton, Stack, useToast } from '@d3cloud/ui';
import { api, ApiError, serverUnreachable, type Mailbox, type MailboxSplit, type MessageDetail, type MessageSummary } from '../api';
import { CommandPalette } from './CommandPalette';
import { Composer } from './Composer';
import { draftFor, draftToResume } from './compose';
import { composerKey } from './compose/session';
import { Feed } from './Feed';
import { findSpecial, mailboxLabel } from './format';
import { ComposeIcon, mailboxIcon, SearchIcon } from './icons';
import { describeTarget, resolveKey, type MailAction } from './keys';
import { applyFlags, FLAGGED, initialList, isStarred, isUnread, listReducer, SEEN, sortsAboveTop } from './list';
import { useMail } from './MailContext';
import { SelectionToolbar } from './list/SelectionToolbar';
import { TriageList, type RowAction, type TriageListHandle } from './list/TriageList';
import { TriagePicker, type PickerMode } from './list/TriagePicker';
import {
  holdBackArrivals,
  mergeMembers,
  nextAfterRemoval,
  pruneSelected,
  selectedMessages,
  threadMembersInMailbox,
  toggleSelected,
  triageMessage,
  undoPatches,
  type MovedRecord,
  type RowSummary,
} from './list/triage';
import './list/list.css';
import { ReadingPane, type OpenMessage } from './ReadingPane';
import { ScheduledSends, UndoSendToast } from './Scheduled';
import { SnoozeIconControl } from './thread/ThreadToolbar';
import { MobileActionBar } from './thread/MobileActionBar';
import { mailSidebar } from './sidebar';
import { ContextBar, PushFrame, usePushDirection } from '../mobile/ContextBar';
import { PhoneAccountMenu, PushRow } from '../mobile/PlaceIndex';
import { pushDepth } from '../mobile/push';
import { composesInPane, draftPath, mailPath, narrowView, parseMailRoute, type ComposeMode, type MailRoute } from './route';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { emptyMailboxCopy, inSegment, isInboxSegment, segmentItems, segmentKeyword, type InboxSegment } from './split';
import { showsKeyHints, SPLIT_QUERY, useMediaQuery } from './useMedia';
import { SessionEnded } from '../screens/states';
// PST-T-14.9: sorting you can see and correct where you read.
import { sortingApi } from './sorting/api';
import { SortingContext, type SortingActions } from './sorting/SortingContext';
import { BUCKET_LABEL, chipShows, correctedMessage, isFilingBucket, listKeeps, loadSegment, mailboxBucket, saveSegment, type ChipContext, type FilingBucket } from './sorting/sorting';
import { WhyPopover } from './sorting/WhyPopover';
import './sorting/sorting.css';

const PAGE = 50;
/** --motion-row-exit's duration: a leaving row's slot is dropped when its content has faded out. */
const EXIT_MS = 180;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

type Notice = { tone: 'info' | 'danger'; text: string; key: number };

/** A detail as a list row: the summary's fields, including the ones the web type does not name yet
 *  (newSender, expiresAt), without the detail-only ones. */
function summaryOf(m: MessageDetail | MessageSummary): RowSummary {
  const extra = m as RowSummary;
  return {
    id: m.id,
    mailboxId: m.mailboxId,
    uid: m.uid,
    modseq: m.modseq,
    threadId: m.threadId,
    subject: m.subject,
    from: m.from,
    fromName: m.fromName ?? null,
    snippet: m.snippet ?? null,
    date: m.date,
    internalDate: m.internalDate,
    size: m.size,
    flags: m.flags,
    bucket: m.bucket,
    ...(extra.newSender === undefined ? {} : { newSender: extra.newSender }),
    ...(extra.hasAttachments === undefined ? {} : { hasAttachments: extra.hasAttachments }),
    ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
  };
}

export function MailView() {
  const location = useLocation();
  const route = parseMailRoute(location.pathname, location.search);
  if (route === null) return <Navigate to="/" replace />;
  return <MailPanes route={route} />;
}

function MailPanes({ route }: { route: MailRoute }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { mailboxes, mailboxesFailed, refreshMailboxes, me, subscribe } = useMail();
  const split = useMediaQuery(SPLIT_QUERY);

  const inbox = mailboxes === null ? undefined : (findSpecial(mailboxes, 'inbox') ?? mailboxes[0]);
  const mailboxId = route.mailboxId ?? inbox?.id ?? null;
  const mailbox: Mailbox | null = mailboxes?.find((m) => m.id === mailboxId) ?? null;
  const archive = mailboxes === null ? undefined : findSpecial(mailboxes, 'archive');
  const trash = mailboxes === null ? undefined : findSpecial(mailboxes, 'trash');
  const junk = mailboxes === null ? undefined : findSpecial(mailboxes, 'junk');

  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const [listSignedOut, setListSignedOut] = useState(false);
  const [list, dispatch] = useReducer(listReducer, initialList);
  const [open, setOpen] = useState<OpenMessage | null>(null);
  const [openReload, setOpenReload] = useState(0);
  // PST-T-14.7: bumped when an inline reply is sent, so the open thread is asked for again.
  const [replyEpoch, setReplyEpoch] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // PST-T-14.5: the x-selection, the rows on their way out, mail held behind the "N new" pill, and
  // the Move/Snooze picker (with the row it was opened for, if any).
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<MessageSummary[]>([]);
  const [picker, setPicker] = useState<{ mode: PickerMode; explicit: MessageSummary | null } | null>(null);
  const toast = useToast();
  const undoRef = useRef<{ id: string; run: () => void } | null>(null);
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  // PST-T-11.4: the Inbox's Priority / People split. Held here, not in the URL, so opening a message
  // (a new URL under the same layout route) keeps the segment; Everything is the default.
  // PST-T-14.9: still Everything by default (the reply graph is young), but each browser remembers
  // the last segment it used (localStorage, and quietly nothing when storage is unavailable).
  const [segment, setSegmentState] = useState<InboxSegment>(loadSegment);
  const setSegment = (next: InboxSegment) => {
    setSegmentState(next);
    saveSegment(next);
  };
  // PST-T-14.9: the row chip's "Why it's here" popover, for the message whose chip was clicked.
  const [why, setWhy] = useState<{ message: MessageSummary; anchor: DOMRect } | null>(null);
  const [inboxSplit, setInboxSplit] = useState<MailboxSplit | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<TriageListHandle>(null);
  const readerHeading = useRef<HTMLHeadingElement>(null);
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pendingKey = useRef<'g' | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const loadingMore = useRef(false);
  const markedSeen = useRef(new Set<string>());
  const seenModseq = useRef(new Map<string, string>());
  const noticeKey = useRef(0);
  /** The newest MODSEQ each written message has, so a queued write never sends a stale If-Match
   *  (a row removed optimistically is no longer in the list to read it from). */
  const modseqs = useRef(new Map<string, string>());

  const isInbox = mailbox !== null && inbox !== undefined && mailbox.id === inbox.id && searchQuery === null;
  const activeSegment: InboxSegment = isInbox ? segment : 'all';
  const keyword = segmentKeyword(activeSegment);

  // Latest state for handlers that outlive a render (keys, SSE, queued writes).
  const latest = useRef({ list, open, route, mailboxId, searchQuery, activeSegment, selected, reducedMotion });
  latest.current = { list, open, route, mailboxId, searchQuery, activeSegment, selected, reducedMotion };

  const listKey = searchQuery !== null ? `search:${searchQuery}` : mailboxId;
  const listPath = mailPath(route.mailboxId);

  const say = useCallback((tone: Notice['tone'], text: string): number => {
    noticeKey.current += 1;
    setNotice({ tone, text, key: noticeKey.current });
    return noticeKey.current;
  }, []);

  // --- Fill the viewport below whatever sits above us (the shell's top bar below lg) ---------------
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const measure = () => {
      el.style.setProperty('--pr-mail-top', `${String(Math.max(0, el.getBoundingClientRect().top + window.scrollY))}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
    };
  }, [split]);

  // --- The list ------------------------------------------------------------------------------------
  const fetchPage = useCallback(
    (cursor: string | null, limit: number) => {
      if (searchQuery !== null) return api.search(searchQuery, { cursor });
      if (mailboxId === null) return Promise.resolve({ messages: [], nextCursor: null });
      return api.messages(mailboxId, { cursor, limit, keyword });
    },
    [searchQuery, mailboxId, keyword],
  );

  // The split's counts, whenever the Inbox's own counters move (a new message, a read, a move).
  const inboxId = inbox?.id ?? null;
  const inboxModseq = inbox?.highestModseq ?? null;
  const inboxUnseen = inbox?.unseen ?? 0;
  useEffect(() => {
    if (inboxId === null) return;
    let cancelled = false;
    api.mailboxSplit(inboxId).then(
      (s) => {
        if (!cancelled) setInboxSplit(s);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [inboxId, inboxModseq, inboxUnseen]);

  useEffect(() => {
    dispatch({ type: 'reset', mailboxId: listKey });
    setPending([]);
    setSelected(new Set());
    loadingMore.current = false;
    if (listKey === null) return;
    let cancelled = false;
    fetchPage(null, PAGE)
      .then((page) => {
        if (!cancelled) dispatch({ type: 'loaded', mailboxId: listKey, messages: page.messages, nextCursor: page.nextCursor, append: false });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 501) setSearchUnavailable(true);
        setListSignedOut(error instanceof ApiError && error.status === 401);
        dispatch({ type: 'failed', mailboxId: listKey });
      });
    return () => {
      cancelled = true;
    };
  }, [listKey, fetchPage]);

  /** `force`: take every row the server sends, even while the reader is not at rest at the top (an
   *  Undo's messages belong in the list at once, not behind the pill). */
  const reloadList = useCallback((force = false) => {
    const key = latest.current.list.mailboxId;
    if (key === null) return;
    const limit = Math.min(200, Math.max(PAGE, latest.current.list.messages.length));
    fetchPage(null, limit)
      .then((page) => {
        // Arrivals newer than the top row wait behind the pill unless the reader is at rest at the top.
        const { keep, held } = holdBackArrivals(page.messages, latest.current.list.messages, force || (listRef.current?.isCalm() ?? true));
        if (held.length > 0) setPending((p) => [...p.filter((x) => !held.some((h) => h.id === x.id)), ...held]);
        dispatch({ type: 'loaded', mailboxId: key, messages: keep, nextCursor: page.nextCursor, append: false });
      })
      .catch(() => {
        dispatch({ type: 'failed', mailboxId: key });
      });
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    const { list: current } = latest.current;
    if (loadingMore.current || current.status !== 'ready' || current.nextCursor === null || current.mailboxId === null) return;
    loadingMore.current = true;
    const key = current.mailboxId;
    fetchPage(current.nextCursor, PAGE)
      .then((page) => {
        dispatch({ type: 'loaded', mailboxId: key, messages: page.messages, nextCursor: page.nextCursor, append: true });
      })
      .catch(() => undefined)
      .finally(() => {
        loadingMore.current = false;
      });
  }, [fetchPage]);

  // --- Live: new mail at the top, counts and flags from other clients (PST-REQ-083) -----------------
  useEffect(() => {
    if (mailboxes === null) return;
    for (const m of mailboxes) if (!seenModseq.current.has(m.id)) seenModseq.current.set(m.id, m.highestModseq);
  }, [mailboxes]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reloadList();
      }, 250);
    };
    const off = subscribe((event) => {
      const current = latest.current;
      if (event.type === 'reconnected') {
        soon();
        return;
      }
      if (event.type === 'message.new') {
        if (current.searchQuery !== null || event.data.mailboxId !== current.mailboxId) return;
        api
          .message(event.data.messageId)
          .then((detail) => {
            // A Priority or People list only takes a new arrival that carries its keyword.
            if (!inSegment(detail.flags, latest.current.activeSegment)) return;
            const summary = summaryOf(detail);
            // PST-T-14.5: never shift rows under the pointer — held behind the "N new" pill instead.
            // PST-T-14.10: only what would land at the very top waits; a message moved in with an
            // older date goes straight to its date position.
            if ((listRef.current?.isCalm() ?? true) || !sortsAboveTop(summary, latest.current.list.messages)) dispatch({ type: 'upsert', message: summary });
            else setPending((p) => (p.some((x) => x.id === summary.id) ? p : [...p, summary]));
          })
          .catch(() => undefined);
        return;
      }
      const before = seenModseq.current.get(event.data.mailboxId);
      seenModseq.current.set(event.data.mailboxId, event.data.highestModseq);
      if (current.searchQuery === null && event.data.mailboxId === current.mailboxId && before !== event.data.highestModseq) soon();
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [subscribe, reloadList]);

  // --- The open message ----------------------------------------------------------------------------
  const messageId = route.messageId;
  useEffect(() => {
    if (messageId === null) {
      setOpen(null);
      return;
    }
    let cancelled = false;
    setOpen((o) => (o !== null && o.id === messageId ? o : { id: messageId, status: 'loading', detail: null, body: null, bodyStatus: 'loading' }));
    api
      .message(messageId)
      .then((detail) => {
        if (!cancelled) setOpen((o) => (o === null || o.id !== messageId ? o : { ...o, status: 'ready', detail }));
      })
      .catch((error: unknown) => {
        const status = error instanceof ApiError && error.status === 404 ? 'missing' : error instanceof ApiError && error.status === 401 ? 'signed-out' : 'error';
        if (!cancelled) setOpen((o) => (o === null || o.id !== messageId ? o : { ...o, status }));
      });
    api
      .messageBody(messageId)
      .then((body) => {
        if (!cancelled) setOpen((o) => (o === null || o.id !== messageId ? o : { ...o, body, bodyStatus: 'ready' }));
      })
      .catch(() => {
        if (!cancelled) setOpen((o) => (o === null || o.id !== messageId ? o : { ...o, bodyStatus: 'error' }));
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, openReload]);

  // The cursor follows the open message.
  useEffect(() => {
    if (messageId !== null) dispatch({ type: 'cursorTo', id: messageId });
  }, [messageId, list.messages]);

  // --- Writes: optimistic, serialised, and refetched when the server says no -----------------------
  const enqueue = useCallback((work: () => Promise<void>) => {
    chain.current = chain.current.then(work).catch(() => undefined);
  }, []);

  const findLatest = (id: string): MessageSummary | null => {
    const { list: l, open: o } = latest.current;
    const found = l.messages.find((m) => m.id === id) ?? (o?.detail?.id === id ? o.detail : null);
    const known = modseqs.current.get(id);
    return found === null || known === undefined || BigInt(known) <= BigInt(found.modseq) ? found : { ...found, modseq: known };
  };

  const recover = useCallback(
    (error: unknown) => {
      const conflict = error instanceof ApiError && (error.status === 412 || error.status === 409);
      say('danger', conflict ? 'That message changed somewhere else, so the list was refreshed. Try again.' : 'That did not work, so the list was refreshed. Try again.');
      reloadList();
      setOpenReload((n) => n + 1);
    },
    [reloadList, say],
  );

  const setFlags = useCallback(
    (id: string, add: string[], remove: string[]) => {
      dispatch({ type: 'flags', id, add, remove });
      setOpen((o) => (o?.detail?.id === id ? { ...o, detail: { ...o.detail, flags: applyFlags(o.detail.flags, add, remove) } } : o));
      enqueue(async () => {
        const m = findLatest(id);
        if (m === null) return;
        try {
          const updated = await api.patchMessage(id, m.modseq, { flags: { add, remove } });
          modseqs.current.set(id, updated.modseq);
          dispatch({ type: 'patch', message: summaryOf(updated) });
          setOpen((o) => (o?.detail?.id === id ? { ...o, detail: updated } : o));
        } catch (error) {
          recover(error);
        }
      });
    },
    [enqueue, recover],
  );

  // --- Triage (PST-T-14.5) ---------------------------------------------------------------------------
  /** Ids already on their way out, so a second e during the exit never picks one as "next". */
  const gone = useRef(new Set<string>());

  /**
   * What an action acts on: the x-selection (when `explicit`, if given, is part of it); else the open
   * message together with the rest of its thread in the same mailbox; else the one row named.
   */
  const scopeOf = (explicit: MessageSummary | null): { messages: MessageSummary[]; thread: MessageSummary | null } => {
    const { list: l, route: r, open: o, selected: sel } = latest.current;
    if (sel.size > 0 && (explicit === null || sel.has(explicit.id))) return { messages: selectedMessages(l.messages, sel), thread: null };
    const openId = r.messageId;
    const openRow = openId === null ? null : (l.messages.find((m) => m.id === openId) ?? (o?.detail !== null && o?.detail !== undefined && o.detail.id === openId ? summaryOf(o.detail) : null));
    const m = explicit ?? openRow ?? l.messages[l.cursor] ?? null;
    if (m === null || gone.current.has(m.id)) return { messages: [], thread: null };
    if (openRow !== null && m.id === openRow.id) return { messages: threadMembersInMailbox(l.messages, m).filter((x) => !gone.current.has(x.id)), thread: m };
    return { messages: [m], thread: null };
  };

  /** The rows fade and slide over their fixed slots, then drop in one frame (no layout animation in
   *  the virtual window). Reduced motion: they just go. */
  const exitRows = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    for (const id of ids) gone.current.add(id);
    const drop = () => {
      for (const id of ids) {
        dispatch({ type: 'remove', id });
        gone.current.delete(id);
      }
      setLeaving((s) => {
        const next = new Set(s);
        for (const id of ids) next.delete(id);
        return next;
      });
    };
    if (latest.current.reducedMotion) {
      drop();
      return;
    }
    setLeaving((s) => new Set([...s, ...ids]));
    setTimeout(drop, EXIT_MS);
  };

  /** When the open message is among `removed`, open the next one at once: below it (older), else
   *  above it, else back to the list. */
  const advancePast = (removed: ReadonlySet<string>) => {
    const { route: r, list: l } = latest.current;
    if (r.messageId === null || !removed.has(r.messageId)) return;
    const nextId = nextAfterRemoval(l.messages, new Set([...removed, ...gone.current]), r.messageId);
    const next = nextId === null ? undefined : l.messages.find((m) => m.id === nextId);
    if (next === undefined) void navigate(mailPath(r.mailboxId), { replace: true });
    else void navigate(mailPath(r.mailboxId ?? next.mailboxId, next.id), { replace: true });
  };

  /** The Toast with Undo (z). Only the toast on screen can be undone; z does nothing once it has gone. */
  const offerUndo = (message: string, undo: () => void) => {
    let used = false;
    const run = () => {
      if (used) return;
      used = true;
      undoRef.current = null;
      undo();
    };
    const id = toast.show({
      message,
      action: { label: 'Undo', ...(showsKeyHints() ? { shortcut: 'z' } : {}), onAction: run },
      onDismiss: () => {
        if (undoRef.current?.id === id) undoRef.current = null;
      },
    });
    undoRef.current = { id, run };
  };

  const triage = (to: Mailbox, explicit: MessageSummary | null) => {
    const { messages: targets, thread } = scopeOf(explicit);
    const moving = targets.filter((m) => m.mailboxId !== to.id);
    const first = moving[0];
    if (first === undefined) return;
    const ids = new Set(moving.map((m) => m.id));
    const reopen = latest.current.route.messageId !== null && ids.has(latest.current.route.messageId) ? latest.current.route.messageId : null;
    advancePast(ids);
    exitRows([...ids]);
    setSelected(new Set());
    const from = mailboxes?.find((x) => x.id === first.mailboxId) ?? null;
    const records: MovedRecord[] = [];
    enqueue(async () => {
      let members = moving;
      if (thread !== null && thread.threadId !== null) {
        // Members the list had not loaded yet go too: the thread, as the server knows it.
        try {
          members = mergeMembers(moving, (await api.thread(thread.threadId)).messages, thread.mailboxId);
        } catch {
          // The loaded members still go.
        }
      }
      for (const m of members) {
        if (m.mailboxId === to.id) continue;
        const known = modseqs.current.get(m.id);
        const modseq = known !== undefined && BigInt(known) > BigInt(m.modseq) ? known : m.modseq;
        try {
          const moved = await api.patchMessage(m.id, modseq, { mailboxId: to.id });
          modseqs.current.set(moved.id, moved.modseq);
          records.push({ originalId: m.id, movedId: moved.id, movedModseq: moved.modseq, fromMailboxId: m.mailboxId });
        } catch (error) {
          recover(error);
        }
      }
      void refreshMailboxes();
    });
    offerUndo(triageMessage(`Moved to ${mailboxLabel(to)}`, moving.length, first.subject), () => {
      // Queued behind the move, so every record is in by the time this runs.
      enqueue(async () => {
        const patches = undoPatches(records);
        let back: MessageDetail | null = null;
        let restored = 0;
        for (const [i, p] of patches.entries()) {
          try {
            const home = await api.patchMessage(p.id, p.modseq, { mailboxId: p.mailboxId });
            modseqs.current.set(home.id, home.modseq);
            dispatch({ type: 'upsert', message: summaryOf(home) });
            restored += 1;
            if (records[i]?.originalId === reopen) back = home;
          } catch (error) {
            recover(error);
          }
        }
        if (restored === 0) return;
        toast.show({ message: from === null ? 'Moved back.' : `Moved back to ${mailboxLabel(from)}.` });
        // Back to the message you were reading — under the new id it has now.
        if (back !== null) void navigate(mailPath(latest.current.route.mailboxId ?? back.mailboxId, back.id), { replace: true });
        reloadList(true);
        void refreshMailboxes();
      });
    });
  };

  /** Snooze (b): the conversations of what is in scope, until a time; Undo brings them back. */
  const snooze = (until: Date, explicit: MessageSummary | null) => {
    const { messages: targets } = scopeOf(explicit);
    const first = targets[0];
    const threads = [...new Set(targets.map((m) => m.threadId).filter((t): t is string => t !== null))];
    if (first === undefined || threads.length === 0) return;
    const ids = new Set(targets.map((m) => m.id));
    for (const m of latest.current.list.messages) if (m.threadId !== null && threads.includes(m.threadId) && m.mailboxId === first.mailboxId) ids.add(m.id);
    advancePast(ids);
    exitRows([...ids]);
    setSelected(new Set());
    const done: string[] = [];
    enqueue(async () => {
      for (const t of threads) {
        try {
          await api.snoozeThread(t, until.toISOString());
          done.push(t);
        } catch (error) {
          recover(error);
        }
      }
      void refreshMailboxes();
    });
    const when = until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    offerUndo(triageMessage(`Snoozed until ${when}`, targets.length, first.subject), () => {
      enqueue(async () => {
        let back = 0;
        for (const t of done) {
          try {
            await api.unsnoozeThread(t);
            back += 1;
          } catch (error) {
            recover(error);
          }
        }
        if (back === 0) return;
        toast.show({ message: 'Back in Inbox.' });
        reloadList(true);
        void refreshMailboxes();
      });
    });
  };

  /** Snooze is an Inbox action (PST-REQ-142): everything in scope must be in the Inbox. */
  const canSnoozeScope = (explicit: MessageSummary | null): boolean => {
    const { messages } = scopeOf(explicit);
    return inbox !== undefined && messages.length > 0 && messages.every((m) => m.mailboxId === inbox.id && m.threadId !== null);
  };

  // --- Sorting corrections (PST-T-14.9, PST-ADR-011) --------------------------------------------------
  /** Where the list is, for the bucket chip: search, the Inbox (and its segment), or another mailbox. */
  const chipContext: ChipContext =
    searchQuery !== null ? { kind: 'search' } : isInbox ? { kind: 'inbox', segment: activeSegment } : { kind: 'mailbox', bucket: mailboxBucket(mailbox) };
  const chipRef = useRef(chipContext);
  chipRef.current = chipContext;

  /**
   * A correction: the move plus a recorded sender preference, made by the server in one audited step.
   * A message that no longer belongs in this list leaves it (and the next one opens, as with any
   * triage); one that stays is replaced by what the server sent back. The Toast offers Undo (z),
   * which reverses both halves.
   */
  const correct = (m: MessageSummary, bucket: FilingBucket, scope: 'sender' | 'domain', source: 'chip' | 'card') => {
    const stays = listKeeps(bucket, chipRef.current);
    const wasOpen = latest.current.route.messageId === m.id;
    const inList = latest.current.list.messages.some((x) => x.id === m.id);
    if (!stays && inList) {
      advancePast(new Set([m.id]));
      exitRows([m.id]);
    }
    enqueue(async () => {
      let result;
      try {
        result = await sortingApi.correct({ messageId: m.id, bucket, scope, source });
      } catch (error) {
        recover(error);
        return;
      }
      const moved = result.message;
      modseqs.current.set(moved.id, moved.modseq);
      if (stays && inList) {
        if (moved.id === m.id) dispatch({ type: 'patch', message: moved });
        else {
          dispatch({ type: 'remove', id: m.id });
          dispatch({ type: 'upsert', message: moved });
        }
      }
      if (wasOpen && (stays || !inList)) {
        if (moved.id !== m.id) void navigate(mailPath(latest.current.route.mailboxId ?? moved.mailboxId, moved.id), { replace: true });
        else setOpenReload((n) => n + 1);
      } else if (!wasOpen && m.threadId !== null && m.threadId === latest.current.open?.detail?.threadId) {
        // A member of the open conversation: the thread shows it in its new bucket.
        setReplyEpoch((n) => n + 1);
      }
      void refreshMailboxes();
      offerUndo(correctedMessage(bucket, result.correction.moved), () => {
        enqueue(async () => {
          try {
            const undone = await sortingApi.undo(result.correction.id);
            if (undone.message !== null) modseqs.current.set(undone.message.id, undone.message.modseq);
            toast.show({ message: undone.movedBack ? `Correction undone · back in ${BUCKET_LABEL[isFilingBucket(m.bucket) ? m.bucket : bucket]}` : 'Correction undone.' });
            if (wasOpen && undone.message !== null) void navigate(mailPath(latest.current.route.mailboxId ?? undone.message.mailboxId, undone.message.id), { replace: true });
            reloadList(true);
            setOpenReload((n) => n + 1);
            setReplyEpoch((n) => n + 1);
            void refreshMailboxes();
          } catch (error) {
            recover(error);
          }
        });
      });
    });
  };
  const sorting: SortingActions = { list: chipContext, openId: route.messageId, openBucket: open?.detail?.bucket ?? null, correct };

  // A selected row that left the list (another client moved it) is no longer selected.
  useEffect(() => {
    setSelected((s) => pruneSelected(s, list.messages));
  }, [list.messages]);

  /** Mail held behind the pill goes in, and the list goes to the top to show it. */
  const showNew = () => {
    for (const m of pending) dispatch({ type: 'upsert', message: m });
    setPending([]);
    listRef.current?.scrollToTop();
  };

  // Opening a message marks it read, once.
  useEffect(() => {
    const d = open?.detail;
    if (open?.status !== 'ready' || d === null || d === undefined) return;
    if (!isUnread(d) || markedSeen.current.has(d.id)) return;
    markedSeen.current.add(d.id);
    setFlags(d.id, [SEEN], []);
  }, [open, setFlags]);

  // --- Focus follows the view --------------------------------------------------------------------------
  const openReady = open?.status === 'ready' ? open.id : null;
  useEffect(() => {
    if (openReady === null || route.compose !== null) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    readerHeading.current?.focus({ preventScroll: true });
  }, [openReady, route.compose]);

  const view = split ? null : narrowView(route);
  const pushDirectionNow = usePushDirection(view ?? 'split', pushDepth(location.pathname, location.search));
  useEffect(() => {
    if (view === 'list' || view === 'mailboxes') viewHeading.current?.focus({ preventScroll: true });
  }, [view]);

  // --- Actions ---------------------------------------------------------------------------------------------
  const target = (): MessageSummary | null => {
    const { route: r, list: l, open: o } = latest.current;
    if (r.messageId !== null) return l.messages.find((m) => m.id === r.messageId) ?? o?.detail ?? null;
    return l.messages[l.cursor] ?? null;
  };

  const openMessage = (m: MessageSummary) => {
    // PST-T-14.7: a draft opens in the composer, editable, never read-only (TF-09).
    const isDraft = mailboxes?.find((b) => b.id === m.mailboxId)?.specialUse === 'drafts';
    void navigate(mailPath(latest.current.searchQuery === null ? (latest.current.route.mailboxId ?? m.mailboxId) : m.mailboxId, m.id, isDraft ? 'draft' : null));
  };

  const compose = (mode: ComposeMode, m: MessageSummary | null) => {
    const r = latest.current.route;
    if (mode === 'new') {
      void navigate(mailPath(r.mailboxId, r.messageId, 'new'));
      return;
    }
    if (m === null) return;
    void navigate(mailPath(r.mailboxId ?? m.mailboxId, m.id, mode));
  };

  const perform = (action: MailAction) => {
    const { route: r, list: l } = latest.current;
    switch (action) {
      case 'next':
      case 'prev': {
        const delta = action === 'next' ? 1 : -1;
        // k at the top of the list reveals mail held behind the "N new" pill.
        if (delta === -1 && r.messageId === null && l.cursor <= 0 && pending.length > 0) {
          showNew();
          return;
        }
        if (r.messageId !== null) {
          const index = l.messages.findIndex((m) => m.id === r.messageId);
          const next = index < 0 ? undefined : l.messages[index + delta];
          if (next !== undefined) void navigate(mailPath(r.mailboxId ?? next.mailboxId, next.id), { replace: true });
        } else dispatch({ type: 'move', delta });
        return;
      }
      case 'open': {
        const m = l.messages[l.cursor];
        if (m !== undefined && r.messageId !== m.id) openMessage(m);
        return;
      }
      case 'back':
        if (r.compose !== null) void navigate(mailPath(r.mailboxId, r.messageId));
        else if (r.messageId !== null) void navigate(listPath);
        else if (!split && !r.mailboxIndex) void navigate('/mail');
        setTimeout(() => listRef.current?.focus(), 0);
        return;
      case 'archive':
      case 'delete': {
        const dest = action === 'archive' ? archive : trash;
        if (dest !== undefined) triage(dest, null);
        return;
      }
      case 'moveTo':
        if (scopeOf(null).messages.length > 0) setPicker({ mode: 'move', explicit: null });
        return;
      case 'snooze':
        if (canSnoozeScope(null)) setPicker({ mode: 'snooze', explicit: null });
        return;
      case 'undo': {
        const u = undoRef.current;
        if (u === null) return;
        u.run();
        toast.dismiss(u.id);
        return;
      }
      case 'select': {
        const m = target();
        if (m !== null) setSelected((s) => toggleSelected(s, m.id));
        return;
      }
      case 'reply':
        compose('reply', target());
        return;
      case 'replyAll':
        compose('replyall', target());
        return;
      case 'forward':
        compose('forward', target());
        return;
      case 'compose':
        compose('new', null);
        return;
      case 'star': {
        const m = target();
        if (m !== null) setFlags(m.id, isStarred(m) ? [] : [FLAGGED], isStarred(m) ? [FLAGGED] : []);
        return;
      }
      case 'markUnread': {
        const m = target();
        if (m === null) return;
        markedSeen.current.add(m.id);
        setFlags(m.id, [], [SEEN]);
        if (r.messageId === m.id) void navigate(listPath);
        return;
      }
      case 'search':
        searchInput.current?.focus();
        return;
      case 'goInbox':
        setSearchQuery(null);
        if (inbox !== undefined) void navigate(mailPath(inbox.id));
        return;
      case 'help':
        setOverlay((v) => !v);
        return;
      case 'commandPalette':
        setPaletteOpen((v) => !v);
        return;
    }
  };

  const performRef = useRef(perform);
  performRef.current = perform;
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const el = e.target instanceof Element ? e.target : null;
      const inDialog = el?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') ?? null;
      // PST-T-14.5: Escape leaves selection (outside dialogs and text fields).
      if (e.key === 'Escape' && inDialog === null && latest.current.selected.size > 0 && !describeTarget(e.target).editable) {
        e.preventDefault();
        setSelected(new Set());
        listRef.current?.focus();
        return;
      }
      const { action, pending } = resolveKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, ...describeTarget(e.target) }, pendingKey.current);
      pendingKey.current = pending;
      if (action === null) return;
      // Behind a dialog (the overlay, the navigation drawer, a menu) only ? and the ⌘K chord do
      // anything — the chord still toggles the palette shut when it is what is open.
      if ((inDialog !== null || overlayRef.current) && action !== 'help' && action !== 'commandPalette') return;
      if (inDialog !== null && !overlayRef.current && !paletteOpenRef.current) return;
      e.preventDefault();
      performRef.current(action);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // --- Search (GET /api/search; says so plainly while it answers 501) --------------------------------
  const submitSearch = (e: SyntheticEvent) => {
    e.preventDefault();
    const q = searchText.trim();
    setSearchUnavailable(false);
    setSearchQuery(q === '' ? null : q);
  };

  const clearSearch = () => {
    setSearchQuery(null);
    setSearchText('');
    setSearchUnavailable(false);
  };

  // --- Render ------------------------------------------------------------------------------------------------
  if (mailboxesFailed && mailboxes === null) {
    return (
      <div className="pr-mail pr-mail--state" ref={rootRef}>
        <h1 className="pr-vh">Mail</h1>
        <EmptyState kind="error" heading="Could not load your mailboxes" size="page" headingLevel={2} action={<Button onClick={() => void refreshMailboxes()}>Try again</Button>}>
          {serverUnreachable('Check your connection.')}
        </EmptyState>
      </div>
    );
  }

  const selecting = selected.size > 0;
  const pickerScope = picker === null ? null : scopeOf(picker.explicit);
  const pickerCount = pickerScope?.messages.length ?? 0;
  const pickerWhat = pickerCount <= 1 ? 'this message' : pickerScope?.thread !== null ? `this conversation (${String(pickerCount)} messages)` : `${String(pickerCount)} messages`;
  const title = searchQuery !== null ? 'Search results' : mailbox === null ? 'Mail' : mailboxLabel(mailbox);
  const listLabel = searchQuery !== null ? `Messages matching ${searchQuery}` : `Messages in ${title}`;
  // PST-T-14.8: at phone width every level has a sticky context bar — Back with the parent's
  // name, the title, and at most two icon actions (Search, Compose). No floating Compose button.
  const composeAction = (
    <IconButton
      variant="ghost"
      label="Compose"
      icon={<ComposeIcon />}
      onClick={() => {
        compose('new', null);
      }}
    />
  );
  const backToList = <ContextBar back={{ to: listPath, label: title }} />;

  const listPane = (
    <section className="pr-mail__list" aria-labelledby="pr-list-title">
      {!split ? (
        <ContextBar
          back={{ to: '/mail', label: 'Mailboxes' }}
          title={title}
          actions={
            <>
              <IconButton
                variant="ghost"
                label="Search"
                icon={<SearchIcon />}
                onClick={() => {
                  searchInput.current?.focus();
                }}
              />
              {composeAction}
            </>
          }
        />
      ) : null}
      <div className="pr-listhead">
        {/* PST-T-14.5: while rows are selected, the selection toolbar lies over this block — the
            header stays underneath, inert, so nothing below it moves. */}
        <div className="pr-headswap" data-selecting={selecting ? 'true' : 'false'}>
        <div className="pr-headswap__head" inert={selecting}>
        <div className="pr-listhead__row">
          <h2 id="pr-list-title" className="pr-listhead__title" tabIndex={-1} ref={view === 'list' ? viewHeading : undefined}>
            {title}
            {mailbox !== null && searchQuery === null && mailbox.unseen > 0 ? <span className="pr-listhead__count">{mailbox.unseen} unread</span> : null}
          </h2>
          <Button
            size="sm"
            variant="secondary"
            icon={<ComposeIcon />}
            className="pr-listhead__compose"
            onClick={() => {
              compose('new', null);
            }}
          >
            Compose
          </Button>
        </div>
        <form role="search" className="pr-search" onSubmit={submitSearch}>
          {/* PST-T-11.4: a glyph and the / key say what this field is; the accessible name stays
              "Search mail" (a placeholder is never a label in @d3cloud/ui). */}
          {/* PST-T-14.4: the filled SearchField draws its own glyph and the / hint. */}
          <SearchField
            ref={searchInput}
            aria-label="Search mail"
            placeholder="Search mail"
            {...(split ? { shortcut: '/' } : {})}
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.currentTarget.blur();
                listRef.current?.focus();
              }
            }}
          />
          {searchQuery !== null ? (
            <Button size="sm" variant="ghost" type="button" onClick={clearSearch}>
              Clear search
            </Button>
          ) : null}
        </form>
        {isInbox ? (
          <SegmentedControl
            aria-label="Show in Inbox"
            size={split ? 'sm' : 'md'}
            className="pr-split"
            value={segment}
            onValueChange={(v) => {
              if (isInboxSegment(v)) setSegment(v);
            }}
            items={segmentItems(inboxSplit, inboxUnseen)}
          />
        ) : null}
        </div>
        {selecting ? (
          <SelectionToolbar
            count={selected.size}
            total={list.messages.length}
            canArchive={archive !== undefined && mailbox?.id !== archive.id}
            canTrash={trash !== undefined && mailbox?.id !== trash.id}
            canSnooze={canSnoozeScope(null)}
            onArchive={() => {
              if (archive !== undefined) triage(archive, null);
              listRef.current?.focus();
            }}
            onDelete={() => {
              if (trash !== undefined) triage(trash, null);
              listRef.current?.focus();
            }}
            onSnooze={() => {
              setPicker({ mode: 'snooze', explicit: null });
            }}
            onMove={() => {
              setPicker({ mode: 'move', explicit: null });
            }}
            onSelectAll={() => {
              setSelected(new Set(list.messages.map((m) => m.id)));
            }}
            onClear={() => {
              setSelected(new Set());
              listRef.current?.focus();
            }}
          />
        ) : null}
        </div>
        <div className="pr-notice__row">
          <div className="pr-notice" role="status" aria-live="polite">
            {notice?.tone === 'info' ? <span key={notice.key}>{notice.text}</span> : null}
          </div>
        </div>
        {/* PST-T-9.1: the undo-send toast, and scheduled sends above Drafts. */}
        {split || view === 'list' ? <UndoSendToast /> : null}
        {mailbox?.specialUse === 'drafts' && searchQuery === null ? <ScheduledSends drafts={mailbox} /> : null}
        {notice?.tone === 'danger' ? (
          <Alert key={notice.key} tone="danger" dynamic flush actions={<Button size="sm" variant="ghost" onClick={() => { setNotice(null); }}>Dismiss</Button>}>
            {notice.text}
          </Alert>
        ) : null}
      </div>
      <ListBody
        list={list}
        label={listLabel}
        empty={emptyMailboxCopy(mailbox, activeSegment)}
        searching={searchQuery !== null}
        searchUnavailable={searchUnavailable}
        signedOut={listSignedOut}
        onRetry={reloadList}
      >
        <TriageList
          ref={listRef}
          messages={list.messages}
          cursor={list.cursor}
          openId={route.messageId}
          label={listLabel}
          selected={selected}
          leaving={leaving}
          warnedId={open?.detail?.phish !== null && open?.detail?.phish !== undefined && open.detail.phish.warnings.length > 0 ? open.detail.id : null}
          pendingCount={pending.filter((p) => !list.messages.some((m) => m.id === p.id)).length}
          canArchive={archive !== undefined && mailbox?.id !== archive.id}
          canTrash={trash !== undefined && mailbox?.id !== trash.id}
          canSnooze={isInbox}
          onOpen={(m, index) => {
            dispatch({ type: 'cursor', index });
            openMessage(m);
          }}
          onToggleSelect={(m, index) => {
            dispatch({ type: 'cursor', index });
            setSelected((s) => toggleSelected(s, m.id));
          }}
          onRowAction={(action: RowAction, m) => {
            if (action === 'archive' && archive !== undefined) triage(archive, m);
            else if (action === 'delete' && trash !== undefined) triage(trash, m);
            else if (action === 'move') setPicker({ mode: 'move', explicit: m });
            else if (action === 'snooze' && canSnoozeScope(m)) setPicker({ mode: 'snooze', explicit: m });
          }}
          onShowNew={showNew}
          onNearEnd={loadMore}
          chipFor={(m) => (chipShows(m.bucket, chipContext) && isFilingBucket(m.bucket) ? BUCKET_LABEL[m.bucket] : null)}
          onChip={(m, el) => {
            setWhy({ message: m, anchor: el.getBoundingClientRect() });
          }}
        />
      </ListBody>
    </section>
  );

  const draft =
    route.compose === null
      ? null
      : route.compose === 'new'
        ? { ...draftFor('new', null, me), to: route.composeTo ?? '' }
        : route.compose === 'draft'
          ? (route.composeDraftId ?? null) === null
            ? null
            : draftToResume(route.composeDraftId ?? '')
          : open?.status === 'ready' && open.detail !== null && open.bodyStatus !== 'loading'
            ? draftFor(route.compose, { detail: open.detail, body: open.body }, me)
            : null;
  const closeComposer = () => {
    // A draft opened from Drafts is replaced as it saves: close back to its mailbox's list. A new
    // message's draft rides in ?id=, so closing goes back to whatever was open behind it.
    const draftInPath = route.compose === 'draft' && route.messageId !== null && route.messageId === route.composeDraftId;
    void navigate(draftInPath ? mailPath(route.mailboxId) : mailPath(route.mailboxId, route.messageId));
  };
  // PST-T-14.7: new and resumed drafts take the reading pane's place; replies and forwards open
  // inline under the thread (ReadingPane's composer slot).
  const composer =
    draft === null ? null : (
      <Composer
        key={composerKey(draft)}
        draft={draft}
        placement={composesInPane(route.compose) ? 'pane' : 'inline'}
        onDiscard={closeComposer}
        onSent={() => {
          setReplyEpoch((n) => n + 1);
        }}
        onDiscarded={(outcome) => {
          // The toast says where the draft went (and offers Undo); the list follows it.
          if (outcome.kind === 'nothing') return;
          if (outcome.kind === 'kept' || outcome.kind === 'unrestored') say('danger', outcome.text);
          reloadList();
        }}
        {...(composesInPane(route.compose)
          ? {
              // Each save names the draft in the URL, so a reload resumes it (PST-T-14.7).
              onDraftSaved: (id: string) => {
                void navigate(draftPath(route, id), { replace: true });
              },
            }
          : {})}
        {...(split || !composesInPane(route.compose) ? {} : { back: backToList })}
      />
    );

  const readerPane =
    composesInPane(route.compose) ? (
      composer ?? (
        <section className="pr-reader" aria-label="Composer" aria-busy="true">
          <Skeleton variant="text" lines={4} />
        </section>
      )
    ) : (
      <ReadingPane
        // An inline reply leaves the thread mounted; after a send it is remounted, which re-asks the
        // server for the thread the reply just joined (the same moment a closing composer used to be).
        key={`reader:${String(replyEpoch)}`}
        ref={readerHeading}
        open={open}
        {...(split ? {} : { back: backToList })}
        canArchive={archive !== undefined && open?.detail?.mailboxId !== archive.id}
        canTrash={trash !== undefined && open?.detail?.mailboxId !== trash.id}
        onRetry={() => {
          setOpenReload((n) => n + 1);
        }}
        onAction={(a) => {
          perform(a);
        }}
        // PST-T-15.3: "3 of 48" in the toolbar, with up/down wired to perform('prev' / 'next').
        position={{ index: route.messageId === null ? -1 : list.messages.findIndex((m) => m.id === route.messageId), total: list.messages.length, more: list.nextCursor !== null }}
        onMoveToJunk={
          junk === undefined
            ? undefined
            : (d) => {
                triage(junk, summaryOf(d));
              }
        }
        onMoveTo={(d, to) => {
          // Not junk / Rescue / Move to… go through the triage loop (PST-T-14.5): thread scope,
          // the next message opens, and the Undo toast offers the way back.
          triage(to, summaryOf(d));
        }}
        onEditDraft={(d) => {
          void navigate(mailPath(route.mailboxId ?? d.mailboxId, d.id, 'draft'));
        }}
        composer={route.compose === null ? undefined : composer}
        snooze={
          /* PST-T-9.1 (PST-REQ-142): snooze the open conversation, or bring it back — inside the
             toolbar since PST-T-11.4, an icon button since PST-T-14.6. */
          <SnoozeIconControl
            threadId={open?.detail?.threadId ?? null}
            inInbox={open?.detail?.mailboxId !== undefined && open.detail.mailboxId === inbox?.id}
            snoozed={open?.detail?.mailboxId !== undefined && mailboxes?.find((m) => m.id === open.detail?.mailboxId)?.name === 'Snoozed'}
            onDone={(text) => {
              say('info', text);
              void navigate(mailPath(route.mailboxId));
            }}
          />
        }
      >
        {!split && view !== 'list' ? <UndoSendToast /> : null}
      </ReadingPane>
    );

  // PST-T-5.6, PST-REQ-109: the Newsletters folder opens as a continuous-scroll feed of full bodies
  // instead of the usual list + reader — there is no "one message open" here, so route.messageId
  // and the reader pane are moot for it.
  const isNewslettersFeed = mailbox !== null && mailbox.name === 'Newsletters' && route.compose === null && searchQuery === null;
  const feedPane = mailbox === null ? null : (
    <section className="pr-mail__feed" aria-labelledby="pr-list-title">
      {/* Up one level is the mailboxes, not this same feed (PST-T-11.4). */}
      {!split ? <ContextBar back={{ to: '/mail', label: 'Mailboxes' }} title={title} actions={composeAction} /> : null}
      <h2 id="pr-list-title" className="pr-listhead__title" tabIndex={-1} ref={viewHeading}>
        {title}
      </h2>
      <Feed mailbox={mailbox} />
    </section>
  );

  let content;
  if (isNewslettersFeed) {
    content = feedPane;
  } else if (split) {
    content = (
      <>
        {listPane}
        {readerPane}
      </>
    );
  } else if (view === 'mailboxes') {
    content = <MailboxIndex mailboxes={mailboxes} headingRef={viewHeading} onCompose={() => { compose('new', null); }} />;
  } else if (view === 'list') {
    content = listPane;
  } else {
    content = readerPane;
  }

  // PST-T-14.8: at phone width each level is a push screen — it slides in from the right when you
  // go deeper and back when you return. The open thread shows its body first; its actions sit in a
  // sticky bar at the bottom (the desktop toolbar at the top is hidden there, mail.css).
  const openDetail = open?.status === 'ready' ? open.detail : null;
  if (!split && view !== null) {
    content = (
      <PushFrame key={view} direction={pushDirectionNow} className="pr-push--level">
        {content}
        {view === 'message' && openDetail !== null && !isNewslettersFeed ? (
          <MobileActionBar
            detail={openDetail}
            canArchive={archive !== undefined && openDetail.mailboxId !== archive.id}
            canTrash={trash !== undefined && openDetail.mailboxId !== trash.id}
            onAction={perform}
            onMoveTo={(d, to) => {
              triage(to, summaryOf(d));
            }}
          />
        ) : null}
      </PushFrame>
    );
  }

  return (
    <div className="pr-mail" data-layout={split ? 'split' : 'push'} data-view={view ?? 'split'} ref={rootRef}>
      <h1 className="pr-vh">Mail</h1>
      <SortingContext.Provider value={sorting}>{content}</SortingContext.Provider>
      {why === null ? null : (
        <WhyPopover
          message={why.message}
          anchor={why.anchor}
          returnFocus={null}
          onClose={() => {
            setWhy(null);
            listRef.current?.focus();
          }}
          onCorrect={(bucket, scope) => {
            correct(why.message, bucket, scope, 'chip');
          }}
        />
      )}
      <ShortcutsOverlay open={overlay} onOpenChange={setOverlay} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        mailboxes={mailboxes}
        target={target()}
        onAction={perform}
        onMove={(m, to) => {
          triage(to, m);
        }}
        onNavigate={(path) => {
          void navigate(path);
        }}
        onSnooze={(m, until) => {
          snooze(until, m);
        }}
      />
      <TriagePicker
        mode={picker?.mode ?? null}
        what={pickerWhat}
        mailboxes={mailboxes ?? []}
        currentMailboxId={pickerScope?.messages[0]?.mailboxId ?? mailboxId}
        onMove={(to) => {
          const explicit = picker?.explicit ?? null;
          setPicker(null);
          triage(to, explicit);
        }}
        onSnooze={(until) => {
          const explicit = picker?.explicit ?? null;
          setPicker(null);
          snooze(until, explicit);
        }}
        onClose={() => {
          setPicker(null);
        }}
      />
    </div>
  );
}

function ListBody({
  list,
  label,
  empty,
  searching,
  searchUnavailable,
  signedOut,
  onRetry,
  children,
}: {
  list: ReturnType<typeof listReducer>;
  label: string;
  empty: { heading: string; body: string };
  searching: boolean;
  searchUnavailable: boolean;
  signedOut: boolean;
  onRetry: () => void;
  /** The list itself, once there is something to list. */
  children: React.ReactNode;
}) {
  if (list.status === 'loading' || list.status === 'idle') {
    return (
      <div className="pr-list pr-list--state" aria-busy="true" aria-label={label}>
        <Stack gap="12">
          <Skeleton variant="text" lines={2} />
          <Skeleton variant="text" lines={2} />
          <Skeleton variant="text" lines={2} />
        </Stack>
      </div>
    );
  }
  if (list.status === 'error') {
    if (signedOut) {
      return (
        <div className="pr-list pr-list--state">
          <SessionEnded headingLevel={3} size="inline" />
        </div>
      );
    }
    if (searching && searchUnavailable) {
      return (
        <div className="pr-list pr-list--state">
          <EmptyState kind="error" heading="Search is not available yet" size="inline" headingLevel={3}>
            Full-text search is being switched on. Clear the search to get back to your mail.
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="pr-list pr-list--state">
        <EmptyState kind="error" heading="Could not load these messages" size="inline" headingLevel={3} action={<Button onClick={onRetry}>Try again</Button>}>
          {serverUnreachable('Check your connection.')}
        </EmptyState>
      </div>
    );
  }
  if (list.messages.length === 0) {
    return (
      <div className="pr-list pr-list--state">
        <EmptyState kind={searching ? 'no-results' : 'empty'} heading={searching ? 'Nothing matched that search' : empty.heading} size="inline" headingLevel={3}>
          {searching ? 'Try fewer or different words.' : empty.body}
        </EmptyState>
      </div>
    );
  }
  return children;
}

/** Below tablet width, the root of the one push stack (PST-T-14.8): the mailboxes grouped as the
 *  desktop sidebar groups them, then Calendar, Contacts and the account menu (Settings, the Admin
 *  console, theme, Sign out). There is no hamburger drawer beside it. */
function MailboxIndex({ mailboxes, headingRef, onCompose }: { mailboxes: Mailbox[] | null; headingRef: React.Ref<HTMLHeadingElement>; onCompose: () => void }) {
  const account = useContext(PhoneAccountMenu);
  const groups = mailboxes === null ? null : mailSidebar(mailboxes);
  const row = (m: Mailbox) => (
    <PushRow
      key={m.id}
      to={mailPath(m.id)}
      icon={mailboxIcon(m.specialUse, m.name)}
      label={mailboxLabel(m)}
      count={m.specialUse === 'trash' ? 0 : m.unseen}
      countLabel={`${mailboxLabel(m)}, ${String(m.unseen)} unread`}
    />
  );
  return (
    <section className="pr-mail__list pr-mailboxes" aria-labelledby="pr-mailboxes-title">
      <ContextBar
        title="Mailboxes"
        actions={<IconButton variant="ghost" label="Compose" icon={<ComposeIcon />} onClick={onCompose} />}
      />
      <h2 id="pr-mailboxes-title" className="pr-vh" tabIndex={-1} ref={headingRef}>
        Mailboxes
      </h2>
      <div className="pr-mailboxes__scroll">
        {groups === null ? (
          <div role="status" aria-label="Loading mailboxes" aria-busy="true" className="pr-mailboxes__state">
            <Skeleton variant="text" lines={5} />
          </div>
        ) : mailboxes?.length === 0 ? (
          <div className="pr-mailboxes__state">
            <EmptyState kind="empty" heading="No mailboxes yet" size="inline" headingLevel={3}>
              Your mailboxes appear here once the server has made them.
            </EmptyState>
          </div>
        ) : (
          <nav aria-label="Mailboxes">
            <ul className="pr-prows" role="list">
              {groups.primary.map(row)}
            </ul>
            {groups.sorted.length > 0 ? (
              <>
                <h3 className="pr-prows__heading">Sorted for you</h3>
                <ul className="pr-prows" role="list">
                  {groups.sorted.map(row)}
                </ul>
              </>
            ) : null}
            {groups.safetyNet.length + groups.more.length > 0 ? (
              <>
                <h3 className="pr-prows__heading">Filtered and more</h3>
                <ul className="pr-prows" role="list">
                  {groups.safetyNet.map(row)}
                  {groups.more.map(row)}
                </ul>
              </>
            ) : null}
          </nav>
        )}
        <nav aria-label="Places" className="pr-tiles">
          <RouterLink className="pr-tile" to="/calendar">
            Calendar
          </RouterLink>
          <RouterLink className="pr-tile" to="/contacts">
            Contacts
          </RouterLink>
        </nav>
        {account === null ? null : <div className="pr-mailboxes__account">{account}</div>}
      </div>
    </section>
  );
}
