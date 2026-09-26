// The three-pane webmail (PST-REQ-077): mailboxes in the shell's sidebar, the message list, and the
// reading pane. From tablet width the list and the reader sit side by side; below it the view is
// push navigation — mailboxes → list → message — with the URL naming each step, so the browser's
// back button walks it. Gmail's keys drive it (PST-REQ-084), and the list follows the server live
// over SSE (PST-REQ-083). Flag changes and moves are optimistic, and a refused write (412/409)
// refetches rather than guessing.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type SyntheticEvent } from 'react';
import { Link as RouterLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, EmptyState, Input, Link, Skeleton, Stack } from '@d3cloud/ui';
import { api, ApiError, type Mailbox, type MessageDetail, type MessageSummary } from '../api';
import { CommandPalette } from './CommandPalette';
import { Composer } from './Composer';
import { draftFor } from './compose';
import { findSpecial, mailboxLabel } from './format';
import { ComposeIcon, mailboxIcon } from './icons';
import { describeTarget, resolveKey, type MailAction } from './keys';
import { applyFlags, FLAGGED, initialList, isStarred, isUnread, listReducer, SEEN } from './list';
import { useMail } from './MailContext';
import { MessageList, type MessageListHandle } from './MessageList';
import { ReadingPane, type OpenMessage } from './ReadingPane';
import { mailPath, narrowView, parseMailRoute, type ComposeMode, type MailRoute } from './route';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { SPLIT_QUERY, useMediaQuery } from './useMedia';

const PAGE = 50;

type Notice = { tone: 'info' | 'danger'; text: string; key: number };

