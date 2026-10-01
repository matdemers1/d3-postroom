// Where the mail view is, as a URL — so a reload, a shared link and the browser's back button all
// land in the same place (PST-REQ-077, PST-REQ-198). Pure, so it is unit-tested.
//
//   /                          redirects to /mail/inbox (App.tsx); parsed here as "the inbox"
//   /mail                      below tablet width: the mailbox list, the first level of push nav
//   /mail/:mailbox             a mailbox's messages. PST-T-16.4 (PST-DA-027): a special-use mailbox
//                              or a sorter bucket is named by its slug — /mail/inbox, /mail/sent,
//                              /mail/updates — and only a folder of your own keeps its UUID. An old
//                              UUID URL still parses; MailView replaces it with the slug once the
//                              mailbox list says which mailbox it is.
//   /mail/:mailbox/:messageId  one message, open in the reading pane
//   …?q=<query>                PST-T-16.4: the list is search results for <query>
//   …?view=priority|people     PST-T-16.4: the Inbox's segment (absent: the one this browser last chose)
//   …?panel=inspect            PST-T-16.4: the open message's Inspect drawer is open
//   …?compose=new|reply|replyall|forward   the composer (PST-T-3.11 completes it)
//   /mail/:mailboxId/:draftId?compose=draft  PST-T-14.7: a saved draft, resumed in the composer
//                                 (the reading pane's place) — opened from Drafts
//   …?compose=draft&id=<draftId>  PST-T-14.7: the same, for a new message once it has autosaved —
//                                 the path keeps whatever was open behind it, and a reload resumes it
//   …?compose=new&to=<address>   PST-DA-025: Contacts opens a prefilled composer instead of a
//                                 mailto: link that would leave Postroom; `to` is honoured only
//                                 alongside compose=new, and only when it looks like an address.

import type { Mailbox } from '../api';
import { isInboxSegment, type InboxSegment } from './split';

export type ComposeMode = 'new' | 'reply' | 'replyall' | 'forward';
/** What `?compose=` may say: a mode, or `draft` — resume the draft the path names (PST-T-14.7). */
export type ComposeRouteMode = ComposeMode | 'draft';

