// Small pure formatters for the mail view: names, dates, sizes, address lists. Unit-tested.
import type { Mailbox, MessageBody, SpecialUse } from '../api';

const SPECIAL_LABELS: Readonly<Record<SpecialUse, string>> = {
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  archive: 'Archive',
  junk: 'Junk',
  trash: 'Trash',
  rejects: 'Rejected',
};

/** "Inbox", not "INBOX"; a special-use folder by its role, anything else by its own name. */
export function mailboxLabel(mailbox: Pick<Mailbox, 'name' | 'specialUse'>): string {
  if (mailbox.name.toUpperCase() === 'INBOX') return 'Inbox';
  if (mailbox.specialUse !== null) return SPECIAL_LABELS[mailbox.specialUse];
  return mailbox.name;
}

export function findSpecial(mailboxes: readonly Mailbox[], use: SpecialUse): Mailbox | undefined {
  return mailboxes.find((m) => m.specialUse === use) ?? (use === 'inbox' ? mailboxes.find((m) => m.name.toUpperCase() === 'INBOX') : undefined);
}

/** Today → "14:05"; this year → "Sep 24"; older → "Sep 24, 2024". */
export function listDate(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fullDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Splits an address-list header value on the commas between addresses — not the ones inside a
 * quoted display name ("Doe, Jane" <jane@x>) or a comment.
 */
export function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (quoted) {
      current += ch;
      if (ch === '\\' && i + 1 < value.length) {
        current += value.charAt(i + 1);
        i++;
      } else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '<') angle++;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === '(') comment++;
    else if (ch === ')') comment = Math.max(0, comment - 1);
    if (ch === ',' && angle === 0 && comment === 0) {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** The bare address of "Name <a@b>" or "a@b", lower-cased; '' when there is none. */
export function addressOf(entry: string): string {
  const angle = /<([^<>]*)>/.exec(entry);
  const raw = angle?.[1] ?? entry.replace(/\([^)]*\)/g, '');
  return raw.trim().replace(/^"|"$/g, '').toLowerCase();
}

/** The display name of "Name <a@b>", unquoted; the address when there is no name. */
export function displayName(entry: string): string {
  const lt = entry.indexOf('<');
  if (lt > 0) {
    const name = entry.slice(0, lt).trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');
    if (name !== '') return name;
  }
  return addressOf(entry) || entry.trim();
}

/** The first header of that name (case-insensitive), or null. */
export function header(body: Pick<MessageBody, 'headers'> | null | undefined, name: string): string | null {
  if (body === null || body === undefined) return null;
  const lower = name.toLowerCase();
  return body.headers.find((h) => h.name.toLowerCase() === lower)?.value.trim() ?? null;
}

/** Reconnect delay for the event stream: 1s, 2s, 4s … capped at 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 10)));
}
