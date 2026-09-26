// Mailbox change notifications for IDLE (PST-REQ-073).
//
// One LISTEN connection per daemon process, on the channel every writer notifies on after it
// changes a mailbox (the worker, the API, and this daemon's own store): pg_notify('postroom_mailbox',
// <mailbox id>). A notification is only a hint; the sessions idling on that mailbox re-read their
// view (MailboxView.sync), so a duplicate costs a query and nothing else.
//
// A notification sent while the LISTEN connection is down is lost for good. So every time the
// connection comes (back) up, every subscriber is woken as if its mailbox had changed: a full
// resync, which never misses an update. The first connect counts too — a session that subscribed
// before the LISTEN was up is resynced once it is. Reconnects back off from 100 ms to 5 s.
import pg from 'pg';

export const MAILBOX_CHANNEL = 'postroom_mailbox';

export type NotifyLog = (event: string, fields?: Record<string, unknown>) => void;

export interface MailboxNotifier {
  /** Call `onChange` whenever the mailbox may have changed; returns the unsubscribe function. */
  subscribe(mailboxId: string, onChange: () => void): () => void;
  close(): Promise<void>;
}

/** The part of pg.Client the notifier uses (a seam for tests). */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (msg: { channel: string; payload?: string | undefined }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

export interface PgNotifierOptions {
  readonly connectionString: string;
  readonly log?: NotifyLog;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly createClient?: (connectionString: string) => ListenClient;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultClient = (connectionString: string): ListenClient => new pg.Client({ connectionString });

export class PgMailboxNotifier implements MailboxNotifier {
  private readonly subscribers = new Map<string, Set<() => void>>();
  private client: ListenClient | null = null;
  /** Bumped on every (re)connect attempt, so events from a dead client are ignored. */
  private generation = 0;
  private started = false;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private backoff: number;
  private readonly log: NotifyLog;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly createClient: (connectionString: string) => ListenClient;
  /** Successful LISTENs so far (observable for tests and /health). */
  connects = 0;

  constructor(private readonly o: PgNotifierOptions) {
    this.log = o.log ?? (() => undefined);
    this.minBackoff = o.minBackoffMs ?? 100;
    this.maxBackoff = o.maxBackoffMs ?? 5_000;
    this.backoff = this.minBackoff;
    this.createClient = o.createClient ?? defaultClient;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  subscribe(mailboxId: string, onChange: () => void): () => void {
    let set = this.subscribers.get(mailboxId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(mailboxId, set);
    }
    set.add(onChange);
    if (!this.started) {
      this.started = true;
      void this.connect();
    }
    return () => {
      const s = this.subscribers.get(mailboxId);
      if (s === undefined) return;
      s.delete(onChange);
      if (s.size === 0) this.subscribers.delete(mailboxId);
    };
  }

  /** Start listening now rather than at the first subscription. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    const c = this.client;
    this.client = null;
    if (c !== null) {
      await c.end().catch((err: unknown) => {
        this.log('listen-close-error', { error: errorText(err) });
      });
    }
  }

  private wake(mailboxId: string): void {
    for (const fn of this.subscribers.get(mailboxId) ?? []) fn();
  }

  private wakeAll(): void {
    for (const set of this.subscribers.values()) for (const fn of set) fn();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const gen = ++this.generation;
    const client = this.createClient(this.o.connectionString);
    const lost = (error: Error | null): void => {
      if (gen !== this.generation || this.closed) return;
      this.generation++;
      this.client = null;
      this.log('listen-lost', { error: error === null ? 'connection ended' : error.message, retryMs: this.backoff });
      client.end().catch((err: unknown) => {
        this.log('listen-close-error', { error: errorText(err) });
      });
      this.scheduleReconnect();
    };
    client.on('notification', (msg) => {
      if (gen !== this.generation) return;
      if (msg.channel === MAILBOX_CHANNEL && msg.payload !== undefined) this.wake(msg.payload);
    });
    client.on('error', (err) => {
      lost(err);
    });
    client.on('end', () => {
      lost(null);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${MAILBOX_CHANNEL}`);
    } catch (err) {
      lost(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.superseded(gen)) {
      await client.end().catch((err: unknown) => {
        this.log('listen-close-error', { error: errorText(err) });
      });
      return;
    }
    this.client = client;
    this.backoff = this.minBackoff;
    this.connects++;
    if (this.connects > 1) this.log('listen-reconnected', { connects: this.connects });
    // Anything notified while we were not listening is gone: resync everyone.
    this.wakeAll();
  }

  /** Closed, or a newer connect started, while this one was awaiting. */
  private superseded(gen: number): boolean {
    return gen !== this.generation || this.closed;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retry !== null) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.maxBackoff, this.backoff * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
    this.retry.unref();
  }
}

/** No LISTEN connection (no database URL): IDLE falls back to polling. */
export class NullMailboxNotifier implements MailboxNotifier {
  subscribe(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