export interface MailRoute {
  /** True for '/mail' exactly: the mailbox list below tablet width. */
  mailboxIndex: boolean;
  /** The path's mailbox: a UUID, or a slug (isMailboxSlug) since PST-T-16.4 — resolve it against the
   *  mailbox list with resolveMailbox. Null means "the inbox" ('/' or '/mail'). */
  mailboxId: string | null;
  messageId: string | null;
  compose: ComposeRouteMode | null;
  /** compose=draft's draft: `id` from the query, else the path's message (PST-T-14.7). Absent otherwise. */
  composeDraftId?: string | null;
  /** compose=new's prefilled To, or null (PST-DA-025). Never trusted past isComposeToAddress. */
  composeTo: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES: readonly ComposeRouteMode[] = ['new', 'reply', 'replyall', 'forward', 'draft'];
// A loose, deliberately permissive shape check — not RFC 5322 validation. It exists only to refuse
// obvious garbage in a query string before it reaches the To field; the server validates for real
// on send.
const ADDRESS_LIKE = /^[^\s@"<>,]+@[^\s@"<>,]+\.[^\s@"<>,]+$/;

export function isComposeToAddress(value: string): boolean {
  return ADDRESS_LIKE.test(value);
}

export function parseMailRoute(pathname: string, search = ''): MailRoute | null {
  const params = new URLSearchParams(search);
  const rawMode = params.get('compose');
  const compose = MODES.find((m) => m === rawMode) ?? null;
  const rawTo = params.get('to');
  const composeTo = compose === 'new' && rawTo !== null && isComposeToAddress(rawTo) ? rawTo : null;
  const parts = pathname.split('/').filter((p) => p !== '');
  const rawId = params.get('id');
  const queryDraftId = compose === 'draft' && rawId !== null && UUID.test(rawId) ? rawId : null;
  if (parts.length === 0) {
    const home = compose === 'draft' && queryDraftId === null ? null : compose;
    return { mailboxIndex: false, mailboxId: null, messageId: null, compose: home, composeTo, ...(home === 'draft' ? { composeDraftId: queryDraftId } : {}) };
  }
  if (parts[0] !== 'mail' || parts.length > 3) return null;
  const mailboxId = parts[1] ?? null;
  const messageId = parts[2] ?? null;
  if (mailboxId !== null && !UUID.test(mailboxId) && !isMailboxSlug(mailboxId)) return null;
  if (messageId !== null && !UUID.test(messageId)) return null;
  // A reply needs a message to reply to; resuming a draft needs the draft.
  const draftId = compose === 'draft' ? (queryDraftId ?? messageId) : null;
  const effective = compose === 'draft' ? (draftId === null ? null : 'draft') : compose !== null && compose !== 'new' && messageId === null ? null : compose;
  return {
    mailboxIndex: parts.length === 1,
    mailboxId,
    messageId,
    compose: effective,
    composeTo: effective === 'new' ? composeTo : null,
    ...(effective === 'draft' ? { composeDraftId: draftId } : {}),
  };
}

/** `mailboxId` is the path's mailbox — a UUID or a slug (mailboxKey gives the canonical one). */
export function mailPath(mailboxId: string | null, messageId: string | null = null, compose: ComposeRouteMode | null = null): string {
  let path = mailboxId === null ? '/' : `/mail/${mailboxId}`;
  if (mailboxId !== null && messageId !== null) path += `/${messageId}`;
  if (compose !== null) path += `?compose=${compose}`;
  return path;
}

/**
 * Where a draft being written lives, as a URL (PST-T-14.7). Opened from Drafts, the draft is the
 * path's message; otherwise (a new message that has autosaved) the path keeps what was open behind
 * the composer and the draft rides in `id`.
 */
export function draftPath(route: Pick<MailRoute, 'mailboxId' | 'messageId' | 'composeDraftId'>, draftId: string): string {
  const inPath = route.messageId !== null && route.messageId === (route.composeDraftId ?? null);
  if (inPath) return mailPath(route.mailboxId, draftId, 'draft');
  return `${mailPath(route.mailboxId, route.messageId)}?compose=draft&id=${draftId}`;
}

// --- Mailbox slugs (PST-T-16.4, PST-REQ-198, design finding PST-DA-027) ------------------------------
//
// Every special-use mailbox and every sorter bucket (PST-ADR-004: real IMAP folders) has a readable
// path segment. A folder you made yourself has no slug and keeps its UUID. Resolving a slug needs the
// mailbox list (the special-use flags and the bucket folders' names), so these take it as an argument.

const SPECIAL_SLUGS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk', 'rejects'] as const;
/** The sorter's bucket folders (packages/classifier BUCKET_FOLDERS, sidebar.ts SORTED_FOLDERS). */
const BUCKET_FOLDERS = { updates: 'Updates', receipts: 'Receipts', notifications: 'Notifications', newsletters: 'Newsletters' } as const;

export type MailboxSlug = (typeof SPECIAL_SLUGS)[number] | keyof typeof BUCKET_FOLDERS;

export const MAILBOX_SLUGS: readonly MailboxSlug[] = [...SPECIAL_SLUGS, ...(Object.keys(BUCKET_FOLDERS) as (keyof typeof BUCKET_FOLDERS)[])];

type MailboxLike = Pick<Mailbox, 'id' | 'name' | 'specialUse'>;

export function isMailboxSlug(value: string): value is MailboxSlug {
  return (MAILBOX_SLUGS as readonly string[]).includes(value);
}

/** A mailbox's slug: its special use, "inbox" for INBOX, a bucket folder's lower-cased name, else null. */
export function mailboxSlug(mailbox: Pick<Mailbox, 'name' | 'specialUse'>): MailboxSlug | null {
  if (mailbox.specialUse !== null) return mailbox.specialUse;
  if (mailbox.name.toUpperCase() === 'INBOX') return 'inbox';
  for (const [slug, name] of Object.entries(BUCKET_FOLDERS) as [keyof typeof BUCKET_FOLDERS, string][]) if (mailbox.name === name) return slug;
  return null;
}

/** The mailbox a path segment names — a UUID or a slug — or null when there is none (yet). */
export function resolveMailbox<M extends MailboxLike>(key: string | null, mailboxes: readonly M[] | null): M | null {
  if (key === null || mailboxes === null) return null;
  if (UUID.test(key)) return mailboxes.find((m) => m.id.toLowerCase() === key.toLowerCase()) ?? null;
  if (!isMailboxSlug(key)) return null;
  // The flag first (as findSpecial does), then the name — so one slug always names one mailbox.
  return mailboxes.find((m) => m.specialUse === key) ?? mailboxes.find((m) => mailboxSlug(m) === key) ?? null;
}

/**
 * A mailbox's canonical path segment: its slug, when that slug resolves back to this very mailbox;
 * otherwise its UUID. Pass the list whenever there is one, so two folders that would share a slug
 * never both claim it.
 */
export function mailboxKey(mailbox: MailboxLike, mailboxes: readonly MailboxLike[] | null = null): string {
  const slug = mailboxSlug(mailbox);
  if (slug === null) return mailbox.id;
  if (mailboxes !== null && resolveMailbox(slug, mailboxes)?.id !== mailbox.id) return mailbox.id;
  return slug;
}

/** The mailbox a route shows: the path's, or the inbox for '/' — none for the '/mail' index. */
export function routeMailbox<M extends MailboxLike>(route: Pick<MailRoute, 'mailboxId' | 'mailboxIndex'>, mailboxes: readonly M[] | null): M | null {
  if (route.mailboxId !== null) return resolveMailbox(route.mailboxId, mailboxes);
  return route.mailboxIndex ? null : resolveMailbox('inbox', mailboxes);
}

/**
 * Where a mail URL should be, once the mailbox list is known — or null when it already is. A UUID
 * that names a slugged mailbox becomes its slug (the message, the composer and the query all kept);
 * a slug this account has no mailbox for goes to the Inbox. A folder of your own, an unknown UUID
 * and '/mail' are left alone ('/' is App.tsx's redirect, which needs no list).
 */
export function canonicalMailPath(pathname: string, search: string, mailboxes: readonly MailboxLike[] | null): string | null {
  const route = parseMailRoute(pathname, search);
  if (route === null || route.mailboxId === null || mailboxes === null) return null;
  const query = search === '' || search === '?' ? '' : search.startsWith('?') ? search : `?${search}`;
  const mailbox = resolveMailbox(route.mailboxId, mailboxes);
  if (mailbox === null) return isMailboxSlug(route.mailboxId) && route.mailboxId !== 'inbox' ? '/mail/inbox' : null;
  const key = mailboxKey(mailbox, mailboxes);
  if (key === route.mailboxId) return null;
  return `/mail/${key}${route.messageId === null ? '' : `/${route.messageId}`}${query}`;
}

// --- The list's own state, in the query (PST-T-16.4, PST-REQ-198, PST-DA-052) -------------------------

/** The side panel open over the reading pane; only Inspect, so far. */
export type MailPanel = 'inspect';

export interface MailListState {
  /** The search the list shows, or null for the mailbox itself. */
  q: string | null;
  /** The Inbox segment the URL names, or null: the one this browser last chose (sorting.ts). */
  view: InboxSegment | null;
  panel: MailPanel | null;
}

export function parseMailListState(search: string): MailListState {
  const params = new URLSearchParams(search);
  const q = params.get('q')?.trim() ?? '';
  const view = params.get('view');
  return {
    q: q === '' ? null : q,
    view: view !== null && isInboxSegment(view) ? view : null,
    panel: params.get('panel') === 'inspect' ? 'inspect' : null,
  };
}

/**
 * `path` (which may already carry ?compose= and its friends) with the list state set: each key given
 * is written, or removed when null; a key not given is left as the path had it.
 */
export function withListState(path: string, state: Partial<MailListState>): string {
  const at = path.indexOf('?');
  const pathname = at < 0 ? path : path.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : path.slice(at + 1));
  for (const key of ['q', 'view', 'panel'] as const) {
    if (!(key in state)) continue;
    const value = state[key];
    if (value === null || value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
}

/** The single pane shown below tablet width (push navigation). */
export type NarrowView = 'mailboxes' | 'list' | 'message' | 'compose';

/** The composer takes the reading pane's place (new, resumed draft) rather than opening inline under
 *  the thread it answers (reply, reply all, forward) — PST-T-14.7, design audit TF-08. */
export function composesInPane(mode: ComposeRouteMode | null): boolean {
  return mode === 'new' || mode === 'draft';
}

export function narrowView(route: MailRoute): NarrowView {
  if (route.compose !== null) return 'compose';
  if (route.messageId !== null) return 'message';
  if (route.mailboxIndex) return 'mailboxes';
  return 'list';
}
