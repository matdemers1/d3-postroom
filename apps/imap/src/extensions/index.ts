// IMAP extensions registered with the daemon (PST-T-3.3; PST-REQ-071).
//
// Each is an `ImapExtension` (see ../capabilities.ts): capability names, ENABLE names, and command
// handlers that replace the core's. IDLE takes over its command; CONDSTORE and QRESYNC contribute
// capability and ENABLE names, and the session consults `enabled` for the behaviour they switch on
// (see condstore.ts and qresync.ts for what that is). NAMESPACE, UIDPLUS, SPECIAL-USE, ESEARCH,
// MOVE, LITERAL- and ENABLE itself are core (capabilities.ts).
import type { ImapExtension } from '../capabilities.js';
import { condstoreExtension } from './condstore.js';
import { idleExtension, type IdleOptions } from './idle.js';
import { qresyncExtension } from './qresync.js';

export { CONDSTORE } from './condstore.js';
export { QRESYNC } from './qresync.js';
export { MAILBOX_CHANNEL, NullMailboxNotifier, PgMailboxNotifier, type MailboxNotifier } from './notify.js';

export type ExtensionDeps = IdleOptions;

export function createExtensions(deps: ExtensionDeps): readonly ImapExtension[] {
  return [idleExtension(deps), condstoreExtension, qresyncExtension];
}
