// PST-T-16.9: a rule's destination is ONE picker of real places — the mailboxes that exist, and the
// "Sorted for you" buckets — grouped like the sidebar (mail, Sorted for you, then your own folders).
// It replaces a free-text Folder field and a separate "Sort into bucket" action. The two kinds of
// choice still compile exactly as they always did: a folder is `fileinto :create "<name>"`, a bucket
// is `bucket "<key>"` (PST-ADR-004 keeps the two distinct). Pure, so it is unit-tested.
import type { SelectOption } from '@d3cloud/ui';
import type { Mailbox, SpecialUse } from '../../api';
import { findSpecial } from '../../mail/format';
import { SORTED_FOLDERS } from '../../mail/sidebar';

/** Every bucket the interpreter accepts, so a rule saved against any of them still loads and saves. */
export const BUCKETS: { value: string; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'people', label: 'People' },
  { value: 'newsletters', label: 'Newsletters' },
  { value: 'updates', label: 'Updates' },
  { value: 'receipts', label: 'Receipts' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'junk', label: 'Junk' },
];

/** The part of a rule the picker reads and writes. */
export interface Destination {
  action: string;
  target: string;
}

/** Mailboxes a rule may move mail to, in sidebar order. Sent, Drafts and Rejects are never a destination. */
const MAIL_GROUP: readonly { use: SpecialUse; label: string }[] = [
  { use: 'inbox', label: 'Inbox' },
  { use: 'archive', label: 'Archive' },
  { use: 'junk', label: 'Junk' },
  { use: 'trash', label: 'Trash' },
];

const FOLDER = 'folder:';
const BUCKET = 'bucket:';
const GROUP = 'group:';

export const isGroupHeader = (value: string): boolean => value.startsWith(GROUP);

/** The picker's value for a rule: '' when nothing is chosen yet (or the action has no destination). */
export function destinationValue(rule: Destination): string {
  if (rule.target === '') return '';
  if (rule.action === 'move') return `${FOLDER}${rule.target}`;
  if (rule.action === 'bucket') return `${BUCKET}${rule.target}`;
  return '';
}

/** The rule after a choice: a folder is a `move`, a bucket is a `bucket`. Headers choose nothing. */
export function applyDestination<T extends Destination>(rule: T, value: string): T {
  if (value.startsWith(FOLDER)) return { ...rule, action: 'move', target: value.slice(FOLDER.length) };
  if (value.startsWith(BUCKET)) return { ...rule, action: 'bucket', target: value.slice(BUCKET.length) };
  return rule;
}

const header = (id: string, label: string): SelectOption => ({ value: `${GROUP}${id}`, label, disabled: true });

/**
 * The options, grouped by disabled headings (the library Select has no option groups). `mailboxes`
 * is null until the list loads; a saved destination that the list does not contain is kept as its
 * own option so opening a rule never silently changes it.
 */
export function destinationOptions(mailboxes: readonly Mailbox[] | null, rule: Destination): SelectOption[] {
  const known = mailboxes ?? [];
  const mail = MAIL_GROUP.flatMap(({ use, label }) => {
    const m = findSpecial(known, use);
    return m === undefined ? [] : [{ value: `${FOLDER}${m.name}`, label }];
  });
  const own = known
    .filter((m) => m.specialUse === null && !(SORTED_FOLDERS as readonly string[]).includes(m.name))
    .map((m) => ({ value: `${FOLDER}${m.name}`, label: m.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const sorted = SORTED_FOLDERS.map((name) => ({ value: `${BUCKET}${name.toLowerCase()}`, label: name }));

  const options: SelectOption[] = [];
  if (mail.length > 0) options.push(header('mail', 'Mailboxes'), ...mail);
  options.push(header('sorted', 'Sorted for you'), ...sorted);
  if (own.length > 0) options.push(header('own', 'Your folders'), ...own);

  const current = destinationValue(rule);
  if (current !== '' && !options.some((o) => o.value === current)) {
    options.push(header('saved', 'Saved in this rule'), { value: current, label: savedLabel(rule, mailboxes) });
  }
  return options;
}

function savedLabel(rule: Destination, mailboxes: readonly Mailbox[] | null): string {
  if (rule.action === 'bucket') {
    const bucket = BUCKETS.find((b) => b.value === rule.target);
    return bucket === undefined ? `${rule.target} (missing)` : `${bucket.label} bucket`;
  }
  if (mailboxes === null) return rule.target;
  const exists = mailboxes.some((m) => m.name === rule.target);
  if (!exists) return `${rule.target} (missing)`;
  return (SORTED_FOLDERS as readonly string[]).includes(rule.target) ? `${rule.target} (folder only)` : rule.target;
}
