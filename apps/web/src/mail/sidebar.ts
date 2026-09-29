// The Mail sidebar's shape (PST-T-14.3, PST-REQ-189): mailboxes only, short, in the order a triage
// session wants them — Inbox, Sent, Drafts, Archive; the four buckets the sorter fills, together
// under "Sorted for you"; Junk and Rejects one click away (the sorter's safety net) with a quiet
// "new since your last visit" count; and everything else (Trash, your own folders) behind More.
// Pure, so it is unit-tested.
import type { Mailbox, SpecialUse } from '../api';
import { findSpecial } from './format';

/** The bucket folders the sorter files into, in sidebar order (packages/classifier BUCKET_FOLDERS). */
export const SORTED_FOLDERS = ['Updates', 'Receipts', 'Notifications', 'Newsletters'] as const;

export interface MailSidebar {
  primary: Mailbox[];
  sorted: Mailbox[];
  safetyNet: Mailbox[];
  more: Mailbox[];
}

export function mailSidebar(mailboxes: readonly Mailbox[]): MailSidebar {
  const used = new Set<string>();
  const take = (m: Mailbox | undefined): Mailbox[] => {
    if (m === undefined || used.has(m.id)) return [];
    used.add(m.id);
    return [m];
  };
  const special = (use: SpecialUse): Mailbox[] => take(findSpecial(mailboxes, use));
  const primary = [...special('inbox'), ...special('sent'), ...special('drafts'), ...special('archive')];
  const sorted = SORTED_FOLDERS.flatMap((name) => take(mailboxes.find((m) => m.specialUse === null && m.name === name)));
  const safetyNet = [...special('junk'), ...special('rejects')];
  const trash = special('trash');
  const rest = mailboxes.filter((m) => !used.has(m.id));
  return { primary, sorted, safetyNet, more: [...trash, ...rest] };
}

/** The per-browser marker of what you had seen in Junk or Rejects when you last looked: its uidnext. */
export type LastVisits = Readonly<Record<string, number>>;

export const LAST_VISIT_KEY = 'postroom-last-visit';

/** How many messages arrived since your last visit — never more than are still unread, and 0 for a
 * mailbox you have never opened here only when nothing in it is unread. */
export function newSinceVisit(mailbox: Pick<Mailbox, 'id' | 'uidnext' | 'unseen'>, visits: LastVisits): number {
  if (mailbox.unseen <= 0) return 0;
  const seen = visits[mailbox.id];
  if (seen === undefined) return mailbox.unseen;
  return Math.max(0, Math.min(mailbox.unseen, mailbox.uidnext - seen));
}

export function parseVisits(raw: string | null): LastVisits {
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, number] => typeof e[1] === 'number'));
  } catch {
    return {};
  }
}
