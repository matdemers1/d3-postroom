// Where the mail view is, as a URL — so a reload, a shared link and the browser's back button all
// land in the same place (PST-REQ-077). Pure, so it is unit-tested.
//
//   /                          the inbox (the shell's home; the path stays '/')
//   /mail                      below tablet width: the mailbox list, the first level of push nav
//   /mail/:mailboxId           a mailbox's messages
//   /mail/:mailboxId/:messageId  one message, open in the reading pane
//   …?compose=new|reply|replyall|forward   the composer (PST-T-3.11 completes it)
//   …?compose=new&to=<address>   PST-DA-025: Contacts opens a prefilled composer instead of a
//                                 mailto: link that would leave Postroom; `to` is honoured only
//                                 alongside compose=new, and only when it looks like an address.

export type ComposeMode = 'new' | 'reply' | 'replyall' | 'forward';

export interface MailRoute {
  /** True for '/mail' exactly: the mailbox list below tablet width. */
  mailboxIndex: boolean;
  /** Null means "the inbox" ('/' or '/mail'). */
  mailboxId: string | null;
  messageId: string | null;
  compose: ComposeMode | null;
  /** compose=new's prefilled To, or null (PST-DA-025). Never trusted past isComposeToAddress. */
  composeTo: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES: readonly ComposeMode[] = ['new', 'reply', 'replyall', 'forward'];
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
  if (parts.length === 0) return { mailboxIndex: false, mailboxId: null, messageId: null, compose, composeTo };
  if (parts[0] !== 'mail' || parts.length > 3) return null;
  const mailboxId = parts[1] ?? null;
  const messageId = parts[2] ?? null;
  if (mailboxId !== null && !UUID.test(mailboxId)) return null;
  if (messageId !== null && !UUID.test(messageId)) return null;
  // A reply needs a message to reply to.
  const effective = compose !== null && compose !== 'new' && messageId === null ? null : compose;
  return { mailboxIndex: parts.length === 1, mailboxId, messageId, compose: effective, composeTo: effective === 'new' ? composeTo : null };
}

export function mailPath(mailboxId: string | null, messageId: string | null = null, compose: ComposeMode | null = null): string {
  let path = mailboxId === null ? '/' : `/mail/${mailboxId}`;
  if (mailboxId !== null && messageId !== null) path += `/${messageId}`;
  if (compose !== null) path += `?compose=${compose}`;
  return path;
}

/** The single pane shown below tablet width (push navigation). */
export type NarrowView = 'mailboxes' | 'list' | 'message' | 'compose';

export function narrowView(route: MailRoute): NarrowView {
  if (route.compose !== null) return 'compose';
  if (route.messageId !== null) return 'message';
  if (route.mailboxIndex) return 'mailboxes';
  return 'list';
}