function summaryOf(m: MessageDetail | MessageSummary): MessageSummary {
  return {
    id: m.id,
    mailboxId: m.mailboxId,
    uid: m.uid,
    modseq: m.modseq,
    threadId: m.threadId,
    subject: m.subject,
    from: m.from,
    date: m.date,
    internalDate: m.internalDate,
    size: m.size,
    flags: m.flags,
    bucket: m.bucket,
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
  const { mailboxes, mailboxesFailed, refreshMailboxes, me, subscribe } = useMail();
  const split = useMediaQuery(SPLIT_QUERY);

  const inbox = mailboxes === null ? undefined : (findSpecial(mailboxes, 'inbox') ?? mailboxes[0]);
  const mailboxId = route.mailboxId ?? inbox?.id ?? null;
  const mailbox: Mailbox | null = mailboxes?.find((m) => m.id === mailboxId) ?? null;
  const archive = mailboxes === null ? undefined : findSpecial(mailboxes, 'archive');
  const trash = mailboxes === null ? undefined : findSpecial(mailboxes, 'trash');

  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const [list, dispatch] = useReducer(listReducer, initialList);
  const [open, setOpen] = useState<OpenMessage | null>(null);
  const [openReload, setOpenReload] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<MessageListHandle>(null);
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

  // Latest state for handlers that outlive a render (keys, SSE, queued writes).
  const latest = useRef({ list, open, route, mailboxId, searchQuery });
  latest.current = { list, open, route, mailboxId, searchQuery };

  const listKey = searchQuery !== null ? `search:${searchQuery}` : mailboxId;
  const listPath = mailPath(route.mailboxId);

  const say = useCallback((tone: Notice['tone'], text: string) => {
    noticeKey.current += 1;
    setNotice({ tone, text, key: noticeKey.current });
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
      return api.messages(mailboxId, { cursor, limit });
    },
    [searchQuery, mailboxId],
  );

  useEffect(() => {
    dispatch({ type: 'reset', mailboxId: listKey });
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
        dispatch({ type: 'failed', mailboxId: listKey });
      });
    return () => {
      cancelled = true;
    };
  }, [listKey, fetchPage]);

  const reloadList = useCallback(() => {
    const key = latest.current.list.mailboxId;
    if (key === null) return;
    const limit = Math.min(200, Math.max(PAGE, latest.current.list.messages.length));
    fetchPage(null, limit)
      .then((page) => {
        dispatch({ type: 'loaded', mailboxId: key, messages: page.messages, nextCursor: page.nextCursor, append: false });
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
            dispatch({ type: 'upsert', message: summaryOf(detail) });
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
        const missing = error instanceof ApiError && error.status === 404;
        if (!cancelled) setOpen((o) => (o === null || o.id !== messageId ? o : { ...o, status: missing ? 'missing' : 'error' }));
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

  const move = useCallback(
    (m: MessageSummary, to: Mailbox) => {
      if (m.mailboxId === to.id) return;
      dispatch({ type: 'remove', id: m.id });
      const { route: r } = latest.current;
      if (r.messageId === m.id) void navigate(mailPath(r.mailboxId), { replace: false });
      say('info', `Moved to ${mailboxLabel(to)}.`);
      enqueue(async () => {
        const known = modseqs.current.get(m.id);
        const current = findLatest(m.id) ?? (known === undefined || BigInt(known) <= BigInt(m.modseq) ? m : { ...m, modseq: known });
        try {
          await api.patchMessage(m.id, current.modseq, { mailboxId: to.id });
        } catch (error) {
          recover(error);
        }
      });
    },
    [enqueue, navigate, recover, say],
  );

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
    void navigate(mailPath(latest.current.searchQuery === null ? (latest.current.route.mailboxId ?? m.mailboxId) : m.mailboxId, m.id));
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
        const m = target();
        const dest = action === 'archive' ? archive : trash;
        if (m !== null && dest !== undefined) move(m, dest);
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
          Postroom did not answer. Check your connection.
        </EmptyState>
      </div>
    );
  }

  const title = searchQuery !== null ? 'Search results' : mailbox === null ? 'Mail' : mailboxLabel(mailbox);
  const listLabel = searchQuery !== null ? `Messages matching ${searchQuery}` : `Messages in ${title}`;
  const backToList = (
    <div className="pr-back">
      <Link asChild variant="standalone">
        <RouterLink to={listPath}>
          <span aria-hidden="true">‹ </span>
          {title}
        </RouterLink>
      </Link>
    </div>
  );

  const listPane = (
    <section className="pr-mail__list" aria-labelledby="pr-list-title">
      <div className="pr-listhead">
        {!split ? (
          <div className="pr-back">
            <Link asChild variant="standalone">
              <RouterLink to="/mail">
                <span aria-hidden="true">‹ </span>
                Mailboxes
              </RouterLink>
            </Link>
          </div>
        ) : null}
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
          <Input
            ref={searchInput}
            type="search"
            size="sm"
            aria-label="Search mail"
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
        <div className="pr-notice" role="status" aria-live="polite">
          {notice?.tone === 'info' ? <span key={notice.key}>{notice.text}</span> : null}
        </div>
        {notice?.tone === 'danger' ? (
          <Alert key={notice.key} tone="danger" dynamic flush actions={<Button size="sm" variant="ghost" onClick={() => { setNotice(null); }}>Dismiss</Button>}>
            {notice.text}
          </Alert>
        ) : null}
      </div>
      <ListBody
        list={list}
        listRef={listRef}
        label={listLabel}
        openId={route.messageId}
        searching={searchQuery !== null}
        searchUnavailable={searchUnavailable}
        onRetry={reloadList}
        onOpen={(m, index) => {
          dispatch({ type: 'cursor', index });
          openMessage(m);
        }}
        onNearEnd={loadMore}
      />
    </section>
  );

  const draft =
    route.compose === null
      ? null
      : route.compose === 'new'
        ? draftFor('new', null, me)
        : open?.status === 'ready' && open.detail !== null && open.bodyStatus !== 'loading'
          ? draftFor(route.compose, { detail: open.detail, body: open.body }, me)
          : null;
  const closeComposer = () => {
    void navigate(mailPath(route.mailboxId, route.messageId));
  };

  const readerPane =
    route.compose !== null ? (
      draft === null ? (
        <section className="pr-reader" aria-label="Composer" aria-busy="true">
          <Skeleton variant="text" lines={4} />
        </section>
      ) : (
        <Composer
          key={`${draft.mode}:${draft.sourceId ?? ''}`}
          draft={draft}
          onDiscard={closeComposer}
          {...(split ? {} : { back: backToList })}
        />
      )
    ) : (
      <ReadingPane
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
      />
    );

  let content;
  if (split) {
    content = (
      <>
        {listPane}
        {readerPane}
      </>
    );
  } else if (view === 'mailboxes') {
    content = <MailboxIndex mailboxes={mailboxes} headingRef={viewHeading} />;
  } else if (view === 'list') {
    content = listPane;
  } else {
    content = readerPane;
  }

  return (
    <div className="pr-mail" data-layout={split ? 'split' : 'push'} data-view={view ?? 'split'} ref={rootRef}>
      <h1 className="pr-vh">Mail</h1>
      {content}
      <ShortcutsOverlay open={overlay} onOpenChange={setOverlay} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        mailboxes={mailboxes}
        target={target()}
        onAction={perform}
        onMove={move}
        onNavigate={(path) => {
          void navigate(path);
        }}
      />
    </div>
  );
}

function ListBody({
  list,
  listRef,
  label,
  openId,
  searching,
  searchUnavailable,
  onRetry,
  onOpen,
  onNearEnd,
}: {
  list: ReturnType<typeof listReducer>;
  listRef: React.Ref<MessageListHandle>;
  label: string;
  openId: string | null;
  searching: boolean;
  searchUnavailable: boolean;
  onRetry: () => void;
  onOpen: (m: MessageSummary, index: number) => void;
  onNearEnd: () => void;
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
          Postroom did not answer. Check your connection.
        </EmptyState>
      </div>
    );
  }
  if (list.messages.length === 0) {
    return (
      <div className="pr-list pr-list--state">
        <EmptyState kind={searching ? 'no-results' : 'empty'} heading={searching ? 'Nothing matched that search' : 'No messages here'} size="inline" headingLevel={3}>
          {searching ? 'Try fewer or different words.' : 'New mail appears here as it arrives.'}
        </EmptyState>
      </div>
    );
  }
  return <MessageList ref={listRef} messages={list.messages} cursor={list.cursor} openId={openId} label={label} onOpen={onOpen} onNearEnd={onNearEnd} />;
}

