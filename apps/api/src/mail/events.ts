// GET /api/events — live mailbox updates over server-sent events (PST-REQ-083).
//
// One LISTEN connection per API process (per ApiDeps), on the channel the worker, the IMAP server
// and this API all notify on after changing a mailbox. A notification is only a hint carrying a
// mailbox id: the hub re-reads that mailbox and fans the result out to the connected sessions of
// the account that owns it — and to nobody else. Per connection it remembers the uidnext it has
// already reported, so a new UID becomes exactly one `message.new`, and every change becomes a
// `mailbox.changed` with the fresh counters.
//
// Last-Event-ID resume is best-effort: every (re)connect starts with the current state of each of
// the account's mailboxes, which is all a client needs to refetch what it missed.
import type { Db } from '@postroom/db';
import type { Request, Response } from 'express';
import type { ApiDeps } from '../deps.js';
import { openListener, type ListenClient } from './pg-listen.js';
import type { MailboxChangedJson, MessageNewJson } from './schemas.js';
import { MAILBOX_CHANNEL, mailboxCounts } from './store.js';

export const HEARTBEAT_MS = 25_000;
const RECONNECT_MS = 1_000;
/** A client this far behind is dropped rather than buffered without bound. */
const MAX_BUFFERED = 1024 * 1024;
/** At most this many message.new events per notification (a bulk move sends mailbox.changed too). */
const MAX_NEW_PER_NOTIFY = 200;

function log(event: string, fields: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}

