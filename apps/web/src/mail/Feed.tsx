// The Newsletters feed (PST-T-5.6, PST-REQ-109): a continuous scroll of full message bodies, each
// rendered through the same sandboxed render-ticket iframe the reading pane uses, lazily as they
// scroll into view — a newsletter's images and tracking are only fetched once the reader is
// actually looking at it. "Mark all read" clears the whole loaded page in one pass; a message that
// offers RFC 8058 one-click unsubscribe gets its own button (PST-REQ-110), right there in the feed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Button, EmptyState, Skeleton, Stack } from '@d3cloud/ui';
import { api, ApiError, senderProfilePath, type Mailbox, type MessageSummary, type RenderTicket } from '../api';
import { fullDate } from './format';
import { isUnread, SEEN } from './list';
import { MAIL_FRAME_HEIGHT, MAIL_FRAME_SANDBOX } from './ReadingPane';
import { LoadFailed } from '../screens/states';

const PAGE = 20;

export interface FeedProps {
  mailbox: Mailbox;
}

type FrameState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; ticket: RenderTicket } | { status: 'unavailable' } | { status: 'error' };

/** One newsletter's body, fetched only once its wrapper has scrolled into view. */
function FeedItemFrame({ messageId }: { messageId: string }) {
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<FrameState>({ status: 'idle' });
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setState({ status: 'loading' });
    api.renderMessage(messageId, false).then(
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
  }, [visible, messageId]);

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
        <iframe
          key={state.ticket.url}
          title="Newsletter content"
          data-testid="message-html"
          src={state.ticket.url}
          sandbox={MAIL_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          style={{ display: 'block', width: '100%', height: MAIL_FRAME_HEIGHT, boxSizing: 'border-box', border: 'var(--border-width) solid var(--color-border)', borderRadius: 'var(--radius-md)' }}
        />
      )}
    </div>
  );
}

function FeedItem({ message, onUnsubscribed }: { message: MessageSummary; onUnsubscribed: (address: string) => void }) {
  const [unsub, setUnsub] = useState<{ status: 'idle' | 'busy' | 'not-offered' | 'sent' | 'failed'; detail: string | undefined }>({ status: 'idle', detail: undefined });

  const unsubscribe = async (): Promise<void> => {
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
          {unsub.status === 'sent' ? (
            <span data-testid="unsubscribe-sent">Unsubscribed</span>
          ) : unsub.status === 'not-offered' ? (
            <span data-testid="unsubscribe-not-offered">{unsub.detail !== undefined ? `mailto: link only (${unsub.detail})` : 'No one-click unsubscribe'}</span>
          ) : (
            <Button size="sm" variant="ghost" disabled={unsub.status === 'busy'} onClick={() => { void unsubscribe(); }} data-testid="unsubscribe-button">
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
      <FeedItemFrame messageId={message.id} />
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
        <Button size="sm" variant="ghost" disabled={marking || !messages.some(isUnread)} onClick={() => { void markAllRead(); }} data-testid="mark-all-read">
          {marking ? 'Marking…' : 'Mark all read'}
        </Button>
      </div>
      {messages.map((m) => (
        <FeedItem key={m.id} message={m} onUnsubscribed={forgetSender} />
      ))}
      <div ref={sentinelRef} aria-hidden="true" />
      {loadingMore ? <Skeleton variant="block" height={220} /> : null}
    </Stack>
  );
}
