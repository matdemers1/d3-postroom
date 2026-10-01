// PST-T-14.5: one message in the list — who, when, what (subject), and a one-line snippet; unread is
// bold AND a dot, never weight alone. The row is an `option` of the list's listbox and holds nothing
// focusable: its actions live in RowActions, a sibling toolbar, so the list never nests one
// interactive control in another (axe `nested-interactive`).
//
// PST-T-15.2 (PST-REQ-194): drawn to the redesign canvas — a tinted D3 Avatar (`tint="auto"`, size
// lg: 40 px, the library size nearest the canvas's 36 px), sender and time, the thread count beside
// the name, subject, and a third line that leads with the row's Badges (Priority is `attention`,
// New sender `neutral`) before the snippet. One fixed height still, so the list stays virtual.
//
// PST-T-16.12 (PST-REQ-199): in Sent and Drafts the name slot names the recipients ("To: Alice
// (+1)") and the avatar follows the first of them; the mailbox's specialUse comes from the row's own
// mailbox in the mail context, so a Sent message reads the same in a search result.
//
// PST-T-16.15 (PST-DA-066): on a touch screen two decorative surfaces sit under the row's content —
// Archive on the trailing side, Read/Unread on the leading — which a sideways drag uncovers
// (../../mobile/swipe.ts decides, useRowSwipe moves; list.css draws).
//
// A leaving row keeps its height — its slot is the placeholder — while its content fades and slides
// out; the list then drops the slot in one frame, so nothing inside the virtual window animates its
// layout.
import { memo } from 'react';
import { Avatar, Badge } from '@d3cloud/ui';
import type { SpecialUse } from '../../api';
import { listDate } from '../format';
import { PaperclipIcon, StarIcon } from '../icons';
import { isStarred, isUnread } from '../list';
import { useOptionalMail } from '../MailContext';
import { readLabel } from '../../mobile/swipe';
import { rowAvatarName, senderLine, snippetLine, type RowSummary } from './triage';

/** Must match .pr-mrow's height in list.css. */
export const ROW_HEIGHT = 80;

export const PRIORITY = '$Priority';

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
  /** PST-T-14.11: the action cluster sits on this row — its first two lines leave room for it. */
  acting?: boolean;
  /** PST-T-15.2: how many listed messages share this one's conversation; shown from 2. */
  threadCount?: number;
  /** PST-T-15.2: draw the Priority badge for a $Priority message (not where the list is Priority). */
  showPriority?: boolean;
  /** PST-T-16.12: the specialUse of the row's mailbox; when absent it is looked up from the mail
   *  context by the message's mailboxId. Sent and Drafts rows name the recipients. */
  specialUse?: SpecialUse | null;
  /** PST-T-16.15: draw the swipe surfaces under the row (a touch screen). Decorative: the row's own
   *  actions stay the way in for the keyboard and for screen readers. */
  swipeable?: boolean;
  /** PST-T-16.15: the trailing (Archive) surface exists; false where the mailbox cannot be archived from. */
  swipeArchive?: boolean;
}

export const MessageRow = memo(function MessageRow({
  message: m,
  index,
  count,
  cursor,
  open,
  checked,
  leaving,
  warned,
  now,
  chip = null,
  acting = false,
  threadCount = 1,
  showPriority = true,
  specialUse,
  swipeable = false,
  swipeArchive = true,
}: MessageRowProps) {
  const mail = useOptionalMail();
  const use = specialUse !== undefined ? specialUse : (mail?.mailboxes?.find((b) => b.id === m.mailboxId)?.specialUse ?? null);
  const unread = isUnread(m);
  const starred = isStarred(m);
  const sender = senderLine(m, warned, use);
  const snippet = snippetLine(m.snippet);
  const expiry = deletesIn(m.expiresAt, now);
  // One Priority label per row: where the bucket chip already says Priority, the badge would repeat it.
  const priority = showPriority && m.flags.includes(PRIORITY) && chip === null;
  const classes = ['pr-mrow'];
  if (unread) classes.push('pr-mrow--unread', 'pr-row--unread');
  if (checked === true) classes.push('pr-mrow--checked');
  if (leaving) classes.push('pr-mrow--leaving');
  if (acting) classes.push('pr-mrow--acting');
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
      {swipeable ? (
        <>
          <span className="pr-mrow__swipe pr-mrow__swipe--read" aria-hidden="true">
            {readLabel(unread)}
          </span>
          {swipeArchive ? (
            <span className="pr-mrow__swipe pr-mrow__swipe--archive" aria-hidden="true">
              Archive
            </span>
          ) : null}
        </>
      ) : null}
      <span className="pr-mrow__inner">
        <span className="pr-mrow__dot" aria-hidden="true" />
        {/* The avatar is the pointer's way into selection: a click on it toggles the row (x does
            the same from the keyboard). It is part of the option, not a control of its own; the
            check lies over it on hover and while the row is selected. */}
        <span className="pr-mrow__avatar" data-select="true" aria-hidden="true" title={checked === true ? 'Deselect' : 'Select'}>
          <Avatar name={rowAvatarName(m, use)} size="lg" tint="auto" />
          <span className="pr-mrow__check">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
              <path d="m5 12 5 5 9-10" />
            </svg>
          </span>
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
            {threadCount > 1 ? (
              <Badge size="sm" tone="neutral" className="pr-mrow__count">
                <span className="pr-vh">, </span>
                {threadCount}
                <span className="pr-vh"> messages in this conversation</span>
              </Badge>
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
            {sender.warned ? (
              <Badge size="sm" tone="attention" className="pr-mrow__badge">
                <span className="pr-vh">, </span>Check sender
              </Badge>
            ) : sender.firstTime ? (
              <Badge size="sm" tone="neutral" className="pr-mrow__badge">
                <span className="pr-vh">, </span>New sender
              </Badge>
            ) : null}
            {priority ? (
              <Badge size="sm" tone="attention" className="pr-mrow__badge">
                <span className="pr-vh">, </span>Priority
              </Badge>
            ) : null}
            {expiry === null ? null : (
              <span className="pr-mrow__expires" title={`Permanently deleted from Trash on ${new Date(m.expiresAt ?? '').toLocaleDateString()}`}>
                <span className="pr-vh">, </span>
                {expiry}
              </span>
            )}
            {snippet === '' ? null : (
              <span className="pr-mrow__text">
                <span className="pr-vh">, </span>
                {snippet}
              </span>
            )}
          </span>
        </span>
      </span>
    </div>
  );
});