class Connection {
  private seq = 0;
  /** mailboxId → the uidnext already reported to this client. */
  readonly known = new Map<string, number>();
  readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor(
    readonly accountId: string,
    private readonly res: Response,
  ) {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  setReady(): void {
    this.markReady();
  }

  get closed(): boolean {
    return this.res.destroyed || this.res.writableEnded;
  }

  send(event: 'mailbox.changed', data: MailboxChangedJson): void;
  send(event: 'message.new', data: MessageNewJson): void;
  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.seq += 1;
    this.res.write(`id: ${this.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (this.res.writableLength > MAX_BUFFERED) this.res.destroy();
  }

  comment(text: string): void {
    if (!this.closed) this.res.write(`: ${text}\n\n`);
  }
}

export class MailEventHub {
  private readonly conns = new Set<Connection>();
  private listener: ListenClient | null = null;
  private starting: Promise<void> | null = null;
  private retry: NodeJS.Timeout | null = null;
  /** Per-mailbox processing chain, so two notifications for one mailbox never interleave. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly databaseUrl: string,
  ) {}

  get connectionCount(): number {
    return this.conns.size;
  }

  private async ensureListening(): Promise<void> {
    if (this.listener !== null) return;
    this.starting ??= (async () => {
      try {
        let client: ListenClient | null = null;
        client = await openListener(this.databaseUrl, MAILBOX_CHANNEL, {
          notify: (payload) => {
            this.enqueue(payload);
          },
          lost: (error) => {
            if (client !== null && this.listener === client) this.lost(error);
          },
        });
        this.listener = client;
      } finally {
        this.starting = null;
      }
    })();
    await this.starting;
  }

  private lost(error: Error | null): void {
    this.listener = null;
    if (error !== null) log('mail-events-listener-lost', { error: error.message });
    if (this.conns.size === 0 || this.retry !== null) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.conns.size === 0) return;
      this.ensureListening()
        .then(() => {
          // Anything filed while we were deaf: re-read every mailbox a client knows about.
          const ids = new Set<string>();
          for (const c of this.conns) for (const id of c.known.keys()) ids.add(id);
          for (const id of ids) this.enqueue(id);
        })
        .catch((err: unknown) => {
          this.lost(err instanceof Error ? err : new Error(String(err)));
        });
    }, RECONNECT_MS);
  }

  private stop(): void {
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    const client = this.listener;
    this.listener = null;
    if (client !== null) {
      client.end().catch((err: unknown) => {
        log('mail-events-listener-end-failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  /** Registers a client (after the LISTEN is up) and sends it the current state of its mailboxes. */
  async connect(accountId: string, res: Response): Promise<Connection> {
    await this.ensureListening();
    const conn = new Connection(accountId, res);
    this.conns.add(conn);
    try {
      // Registered before the snapshot: a change committed after this point is either in the
      // snapshot or arrives as a notification processed once `ready` resolves.
      const mailboxes = await this.db.mailbox.findMany({ where: { accountId }, orderBy: { name: 'asc' } });
      const counts = await mailboxCounts(
        this.db,
        mailboxes.map((m) => m.id),
      );
      for (const m of mailboxes) {
        conn.known.set(m.id, m.uidnext);
        const c = counts.get(m.id);
        conn.send('mailbox.changed', {
          mailboxId: m.id,
          uidnext: m.uidnext,
          highestModseq: m.highestModseq.toString(),
          unseen: c?.unseen ?? 0,
          total: c?.total ?? 0,
        });
      }
    } finally {
      conn.setReady();
    }
    return conn;
  }

  disconnect(conn: Connection): void {
    this.conns.delete(conn);
    if (this.conns.size === 0) this.stop();
  }

  private enqueue(mailboxId: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(mailboxId)) return;
    const prev = this.chains.get(mailboxId) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(mailboxId))
      .catch((err: unknown) => {
        log('mail-events-process-failed', { mailboxId, error: err instanceof Error ? err.message : String(err) });
      });
    this.chains.set(mailboxId, next);
    void next.finally(() => {
      if (this.chains.get(mailboxId) === next) this.chains.delete(mailboxId);
    });
  }

  private async process(mailboxId: string): Promise<void> {
    const mailbox = await this.db.mailbox.findUnique({ where: { id: mailboxId } });
    if (mailbox === null) return;
    const targets = [...this.conns].filter((c) => c.accountId === mailbox.accountId);
    if (targets.length === 0) return;
    await Promise.all(targets.map((c) => c.ready));

    // A mailbox a client has never seen was created after it connected: all of it is new.
    const from = Math.min(...targets.map((c) => c.known.get(mailboxId) ?? 1));
    const fresh =
      from < mailbox.uidnext
        ? await this.db.message.findMany({
            where: { mailboxId, uid: { gte: from } },
            orderBy: { uid: 'asc' },
            take: MAX_NEW_PER_NOTIFY,
          })
        : [];
    const counts = (await mailboxCounts(this.db, [mailboxId])).get(mailboxId) ?? { total: 0, unseen: 0 };

    for (const conn of targets) {
      const known = conn.known.get(mailboxId) ?? 1;
      for (const m of fresh) {
        if (m.uid < known) continue;
        conn.send('message.new', {
          mailboxId,
          messageId: m.id,
          uid: m.uid,
          subject: m.subject,
          from: m.fromAddress,
          date: (m.sentAt ?? m.internalDate).toISOString(),
        });
      }
      conn.known.set(mailboxId, Math.max(known, mailbox.uidnext));
      conn.send('mailbox.changed', {
        mailboxId,
        uidnext: mailbox.uidnext,
        highestModseq: mailbox.highestModseq.toString(),
        unseen: counts.unseen,
        total: counts.total,
      });
    }
  }
}

const hubs = new WeakMap<ApiDeps, MailEventHub>();

export function hubFor(deps: ApiDeps): MailEventHub | null {
  const existing = hubs.get(deps);
  if (existing !== undefined) return existing;
  const url = deps.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') return null;
  const hub = new MailEventHub(deps.db, url);
  hubs.set(deps, hub);
  return hub;
}

/** The SSE response for one signed-in session. */
export interface StreamOptions {
  heartbeatMs?: number;
  /** Checked on every heartbeat; false ends the stream. */
  stillValid?: () => Promise<boolean>;
}

export async function streamEvents(hub: MailEventHub, accountId: string, req: Request, res: Response, opts: StreamOptions = {}): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  // Tell any buffering proxy (nginx-style) to pass events straight through.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  let conn: Connection | null = null;
  const state = { gone: false };
  const heartbeat = setInterval(() => {
    const check = opts.stillValid ?? (() => Promise.resolve(true));
    check()
      .then((ok) => {
        if (ok) conn?.comment('ping');
        else res.end();
      })
      .catch((err: unknown) => {
        log('mail-events-session-check-failed', { error: err instanceof Error ? err.message : String(err) });
      });
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  req.on('close', () => {
    state.gone = true;
    clearInterval(heartbeat);
    if (conn !== null) hub.disconnect(conn);
  });
  try {
    conn = await hub.connect(accountId, res);
  } catch (error) {
    clearInterval(heartbeat);
    log('mail-events-connect-failed', { error: error instanceof Error ? error.message : String(error) });
    res.end();
    return;
  }
  if (state.gone) hub.disconnect(conn);
}
