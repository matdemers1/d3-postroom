// Gmail-compatible keyboard shortcuts (PST-REQ-084). The map is pure data plus one pure function,
// so the tests pin exactly which key does what, and the ? overlay is generated from the same table
// it describes — it cannot list a shortcut that does nothing.

export type MailAction =
  | 'next'
  | 'prev'
  | 'open'
  | 'back'
  | 'archive'
  | 'delete'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'compose'
  | 'star'
  | 'markUnread'
  | 'search'
  | 'goInbox'
  | 'help';

export interface Shortcut {
  keys: string;
  action: MailAction;
  description: string;
}

/** In the order the overlay lists them. */
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: 'j', action: 'next', description: 'Next message' },
  { keys: 'k', action: 'prev', description: 'Previous message' },
  { keys: 'o or Enter', action: 'open', description: 'Open message' },
  { keys: 'u', action: 'back', description: 'Back to the list' },
  { keys: 'e', action: 'archive', description: 'Archive' },
  { keys: '#', action: 'delete', description: 'Move to Trash' },
  { keys: 'r', action: 'reply', description: 'Reply' },
  { keys: 'a', action: 'replyAll', description: 'Reply all' },
  { keys: 'f', action: 'forward', description: 'Forward' },
  { keys: 'c', action: 'compose', description: 'Compose' },
  { keys: 's', action: 'star', description: 'Star or unstar' },
  { keys: 'Shift + u', action: 'markUnread', description: 'Mark as unread' },
  { keys: '/', action: 'search', description: 'Search mail' },
  { keys: 'g then i', action: 'goInbox', description: 'Go to Inbox' },
  { keys: '?', action: 'help', description: 'Show or hide these shortcuts' },
];

const SINGLE: Readonly<Record<string, MailAction>> = {
  j: 'next',
  k: 'prev',
  o: 'open',
  u: 'back',
  e: 'archive',
  '#': 'delete',
  r: 'reply',
  a: 'replyAll',
  f: 'forward',
  c: 'compose',
  s: 'star',
  U: 'markUnread',
  '/': 'search',
  '?': 'help',
};

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Focus is in a text field, a select or contenteditable: every key is typing. */
  editable: boolean;
  /** Focus is on a control that Enter activates itself (a button, a link). */
  activatable: boolean;
}

export interface KeyResult {
  action: MailAction | null;
  /** The first half of a two-key sequence ('g'), kept until the next key. */
  pending: 'g' | null;
}

/** What a keydown means, given the half-typed sequence before it. */
export function resolveKey(input: KeyInput, pending: 'g' | null): KeyResult {
  if (input.editable || input.ctrlKey || input.metaKey || input.altKey) return { action: null, pending: null };
  if (pending === 'g') {
    return { action: input.key === 'i' ? 'goInbox' : null, pending: null };
  }
  if (input.key === 'g') return { action: null, pending: 'g' };
  if (input.key === 'Enter') return { action: input.activatable ? null : 'open', pending: null };
  return { action: SINGLE[input.key] ?? null, pending: null };
}

/** Classifies the element a key event came from, for resolveKey. */
export function describeTarget(target: EventTarget | null): { editable: boolean; activatable: boolean } {
  if (target === null || typeof (target as { tagName?: unknown }).tagName !== 'string') return { editable: false, activatable: false };
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : '';
  const textInput = tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(type);
  const editable = textInput || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  const role = el.getAttribute('role');
  const activatable = tag === 'button' || tag === 'a' || tag === 'summary' || role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab';
  return { editable, activatable };
}
