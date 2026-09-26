// The Inbox's Priority / People split (PST-REQ-101, PST-T-11.4) and what an empty mailbox says.
// The worker files INBOX mail with the keyword $Priority or $People (apps/worker/src/stages/file.ts);
// the webmail shows that split as a segmented control over the list. Everything is the default,
// because until the reply graph fills in the classifier files new senders as People and a
// Priority-first Inbox would hide the operator's mail. Pure, so it is unit-tested.
import type { Mailbox, MailboxSplit } from '../api';

export type InboxSegment = 'all' | 'priority' | 'people';

export const INBOX_SEGMENTS: readonly InboxSegment[] = ['all', 'priority', 'people'];

export function isInboxSegment(value: string): value is InboxSegment {
  return (INBOX_SEGMENTS as readonly string[]).includes(value);
}

/** The keyword a segment filters the list by, or null for Everything. */
export function segmentKeyword(segment: InboxSegment): '$Priority' | '$People' | null {
  if (segment === 'priority') return '$Priority';
  if (segment === 'people') return '$People';
  return null;
}

export interface SegmentItem {
  value: InboxSegment;
  label: string;
  count?: number;
  countLabel?: string;
}

/** The segmented control's items; a segment's count is its unread mail, shown only when there is some. */
export function segmentItems(split: MailboxSplit | null, inboxUnseen: number): SegmentItem[] {
  const withCount = (value: InboxSegment, label: string, unseen: number | undefined): SegmentItem =>
    unseen === undefined || unseen <= 0 ? { value, label } : { value, label, count: unseen, countLabel: 'unread' };
  return [
    withCount('all', 'Everything', inboxUnseen),
    withCount('priority', 'Priority', split?.priority.unseen),
    withCount('people', 'People', split?.people.unseen),
  ];
}

/** True when a message belongs in the list a segment shows (a live arrival is checked with this). */
export function inSegment(flags: readonly string[], segment: InboxSegment): boolean {
  const keyword = segmentKeyword(segment);
  return keyword === null || flags.includes(keyword);
}

export interface EmptyCopy {
  heading: string;
  body: string;
}

const BUCKET_COPY: Readonly<Record<string, EmptyCopy>> = {
  Newsletters: { heading: 'No newsletters', body: 'Mailing lists and newsletters are sorted here, out of your Inbox.' },
  Updates: { heading: 'No updates', body: 'Account notices and service updates from companies are sorted here.' },
  Receipts: { heading: 'No receipts', body: 'Orders, invoices and payment confirmations are sorted here.' },
  Notifications: { heading: 'No notifications', body: 'Automated alerts from apps and sites are sorted here.' },
  Snoozed: { heading: 'Nothing snoozed', body: 'Snoozed conversations wait here and come back to your Inbox when their time comes.' },
};

/**
 * What an empty mailbox says, by its role. "New mail appears here as it arrives" is true of the
 * Inbox and a bucket only — nothing arrives in Trash, and the Trash sentence must not promise a
 * deletion the server does not do (PST-REQ-129: nothing is removed silently).
 */
export function emptyMailboxCopy(mailbox: Pick<Mailbox, 'name' | 'specialUse'> | null, segment: InboxSegment = 'all'): EmptyCopy {
  if (mailbox === null) return { heading: 'No messages here', body: 'Choose a mailbox to see its messages.' };
  switch (mailbox.specialUse) {
    case 'inbox':
      if (segment === 'priority') return { heading: 'Nothing in Priority', body: 'Mail from people you write to lands here. Everything else is under People.' };
      if (segment === 'people') return { heading: 'Nothing in People', body: 'Mail from people you have not written to yet lands here.' };
      return { heading: 'You are all caught up', body: 'New mail appears here as it arrives.' };
    case 'sent':
      return { heading: 'Nothing sent yet', body: 'Messages you send appear here, with their delivery status.' };
    case 'drafts':
      return { heading: 'No drafts', body: 'Messages you save without sending wait here.' };
    case 'archive':
      return { heading: 'Nothing archived', body: 'Archived mail leaves your Inbox and is kept here.' };
    case 'junk':
      return { heading: 'No junk', body: 'Mail the filter thinks is spam lands here. Move a message out to teach it otherwise.' };
    case 'trash':
      return { heading: 'Trash is empty', body: 'Deleted messages wait here, each with the date it will be removed, so you can still move them back.' };
    case 'rejects':
      return { heading: 'Nothing rejected', body: 'Mail the server refused to accept is kept here for a while, so you can rescue anything refused by mistake.' };
    case null:
      return BUCKET_COPY[mailbox.name] ?? { heading: 'No messages here', body: 'Messages you move here appear in this folder.' };
  }
}
