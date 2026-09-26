// IDLE (RFC 2177; PST-REQ-071, PST-REQ-073).
//
// "+ idling", then the session waits for DONE while changes are pushed: the session subscribes to
// its selected mailbox on the daemon's one LISTEN connection (notify.ts), and every notification
// runs the same MailboxView.sync a NOOP would — EXISTS, EXPUNGE (or VANISHED under QRESYNC) and
// FETCH FLAGS (with MODSEQ under CONDSTORE) go out as they happen. Syncs are serialised and
// coalesced: a burst of notifications while one sync runs becomes one more sync, not a queue.
//
// Nothing is missed between the last command's sync and the subscription: a sync runs as soon as
// "+ idling" is out. A slow safety poll runs too, in case a writer somewhere forgot to notify.
//
// RFC 2177 lets the server end an IDLE that has run too long; after 29 minutes without DONE (under
// the 30-minute autologout of RFC 9051 §5.4) the read times out and the session says BYE. Clients
// re-issue IDLE well before that.
import { continuationResponse, isIdleDone } from '@postroom/imap-proto';
import type { CommandOutcome, ExtensionSession, ImapExtension } from '../capabilities.js';
import type { MailboxNotifier, NotifyLog } from './notify.js';

export const DEFAULT_MAX_IDLE_MS = 29 * 60_000;

export interface IdleOptions {
  readonly notifier: MailboxNotifier;
  /** DONE must arrive within this long (default 29 minutes). */
  readonly maxIdleMs?: number;
  /** A sync this often regardless of notifications (default 60 s with a notifier). */
  readonly pollIntervalMs?: number;
  readonly log?: NotifyLog;
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export async function runIdle(session: ExtensionSession, o: IdleOptions): Promise<CommandOutcome> {
  if (session.accountId === null) return { status: 'BAD', text: 'Authenticate first' };
  const log = o.log ?? (() => undefined);
  const mailboxId = session.selectedMailboxId;

  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<null>((resolve) => {
    resolveEnded = () => {
      resolve(null);
    };
  });
  // A function, not the property: it changes while we await.
  const isClosed = (): boolean => session.closed;
  let chain: Promise<void> = Promise.resolve();
  let queued = false;
  const wake = (): void => {
    if (queued) return;
    queued = true;
    chain = chain.then(async () => {
      queued = false;
      if (isClosed()) return;
      try {
        await session.syncSelected(true);
      } catch (err) {
        // The next notification (or the poll) retries; the client still has a consistent view.
        log('idle-sync-error', { error: errorText(err) });
      }
      // The mailbox was deleted (BYE sent) or the connection went: stop waiting for DONE.
      if (isClosed()) resolveEnded();
    });
  };

  const unsubscribe = mailboxId === null ? null : o.notifier.subscribe(mailboxId, wake);
  const poll = mailboxId === null ? null : setInterval(wake, o.pollIntervalMs ?? 60_000);
  poll?.unref();
  let line: Buffer | null;
  try {
    await session.write(continuationResponse('idling'));
    if (mailboxId !== null) wake();
    const read = session.readRawLine(o.maxIdleMs ?? DEFAULT_MAX_IDLE_MS);
    line = await Promise.race([read, ended]);
    if (line === null && isClosed()) {
      // The read is abandoned with the connection; a later timeout from it is expected.
      read.catch((err: unknown) => {
        log('idle-read-after-close', { error: errorText(err) });
      });
    }
  } finally {
    unsubscribe?.();
    if (poll !== null) clearInterval(poll);
    await chain;
  }
  if (line === null) {
    session.close();
    return { status: 'BAD', text: 'Connection closed during IDLE' };
  }
  if (!isIdleDone(line)) return { status: 'BAD', text: 'Expected DONE' };
  return { status: 'OK', text: 'IDLE terminated' };
}

export function idleExtension(o: IdleOptions): ImapExtension {
  return {
    name: 'IDLE',
    capabilities: (s) => (s.authenticated ? ['IDLE'] : []),
    commands: {
      IDLE: (_cmd, session) => runIdle(session, o),
    },
  };
}
