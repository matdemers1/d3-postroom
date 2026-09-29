// PST-T-14.5: one message in the list — who (initials avatar and display name; the address beside
// it only for a first-time sender or a phishing warning), when, what (subject), and a one-line
// snippet; unread is bold AND a dot, never weight alone. The row is an `option` of the list's
// listbox and holds nothing focusable: its actions live in RowActions, a sibling toolbar, so the
// list never nests one interactive control in another (axe `nested-interactive`).
//
// The height is fixed (ROW_HEIGHT) so the list can be virtualised. A leaving row keeps that height
// — its slot is the placeholder — while its content fades and slides out; the list then drops the
// slot in one frame, so nothing inside the virtual window animates its layout.
import { memo } from 'react';
import { listDate } from '../format';
import { PaperclipIcon, StarIcon } from '../icons';
import { isStarred, isUnread } from '../list';
import { initials, senderLine, snippetLine, type RowSummary } from './triage';

/** Must match .pr-mrow's height in list.css. */
export const ROW_HEIGHT = 80;

export const rowId = (id: string): string => `pr-msg-${id}`;

/** "Deletes in N days" for a message in Trash, "Deletes today" on its last day; null when no clock. */
export function deletesIn(expiresAt: string | null | undefined, now: Date): string | null {
  if (expiresAt === null || expiresAt === undefined) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const days = Math.ceil((at - now.getTime()) / 86_400_000);
  if (days <= 0) return 'Deletes today';
  return days === 1 ? 'Deletes in 1 day' : `Deletes in ${String(days)} days`;
}

export interface MessageRowProps {
  message: RowSummary;
  index: number;
  count: number;
  /** The keyboard cursor (the listbox's active descendant). */
  cursor: boolean;
  /** The message open in the reading pane. */
  open: boolean;
  /** Undefined outside selection mode; true/false inside it. */
  checked: boolean | undefined;
  leaving: boolean;
  /** A phishing warning is known for this message (the open one's detail says so). */
  warned: boolean;
  now: Date;
  /** PST-T-14.9: the bucket chip's label, where the list does not imply the bucket; null for none.
   *  Part of the option (it holds nothing focusable): a click on it opens "Why it's here". */
  chip?: string | null;
}

export const MessageRow = memo(function MessageRow({ message: m, index, count, cursor, open, checked, leaving, warned, now, chip = null }: MessageRowProps) {
  const unread = isUnread(m);
  const starred = isStarred(m);
  const sender = senderLine(m, warned);
  const snippet = snippetLine(m.snippet);
  const expiry = deletesIn(m.expiresAt, now);
  const classes = ['pr-mrow'];
  if (unread) classes.push('pr-mrow--unread', 'pr-row--unread');
  if (checked === true) classes.push('pr-mrow--checked');
  if (leaving) classes.push('pr-mrow--leaving');
  return (
    <div
      id={rowId(m.id)}
      role="option"
      aria-selected={cursor}
      aria-setsize={count}
      aria-posinset={index + 1}
      {...(open ? { 'aria-current': 'true' as const } : {})}
      {...(checked === undefined ? {} : { 'aria-checked': checked })}
      data-message-id={m.id}
      data-index={index}
      className={classes.join(' ')}
    >
      <span className="pr-mrow__inner">
        <span className="pr-mrow__dot" aria-hidden="true" />
        {/* The avatar is the pointer's way into selection: a click on it toggles the row (x does
            the same from the keyboard). It is part of the option, not a control of its own. */}
        <span className="pr-mrow__avatar" data-select="true" aria-hidden="true" title={checked === true ? 'Deselect' : 'Select'}>
          {checked === true ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
              <path d="m5 12 5 5 9-10" />
            </svg>
          ) : (
            initials(m.fromName, m.from)
          )}
        </span>
        <span className="pr-mrow__body">
          <span className="pr-mrow__line">
            <span className="pr-mrow__name">
              {unread ? <span className="pr-vh">Unread, </span> : null}
              {sender.name}
            </span>
            {sender.address === null ? null : (
              <span className="pr-mrow__addr">
                <span className="pr-vh">, </span>
                {sender.address}
              </span>
            )}
            {sender.warned ? (
              <span className="pr-mrow__tag pr-mrow__tag--warn">
                <span className="pr-vh">, </span>Check sender
              </span>
            ) : sender.firstTime ? (
              <span className="pr-mrow__tag">
                <span className="pr-vh">, </span>First message
              </span>
            ) : null}
            <span className="pr-mrow__meta">
              {m.hasAttachments === true ? (
                <span className="pr-mrow__glyph" title="Has attachments">
                  <PaperclipIcon />
                  <span className="pr-vh">, has attachments</span>
                </span>
              ) : null}
              {starred ? (
                <span className="pr-mrow__glyph pr-mrow__glyph--star" title="Starred">
                  <StarIcon filled />
                  <span className="pr-vh">, starred</span>
                </span>
              ) : null}
              <span className="pr-mrow__date">
                <span className="pr-vh">, </span>
                <time dateTime={m.date}>{listDate(m.date, now)}</time>
              </span>
            </span>
          </span>
          <span className="pr-mrow__subject">
            {chip === null ? null : (
              <span className="pr-chip pr-mrow__chip" data-chip="true" data-bucket={m.bucket ?? undefined} title="Why it's here">
                <span className="pr-vh">, </span>
                {chip}
              </span>
            )}
            <span className="pr-vh">, </span>
            {m.subject === null || m.subject === '' ? '(no subject)' : m.subject}
          </span>
          <span className="pr-mrow__snippet">
            {expiry === null ? null : (
              <span className="pr-mrow__expires" title={`Permanently deleted from Trash on ${new Date(m.expiresAt ?? '').toLocaleDateString()}`}>
                <span className="pr-vh">, </span>
                {expiry}
                {snippet === '' ? null : ' · '}
              </span>
            )}
            {snippet === '' ? null : (
              <>
                <span className="pr-vh">, </span>
                {snippet}
              </>
            )}
          </span>
        </span>
      </span>
    </div>
  );
});
