// The Newsletters feed (PST-T-5.6, PST-REQ-109): a continuous scroll of full message bodies, each
// rendered through the same sandboxed render-ticket iframe the reading pane uses, lazily as they
// scroll into view — a newsletter's images and tracking are only fetched once the reader is
// actually looking at it. "Mark all read" clears the whole loaded page in one pass; a message that
// offers RFC 8058 one-click unsubscribe gets its own button (PST-REQ-110), right there in the feed.
//
// PST-T-17.3 (PST-DA-084): each frame is sized to its message. The frame cannot say how tall its
// document is — no allow-scripts, an opaque origin, a CSP with no script (PST-REQ-081, PST-ADR-011)
// — so the render ticket carries the server's estimate (apps/api/src/usercontent/height.ts) at two
// frame widths; the feed interpolates for the width it has and clamps. A one-line note gets a short
// frame; a long issue stops at FEED_FRAME_MAX under a fade, with "Read in full" opening it in the
// reading view.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Button, EmptyState, Link, Modal, ModalClose, Skeleton, Stack, StatusDot, useTheme } from '@d3cloud/ui';
import { api, ApiError, senderProfilePath, type Mailbox, type MessageSummary, type RenderTicket } from '../api';
import { fullDate } from './format';
import { isUnread, SEEN } from './list';
import { MAIL_FRAME_SANDBOX } from './ReadingPane';
import { mailboxKey, mailPath } from './route';
import { LoadFailed } from '../screens/states';
import { HeaderWhyControl } from './sorting/BucketChip';
import { mailboxBucket, type ChipContext, type FilingBucket } from './sorting/sorting';
import './feed.css';

const PAGE = 20;

/** The shortest frame: a one-line note still reads as a body, not a sliver. */
export const FEED_FRAME_MIN = 48;
/** The tallest frame: past this an issue is cut off under a fade, with "Read in full". */
export const FEED_FRAME_MAX = 480;
/** The frame widths the server's estimate is made at (apps/api/src/usercontent/height.ts ESTIMATE_WIDTHS). */
const ESTIMATE_NARROW = 360;
const ESTIMATE_WIDE = 720;
/** The frame's own hairline, top and bottom, plus a little room so an estimate a few px short never scrolls. */
const FRAME_ALLOWANCE = 2 + 8;

export interface FeedFrameSize {
  /** The frame's height in CSS px. */
  height: number;
  /** The message is taller than FEED_FRAME_MAX: cut off under a fade, with "Read in full". */
  capped: boolean;
}

/**
 * The frame's height from the ticket's estimate, for a frame `frameWidth` px wide (0 when it has not
 * been measured: the wide estimate). Between the two widths the estimate is interpolated; narrower
 * than the narrow one, text wraps more, so it grows in proportion. No estimate (an older server)
 * is treated as long: the cap, and "Read in full".
 */
export function feedFrameSize(estimate: RenderTicket['heightEstimate'], frameWidth: number): FeedFrameSize {
  if (estimate === undefined) return { height: FEED_FRAME_MAX, capped: true };
  const { narrow, wide } = estimate;
  let content: number;
  if (frameWidth <= 0 || frameWidth >= ESTIMATE_WIDE) content = wide;
  else if (frameWidth >= ESTIMATE_NARROW) content = narrow + ((wide - narrow) * (frameWidth - ESTIMATE_NARROW)) / (ESTIMATE_WIDE - ESTIMATE_NARROW);
  else content = (narrow * ESTIMATE_NARROW) / frameWidth;
  const height = Math.ceil(content) + FRAME_ALLOWANCE;
  if (height > FEED_FRAME_MAX) return { height: FEED_FRAME_MAX, capped: true };
  return { height: Math.max(FEED_FRAME_MIN, height), capped: false };
}

export interface FeedProps {
  mailbox: Mailbox;
}

type FrameState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; ticket: RenderTicket } | { status: 'unavailable' } | { status: 'error' };