/** Below tablet width, the first level of push navigation. */
function MailboxIndex({ mailboxes, headingRef }: { mailboxes: Mailbox[] | null; headingRef: React.Ref<HTMLHeadingElement> }) {
  return (
    <section className="pr-mail__list pr-mailboxes" aria-labelledby="pr-mailboxes-title">
      <div className="pr-listhead">
        <h2 id="pr-mailboxes-title" className="pr-listhead__title" tabIndex={-1} ref={headingRef}>
          Mailboxes
        </h2>
      </div>
      {mailboxes === null ? (
        <Skeleton variant="text" lines={5} />
      ) : (
        <nav aria-label="Mailboxes">
          <ul className="pr-mailboxes__list">
            {mailboxes.map((m) => (
              <li key={m.id}>
                <RouterLink className="pr-mailboxes__item" to={mailPath(m.id)} aria-label={m.unseen > 0 ? `${mailboxLabel(m)}, ${String(m.unseen)} unread` : mailboxLabel(m)}>
                  <span className="pr-mailboxes__icon" aria-hidden="true">
                    {mailboxIcon(m.specialUse, m.name)}
                  </span>
                  <span className="pr-mailboxes__name">{mailboxLabel(m)}</span>
                  {m.unseen > 0 ? (
                    <span className="pr-mailboxes__count" aria-hidden="true">
                      {m.unseen}
                    </span>
                  ) : null}
                </RouterLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </section>
  );
}
