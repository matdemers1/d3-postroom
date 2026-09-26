// The message list: one listbox, rows of fixed height so it can be virtualised — only the rows in
// view (plus an overscan) are in the DOM, however long the mailbox. The keyboard cursor is the
// listbox's active descendant, so j/k move it without moving focus, and a screen reader follows.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { MessageSummary } from '../api';
import { listDate } from './format';
import { StarIcon } from './icons';
import { isStarred, isUnread, scrollToReveal, visibleRange } from './list';

/** Must match .pr-row's height in mail.css. */
export const ROW_HEIGHT = 64;

export interface MessageListHandle {
  focus: () => void;
}

export interface MessageListProps {
  messages: MessageSummary[];
  cursor: number;
  openId: string | null;
  label: string;
  onOpen: (message: MessageSummary, index: number) => void;
  onNearEnd: () => void;
}

export const rowId = (id: string): string => `pr-msg-${id}`;

/**
 * The Trash clock (PST-T-7.7, PST-REQ-129): the API sends expiresAt on a message in Trash — when the
 * retention sweep will expunge it. Null (or absent) outside Trash, or when Trash keeps mail forever.
 */
type WithClock = MessageSummary & { expiresAt?: string | null };

/** "Deletes in N days" for a Trash message, "Deletes today" on its last day; null when no clock. */
export function deletesIn(expiresAt: string | null | undefined, now: Date): string | null {
  if (expiresAt === null || expiresAt === undefined) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const days = Math.ceil((at - now.getTime()) / 86_400_000);
  if (days <= 0) return 'Deletes today';
  return days === 1 ? 'Deletes in 1 day' : `Deletes in ${days} days`;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { messages, cursor, openId, label, onOpen, onNearEnd },
  ref,
) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });

  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), []);

  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = () => {
      setScroll({ top: el.scrollTop, height: el.clientHeight });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  // Keep the cursor row in view as j/k move it.
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null || cursor < 0) return;
    const next = scrollToReveal(cursor, el.scrollTop, el.clientHeight, ROW_HEIGHT);
    if (next !== null) {
      el.scrollTop = next;
      setScroll({ top: next, height: el.clientHeight });
    }
  }, [cursor]);

  const { start, end } = visibleRange(scroll.top, scroll.height, ROW_HEIGHT, messages.length);

  useEffect(() => {
    if (messages.length > 0 && end >= messages.length - 5) onNearEnd();
  }, [end, messages.length, onNearEnd]);

  const active = messages[cursor];
  const now = new Date();
  return (
    <div
      ref={box}
      className="pr-list"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      {...(active === undefined ? {} : { 'aria-activedescendant': rowId(active.id) })}
      onScroll={(e) => {
        setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight });
      }}
      style={{ paddingTop: start * ROW_HEIGHT, paddingBottom: (messages.length - end) * ROW_HEIGHT }}
    >
      {messages.slice(start, end).map((m, i) => {
        const index = start + i;
        const unread = isUnread(m);
        const starred = isStarred(m);
        const expiry = deletesIn((m as WithClock).expiresAt, now);
        return (
          <div
            key={m.id}
            id={rowId(m.id)}
            role="option"
            aria-selected={index === cursor}
            aria-setsize={messages.length}
            aria-posinset={index + 1}
            {...(m.id === openId ? { 'aria-current': 'true' as const } : {})}
            data-message-id={m.id}
            className={`pr-row${unread ? ' pr-row--unread' : ''}`}
            onClick={() => {
              onOpen(m, index);
            }}
          >
            <span className="pr-row__from">
              {unread ? <span className="pr-vh">Unread, </span> : null}
              {m.from ?? '(unknown sender)'}
            </span>
            <span className="pr-row__date">
              <time dateTime={m.date}>{listDate(m.date, now)}</time>
            </span>
            <span className="pr-row__subject">{m.subject === null || m.subject === '' ? '(no subject)' : m.subject}</span>
            <span className="pr-row__marks">
              {expiry === null ? null : (
                <span className="pr-row__expires" title={`Permanently deleted from Trash on ${new Date((m as WithClock).expiresAt ?? '').toLocaleDateString()}`}>
                  <span className="pr-vh">, </span>
                  {expiry}
                </span>
              )}
              {starred ? (
                <span className="pr-row__star" title="Starred">
                  <StarIcon filled />
                  <span className="pr-vh">, starred</span>
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
});