/** One newsletter's body, fetched only once its wrapper has scrolled into view. */
function FeedItemFrame({ messageId, subject, readPath }: { messageId: string; subject: string; readPath: string }) {
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<FrameState>({ status: 'idle' });
  const [width, setWidth] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // The frame's width decides how its estimate reads (text wraps more, tables stack, when narrow).
  // Measured on the parent's own wrapper: the frame's document is another origin's, never read.
  useEffect(() => {
    const el = wrapperRef.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { setWidth(el.clientWidth); });
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (el === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, []);

  // PST-T-15.12: the frame renders in the app's theme, so a theme change fetches a fresh ticket.
  const theme = useTheme().resolved;
  useEffect(() => {
    if (!visible) return;
    let live = true;
    setState({ status: 'loading' });
    api.renderMessage(messageId, false, theme).then(
      (ticket) => {
        if (live) setState({ status: 'ready', ticket });
      },
      (error: unknown) => {
        if (live) setState(error instanceof ApiError && error.status === 503 ? { status: 'unavailable' } : { status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [visible, messageId, theme]);

  return (
    <div ref={wrapperRef} data-testid="feed-item-frame">
      {state.status === 'idle' || state.status === 'loading' ? (
        <Skeleton variant="block" height={220} />
      ) : state.status === 'unavailable' ? (
        <Alert tone="info" title="This message cannot be shown here">
          Its formatted view is not available.
        </Alert>
      ) : state.status === 'error' ? (
        <Alert tone="warning" title="Could not load this message">Reload the page in a moment.</Alert>
      ) : (
        <FramedBody ticket={state.ticket} size={feedFrameSize(state.ticket.heightEstimate, width - 2)} subject={subject} readPath={readPath} />
      )}
    </div>
  );
}

/** The frame at its estimated height; past the cap, a fade over its foot and "Read in full" under it. */
function FramedBody({ ticket, size, subject, readPath }: { ticket: RenderTicket; size: FeedFrameSize; subject: string; readPath: string }) {
  return (
    <>
      <div className="pr-feed__frame" data-capped={size.capped}>
        <iframe
          key={ticket.url}
          title="Newsletter content"
          data-testid="message-html"
          className="pr-feed__frame-el"
          src={ticket.url}
          sandbox={MAIL_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          style={{ height: size.height }}
        />
        {size.capped ? <div className="pr-feed__fade" aria-hidden="true" data-testid="feed-item-fade" /> : null}
      </div>
      {size.capped ? (
        <div className="pr-feed__more">
          <Link asChild variant="standalone">
            <RouterLink to={readPath} data-testid="feed-read-in-full">
              Read in full<span className="pr-vh">: {subject}</span>
            </RouterLink>
          </Link>
        </div>
      ) : null}
    </>
  );
}

function FeedItem({
  message,
  list,
  readPath,
  onUnsubscribed,
  onCorrected,
}: {
  message: MessageSummary;
  list: ChipContext;
  /** Where "Read in full" opens this message: the reading view. */
  readPath: string;
  onUnsubscribed: (address: string) => void;
  onCorrected: (message: MessageSummary, bucket: FilingBucket) => void;
}) {
  const [unsub, setUnsub] = useState<{ status: 'idle' | 'busy' | 'not-offered' | 'sent' | 'failed'; detail: string | undefined }>({ status: 'idle', detail: undefined });
  const [confirming, setConfirming] = useState(false);

  const unsubscribe = async (): Promise<void> => {
    setConfirming(false);
    setUnsub({ status: 'busy', detail: undefined });
    try {
      const result = await api.unsubscribe(message.id);
      if (!result.offered) {
        setUnsub({ status: 'not-offered', detail: result.mailto ?? undefined });
        return;
      }
      if (result.ok) {
        setUnsub({ status: 'sent', detail: undefined });
        if (message.from !== null) onUnsubscribed(message.from);
      } else {
        setUnsub({ status: 'failed', detail: result.detail });
      }
    } catch {
      setUnsub({ status: 'failed', detail: undefined });
    }
  };

  return (
    <article className="pr-feed__item" data-testid="feed-item" aria-label={message.subject ?? '(no subject)'}>
      <header className="pr-feed__item-head">
        <div>
          <div className="pr-feed__item-subject">{message.subject ?? '(no subject)'}</div>
          <div className="pr-feed__item-meta">
            {message.from !== null ? <RouterLink to={senderProfilePath(message.from)}>{message.from}</RouterLink> : 'Unknown sender'} · {fullDate(message.date)}
          </div>
        </div>
        <div className="pr-feed__item-actions">
          {/* PST-T-16.21: no open message here, so the control is told which folder this feed is. */}
          <HeaderWhyControl message={message} list={list} onCorrected={(bucket) => { onCorrected(message, bucket); }} />
          {unsub.status === 'sent' ? (
            <span data-testid="unsubscribe-sent">Unsubscribed</span>
          ) : unsub.status === 'not-offered' ? (
            <span data-testid="unsubscribe-not-offered">{unsub.detail !== undefined ? `mailto: link only (${unsub.detail})` : 'No one-click unsubscribe'}</span>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={unsub.status === 'busy'}
              onClick={() => { setConfirming(true); }}
              data-testid="unsubscribe-button"
            >
              {unsub.status === 'busy' ? 'Unsubscribing…' : 'Unsubscribe'}
            </Button>
          )}
        </div>
      </header>
      {unsub.status === 'failed' ? (
        <Alert tone="danger" title="Unsubscribe failed">
          {unsub.detail ?? 'Postroom could not reach the sender.'}
        </Alert>
      ) : null}
      <FeedItemFrame messageId={message.id} subject={message.subject ?? '(no subject)'} readPath={readPath} />
      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title="Unsubscribe from this sender?"
        description={`Postroom sends the one-click unsubscribe request${message.from === null ? '' : ` to ${message.from}`}. You can always resubscribe from the sender directly.`}
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="button" variant="primary" onClick={() => { void unsubscribe(); }}>
              Unsubscribe
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </article>
  );
}

/**
 * A continuous scroll of full message bodies for one bucket mailbox — built for Newsletters
 * (PST-REQ-109), but works for any mailbox it is pointed at.
 */
export function Feed({ mailbox }: FeedProps) {
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [marking, setMarking] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadFirstPage = useCallback(async () => {
    setMessages(null);
    setLoadError(null);
    try {
      const page = await api.messages(mailbox.id, { limit: PAGE });
      setMessages(page.messages);
      setCursor(page.nextCursor);
    } catch (caught) {
      setLoadError(caught);
    }
  }, [mailbox.id]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.messages(mailbox.id, { cursor, limit: PAGE });
      setMessages((prev) => [...(prev ?? []), ...page.messages]);
      setCursor(page.nextCursor);
    } catch {
      // A failed "load more" leaves what is already shown; the reader can scroll again to retry.
    } finally {
      setLoadingMore(false);
    }
  }, [mailbox.id, cursor, loadingMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, [loadMore]);

  const markAllRead = async (): Promise<void> => {
    if (messages === null) return;
    setMarking(true);
    try {
      const unread = messages.filter(isUnread);
      for (const m of unread) {
        try {
          await api.patchMessage(m.id, m.modseq, { flags: { add: [SEEN] } });
        } catch {
          // One message's flag change failing (moved on, stale modseq) does not stop the rest.
        }
      }
      await loadFirstPage();
    } finally {
      setMarking(false);
    }
  };

  // Nothing to update locally beyond the per-item state the button already carries; kept as a hook
  // point so a future "hide unsubscribed senders" filter has somewhere to plug in.
  const forgetSender = (_address: string): void => {};

  // A correction that moves a newsletter elsewhere takes it out of the feed (the move itself, the
  // preference and the Undo Toast are MailView's correct(), reached through the sorting context).
  const folder = mailboxBucket(mailbox);
  const list: ChipContext = { kind: 'mailbox', bucket: folder };
  const corrected = (message: MessageSummary, bucket: FilingBucket): void => {
    if (bucket !== folder) setMessages((prev) => (prev === null ? prev : prev.filter((m) => m.id !== message.id)));
  };

  if (loadError !== null) {
    return <LoadFailed error={loadError} what="the feed" onRetry={() => void loadFirstPage()} size="inline" />;
  }

  if (messages === null) {
    return (
      <div role="status" aria-label="Loading the feed" aria-busy="true">
        <Stack gap="16">
          <Skeleton variant="block" height={220} />
          <Skeleton variant="block" height={220} />
        </Stack>
      </div>
    );
  }

  if (messages.length === 0) {
    return <EmptyState kind="empty" heading="No newsletters yet" size="inline">Newsletters land here as they arrive.</EmptyState>;
  }

  return (
    <Stack gap="16" data-testid="feed">
      <div className="pr-feed__toolbar">
        {/* PST-T-16.23: nothing unread is a status, not a disabled button. */}
        {marking || messages.some(isUnread) ? (
          <Button size="sm" variant="ghost" disabled={marking} onClick={() => { void markAllRead(); }} data-testid="mark-all-read">
            {marking ? 'Marking…' : 'Mark all read'}
          </Button>
        ) : (
          <StatusDot tone="idle" role="status" data-testid="all-read">
            All read
          </StatusDot>
        )}
      </div>
      {messages.map((m) => (
        <FeedItem key={m.id} message={m} list={list} readPath={mailPath(mailboxKey(mailbox), m.id)} onUnsubscribed={forgetSender} onCorrected={corrected} />
      ))}
      <div ref={sentinelRef} aria-hidden="true" />
      {loadingMore ? <Skeleton variant="block" height={220} /> : null}
    </Stack>
  );
}
