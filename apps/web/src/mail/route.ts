// Where the mail view is, as a URL — so a reload, a shared link and the browser's back button all
// land in the same place (PST-REQ-077). Pure, so it is unit-tested.
//
//   /                          the inbox (the shell's home; the path stays '/')
//   /mail                      below tablet width: the mailbox list, the first level of push nav
//   /mail/:mailboxId           a mailbox's messages
//   /mail/:mailboxId/:messageId  one message, open in the reading pane
//   …?compose=new|reply|replyall|forward   the composer (PST-T-3.11 completes it)

export type ComposeMode = 'new' | 'reply' | 'replyall' | 'forward';

export interface MailRoute {
  /** True for '/mail' exactly: the mailbox list below tablet width. */
  mailboxIndex: boolean;
  /** Null means "the inbox" ('/' or '/mail'). */
  mailboxId: string | null;
  messageId: string | null;
  compose: ComposeMode | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES: readonly ComposeMode[] = ['new', 'reply', 'replyall', 'forward'];

export function parseMailRoute(pathname: string, search = ''): MailRoute | null {
  const params = new URLSearchParams(search);
  const rawMode = params.get('compose');
  const compose = MODES.find((m) => m === rawMode) ?? null;
  const parts = pathname.split('/').filter((p) => p !== '');
  if (parts.length === 0) return { mailboxIndex: false, mailboxId: null, messageId: null, compose };
  if (parts[0] !== 'mail' || parts.length > 3) return null;
  const mailboxId = parts[1] ?? null;
  const messageId = parts[2] ?? null;
  if (mailboxId !== null && !UUID.test(mailboxId)) return null;
  if (messageId !== null && !UUID.test(messageId)) return null;
  // A reply needs a message to reply to.
  const effective = compose !== null && compose !== 'new' && messageId === null ? null : compose;
  return { mailboxIndex: parts.length === 1, mailboxId, messageId, compose: effective };
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
