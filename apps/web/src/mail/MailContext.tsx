// The signed-in mail state the shell and the mail view share: the mailboxes with their counts, and
// the live event stream (PST-REQ-083). One EventSource per tab, reconnected with backoff; listeners
// subscribe to it rather than opening their own.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, EVENTS_URL, type Mailbox, type MailboxChangedEvent, type MessageNewEvent } from '../api';
import { backoffMs } from './format';

export type MailEvent = { type: 'mailbox.changed'; data: MailboxChangedEvent } | { type: 'message.new'; data: MessageNewEvent } | { type: 'reconnected' };

export interface MailContextValue {
  mailboxes: Mailbox[] | null;
  mailboxesFailed: boolean;
  /** The signed-in account's address, for reply-all. */
  me: string | null;
  refreshMailboxes: () => Promise<void>;
  subscribe: (listener: (event: MailEvent) => void) => () => void;
  /** True while the event stream is connected. */
  live: boolean;
}

const MailContext = createContext<MailContextValue | null>(null);

export function useMail(): MailContextValue {
  const value = useContext(MailContext);
  if (value === null) throw new Error('useMail() outside a MailProvider');
  return value;
}

/** For the shell, which renders on screens without mail too. */
export function useOptionalMail(): MailContextValue | null {
  return useContext(MailContext);
}

function parse(raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function MailProvider({ me, children }: { me: string | null; children: ReactNode }) {
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [live, setLive] = useState(false);
  const listeners = useRef(new Set<(event: MailEvent) => void>());

  const refreshMailboxes = useCallback(async () => {
    try {
      setMailboxes((await api.mailboxes()).mailboxes);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refreshMailboxes();
  }, [refreshMailboxes]);

  const emit = useCallback((event: MailEvent) => {
    for (const l of listeners.current) l(event);
  }, []);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let everOpened = false;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      source = new EventSource(EVENTS_URL, { withCredentials: true });
      source.addEventListener('open', () => {
        setLive(true);
        // After a gap, anything could have changed: refetch what the stream would have told us.
        if (everOpened || attempt > 0) {
          void refreshMailboxes();
          emit({ type: 'reconnected' });
        }
        everOpened = true;
        attempt = 0;
      });
      source.addEventListener('mailbox.changed', (e) => {
        const data = parse(e.data) as MailboxChangedEvent | null;
        if (data === null) return;
        setMailboxes((current) =>
          current === null
            ? current
            : current.map((m) =>
                m.id === data.mailboxId ? { ...m, uidnext: data.uidnext, highestModseq: data.highestModseq, unseen: data.unseen, total: data.total } : m,
              ),
        );
        emit({ type: 'mailbox.changed', data });
      });
      source.addEventListener('message.new', (e) => {
        const data = parse(e.data) as MessageNewEvent | null;
        if (data !== null) emit({ type: 'message.new', data });
      });
      source.addEventListener('error', () => {
        setLive(false);
        // The browser retries a dropped stream itself; a refused one (401, 503) is CLOSED for good,
        // so that one is ours to retry — later each time.
        if (source !== null && source.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          timer = setTimeout(connect, backoffMs(attempt));
          attempt += 1;
        }
      });
    };
    connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      source?.close();
    };
  }, [emit, refreshMailboxes]);

  const subscribe = useCallback((listener: (event: MailEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<MailContextValue>(
    () => ({ mailboxes, mailboxesFailed: failed, me, refreshMailboxes, subscribe, live }),
    [mailboxes, failed, me, refreshMailboxes, subscribe, live],
  );
  return <MailContext.Provider value={value}>{children}</MailContext.Provider>;
}
