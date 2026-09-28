// The smtp-in listener: PROXY v2 from the edge peer only (PST-REQ-016), a per-network connection
// rate and a per-IP connection cap, and one smtp-proto session per connection with Postroom's
// inbound policy as its hooks.
//
// Policy, in order: a /24 (/64) over its connection rate or unknown-recipient limit is 421 at
// connect (PST-REQ-185, ratelimit.ts); EHLO/HELO required (the engine); a DNSBL-listed client is
// 554 at MAIL FROM, waiting a bounded time for the lookup that started at connect; SPF evaluated at
// MAIL FROM and recorded, never rejected on here (DMARC decides in PST-T-2.6); every RCPT resolved
// against the domains and addresses we serve — anything else is 550 and nothing relays
// (PST-REQ-052/053/068), and an unknown user counts toward the /24's unknown-recipient limit; DATA
// streams through the DKIM verifier into data.ts with the verdicts and a Received header
// (PST-REQ-055/069).
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createDkimVerifierStream,
  evaluateSpf,
  type DkimDns,
  type EvaluateSpfResult,
  type SpfDns,
} from '@postroom/auth-checks';
import type { Db } from '@postroom/db';
import { isTrustedProxyPeer, readProxyHeader } from '@postroom/proxy-protocol';
import {
  createServerSession,
  formatForwardPath,
  formatMailbox,
  formatReply,
  reply,
  Replies,
  tlsUpgrader,
  type ForwardPath,
  type MailParams,
  type ReversePath,
  type ServerHooks,
  type ServerSession,
  type SessionContext,
  type SmtpReply,
} from '@postroom/smtp-proto';
import {
  acceptMessage as defaultAcceptMessage,
  createAcceptMessage,
  type AcceptMessage,
  type InboundRecipient,
  type InboundStorage,
} from './data.js';
import { replyText, type DnsblVerdict } from './decide.js';
import { checkGreylist, isPrivateClient, isSoftListed, type GreylistInput, type GreylistVerdict } from './greylist.js';
import { buildReceived, receivedProtocol } from './headers.js';
import { InboundRateLimits, RATE_LIMIT_DEFAULTS, type RateLimitOptions, type RateLimitRefusal } from './ratelimit.js';
import { canonicalIp, type ReverseLookup } from './rdns.js';
import { prismaRecipientStore, resolveRecipient, RecipientReplies, type RecipientStore } from './recipients.js';
import { attachTranscriptTap, TranscriptRecorder } from './transcript.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface SmtpInOptions {
  /** Recipient lookups; pass `db` (Prisma) or a store. */
  readonly db: Db;
  readonly recipientStore?: RecipientStore;
  readonly hostname: string;
  readonly maxSize: number;
  readonly edgePeers: readonly string[];
  readonly proxyTimeoutMs: number;
  readonly maxConnectionsPerIp: number;
  readonly maxRecipientsPerMessage: number;
  readonly maxRecipientsPerSession: number;
  readonly maxErrors: number;
  readonly idleTimeoutMs: number;
  /** Enables opportunistic STARTTLS (RFC 3207: never required on an MX). */
  readonly tls?: { readonly key: Buffer | string; readonly cert: Buffer | string } | undefined;
  readonly spfDns: SpfDns;
  readonly dkimDns: DkimDns;
  readonly reverseLookup: ReverseLookup;
  /** The client IP's DNSBL verdict (PST-REQ-058), looked up once per session at connect, like
   * `reverseLookup`. Without it, `verdicts.dnsbl` is undefined and decide.ts never rejects on it. */
  readonly dnsblLookup?: (ip: string) => Promise<DnsblVerdict>;
  /** How long MAIL FROM waits for that lookup (default 3 s). A listed client is 554 at MAIL FROM;
   * a lookup still pending after the wait lets the transaction on, and end of DATA decides. */
  readonly dnsblWaitMs?: number;
  /** PST-REQ-185 limits; each field defaults to RATE_LIMIT_DEFAULTS (30/min, 20 unknown per 10 min). */
  readonly rateLimits?: Partial<RateLimitOptions>;
  readonly acceptMessage?: AcceptMessage;
  /** Durable storage for DATA (PST-T-2.6). Without it (and without `acceptMessage`) DATA is 451. */
  readonly storage?: InboundStorage;
  readonly greylist?: (input: GreylistInput) => Promise<GreylistVerdict>;
  readonly log: Log;
  readonly now?: () => Date;
}

export interface SmtpInServer {
  readonly server: Server;
  listen(port: number, host: string): Promise<AddressInfo>;
  /** Stop accepting, send 421 to every open session, and wait for the listener to close. */
  close(): Promise<void>;
  /** Open sessions, for /health. */
  activeSessions(): number;
  /** Networks the rate limiter is tracking, for /health (bounded; see ratelimit.ts). */
  rateLimitTracked(): { connections: number; unknownRecipients: number };
}

/** A PROXY v2 or v1 header at the start of a stream from someone who is not the edge. */
export function looksLikeProxyHeader(chunk: Buffer): boolean {
  const v2 = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00]);
  if (chunk.length >= v2.length && chunk.subarray(0, v2.length).equals(v2)) return true;
  return chunk.length >= 6 && chunk.subarray(0, 6).toString('latin1') === 'PROXY ';
}

/**
 * Close a non-peer connection whose first bytes are a PROXY header (PST-REQ-016). The listener is
 * prepended, so it sees the first chunk before the session engine does, and puts it back untouched
 * when it is not a PROXY header.
 */
function refuseStrayProxyHeader(socket: Socket, onRefused: () => void): void {
  const inspect = (): void => {
    const chunk = socket.read() as Buffer | null;
    if (chunk === null) return;
    socket.off('readable', inspect);
    if (looksLikeProxyHeader(chunk)) {
      onRefused();
      socket.destroy();
      return;
    }
    socket.unshift(chunk);
  };
  socket.prependListener('readable', inspect);
  socket.once('close', () => socket.off('readable', inspect));
}

interface RcptLog {
  readonly to: string;
  readonly code: number;
  readonly enhanced?: string;
  readonly outcome: string;
}

interface TransactionState {
  readonly id: string;
  readonly mailFrom: string | null;
  readonly params: MailParams;
  readonly spf: EvaluateSpfResult;
  readonly recipients: InboundRecipient[];
  readonly log: TransactionLog;
}

interface TransactionLog {
  id: string;
  from: string;
  spf: string;
  rcpts: RcptLog[];
  data?: { code: number; enhanced?: string };
  /** MAIL FROM was refused (the DNSBL at MAIL FROM); no transaction was opened. */
  refused?: { code: number; enhanced?: string; reason: string };
}

const DEFAULT_DNSBL_WAIT_MS = 3_000;

/** The 421 for a network over a PST-REQ-185 limit. */
export function rateLimitReply(hostname: string, refusal: RateLimitRefusal): SmtpReply {
  const what = refusal.limit === 'connection-rate' ? 'Too many connections from your network' : 'Too many unknown recipients from your network';
  return reply(421, '4.7.0', `${hostname} ${what}, try again later`);
}

function mailFromText(from: ReversePath): string | null {
  return from.kind === 'null' ? null : formatMailbox(from.mailbox);
}

function rcptText(to: ForwardPath): string {
  return formatForwardPath(to).slice(1, -1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-connection state and the hooks the session engine calls. */
class InboundConnection {
  session: ServerSession | null = null;
  /** Set right after the session is created (PST-T-6.3); referenced lazily by `hooks()`'s closures. */
  recorder: TranscriptRecorder | null = null;
  private rdns: Promise<string | null> = Promise.resolve(null);
  private dnsbl: Promise<DnsblVerdict | undefined> = Promise.resolve(undefined);
  private tx: TransactionState | null = null;
  private sessionRcpts = 0;
  readonly transactions: TransactionLog[] = [];
  readonly errors: string[] = [];
  /** Why this session was cut off by a rate limit, for the session log line. */
  rateLimited: RateLimitRefusal | null = null;

  constructor(
    private readonly opts: SmtpInOptions,
    private readonly store: RecipientStore,
    readonly clientIp: string,
    readonly clientPort: number | undefined,
    private readonly proxied: boolean,
    private readonly acceptor: AcceptMessage,
    private readonly limits: InboundRateLimits,
    private readonly socketClosed: Promise<void>,
    private readonly destroySocket: () => void,
  ) {}

  /** The connect-time DNSBL verdict, waiting at most `dnsblWaitMs` for it. */
  private async dnsblWithin(): Promise<DnsblVerdict | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const pending = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => { resolve(undefined); }, this.opts.dnsblWaitMs ?? DEFAULT_DNSBL_WAIT_MS);
    });
    try {
      return await Promise.race([this.dnsbl, pending]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Answer with `r` and end the session (PST-REQ-185). The engine has no "reply and close" return
   * for RCPT, so the session is closed from here — `close()` queues `r` behind any replies still
   * waiting to go out, flushes, and ends the socket — and this hook resolves only once the socket
   * is gone, so the engine never reads another pipelined command. What the engine then queues is
   * dropped with the closed socket. A peer that will not read is destroyed after a bound.
   */
  private async disconnect(r: SmtpReply): Promise<SmtpReply> {
    this.session?.close(r);
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.destroySocket();
        resolve();
      }, 10_000);
    });
    try {
      await Promise.race([this.socketClosed, bound]);
    } finally {
      clearTimeout(timer);
    }
    return r;
  }

  hooks(): ServerHooks {
    const hooks: ServerHooks = {
      onConnect: () => {
        this.rdns = this.opts.reverseLookup(this.clientIp).catch((err: unknown) => {
          this.errors.push(`rdns: ${errorMessage(err)}`);
          return null;
        });
        this.dnsbl = this.opts.dnsblLookup
          ? this.opts.dnsblLookup(this.clientIp).catch((err: unknown) => {
              this.errors.push(`dnsbl: ${errorMessage(err)}`);
              return undefined;
            })
          : Promise.resolve(undefined);
        return undefined;
      },
      onMail: (from, params, ctx) => this.onMail(from, params, ctx),
      onRcpt: (to, _params, ctx) => this.onRcpt(to, ctx),
      onData: (body, ctx) => this.onData(body, ctx),
      onError: (err) => {
        this.errors.push(errorMessage(err));
      },
    };
    if (this.opts.tls) {
      const upgrade = tlsUpgrader({ key: this.opts.tls.key, cert: this.opts.tls.cert });
      return {
        ...hooks,
        upgradeTls: async (socket) => {
          const secured = await upgrade(socket);
          // The tap was on the plaintext socket; STARTTLS hands the engine a new Duplex, which needs
          // its own tap (PST-T-6.3) — the plaintext one is discarded along with `socket`.
          if (this.recorder) attachTranscriptTap(secured, this.recorder);
          return secured;
        },
      };
    }
    return hooks;
  }

  private async onMail(from: ReversePath, params: MailParams, ctx: Readonly<SessionContext>): Promise<SmtpReply | undefined> {
    const mailFrom = mailFromText(from);
    // The lookup started at connect; by MAIL FROM it has normally finished. Refusing here rather
    // than after DATA spares both sides the body (and us the spooling of it).
    const dnsbl = await this.dnsblWithin();
    if (dnsbl?.listed === true) {
      const why = `client IP is listed on ${dnsbl.zone}${dnsbl.reason === undefined ? '' : `: ${dnsbl.reason}`}`;
      const r = reply(554, '5.7.1', replyText(`Transaction refused: ${why}`));
      this.transactions.push({
        id: randomUUID().replace(/-/g, '').slice(0, 20),
        from: mailFrom ?? '<>',
        spf: 'not-evaluated',
        rcpts: [],
        refused: { code: r.code, enhanced: '5.7.1', reason: why },
      });
      return r;
    }
    const spf = await evaluateSpf({
      ip: this.clientIp,
      mailFrom,
      helo: ctx.hello?.domain ?? '',
      dns: this.opts.spfDns,
      receiver: this.opts.hostname,
    });
    const id = randomUUID().replace(/-/g, '').slice(0, 20);
    this.tx = {
      id,
      mailFrom,
      params,
      spf,
      recipients: [],
      log: { id, from: mailFrom ?? '<>', spf: spf.result, rcpts: [] },
    };
    this.transactions.push(this.tx.log);
    return undefined;
  }

  private async onRcpt(to: ForwardPath, ctx: Readonly<SessionContext>): Promise<SmtpReply> {
    const tx = this.tx;
    // The engine only calls RCPT inside a transaction; ours must be the same one.
    if (tx === null || ctx.transaction === null) return Replies.mailFirst;
    const text = rcptText(to);
    const answer = (r: SmtpReply, outcome: string): SmtpReply => {
      tx.log.rcpts.push({ to: text, code: r.code, ...(r.enhanced === undefined ? {} : { enhanced: r.enhanced }), outcome });
      return r;
    };
    this.sessionRcpts++;
    if (this.sessionRcpts > this.opts.maxRecipientsPerSession) {
      return answer(reply(452, '4.5.3', 'Too many recipients in this session'), 'session-limit');
    }
    const res = await resolveRecipient(this.store, to);
    if (!res.ok) {
      // PST-REQ-185: a network guessing addresses (a directory-harvest attack) is cut off.
      const refusal = res.reason === 'no-such-user' ? this.limits.onUnknownRecipient(this.clientIp) : null;
      if (refusal !== null) {
        this.rateLimited = refusal;
        return this.disconnect(answer(rateLimitReply(this.opts.hostname, refusal), 'rate-limited'));
      }
      return answer(res.reject, res.reason);
    }
    // Hosts on the LAN/tailnet (and the loopback) are never greylisted: the policy exists for
    // strangers on the internet, and PROXY v2 means internet clients never look private here.
    const greylist =
      this.opts.greylist ??
      ((input: GreylistInput) => (isPrivateClient(input.clientIp) ? Promise.resolve<GreylistVerdict>('pass') : checkGreylist(this.opts.db, input)));
    const verdict = await greylist({
      clientIp: this.clientIp,
      mailFrom: tx.mailFrom,
      recipient: res.address,
      spfResult: tx.spf.result,
      fcrdns: (await this.rdns) !== null,
      softListed: isSoftListed(this.clientIp),
    });
    if (verdict === 'defer') return answer(reply(451, '4.7.1', 'Greylisted, please try again later'), 'greylisted');
    tx.recipients.push({ rcpt: text, resolution: res });
    return answer(RecipientReplies.ok, res.kind);
  }

  private async onData(body: Readable, ctx: Readonly<SessionContext>): Promise<SmtpReply> {
    const tx = this.tx;
    if (tx === null) return Replies.mailFirst;
    // PST-T-6.3: the body's octets are never buffered or published; a single summary line stands
    // in for them once the stream ends (however it ends — 'close' always fires, so this is exactly once).
    this.recorder?.beginBody();
    let bodyBytes = 0;
    let bodyEnded = false;
    body.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
    });
    const endBody = (): void => {
      if (bodyEnded) return;
      bodyEnded = true;
      this.recorder?.endBody(bodyBytes);
    };
    body.once('end', endBody);
    body.once('close', endBody);
    const verifier = createDkimVerifierStream({ dns: this.opts.dkimDns });
    // Errors reach the acceptor through `verifier` (pipeline destroys it with the same error).
    pipeline(body, verifier).catch((err: unknown) => {
      this.errors.push(`data: ${errorMessage(err)}`);
    });
    const receivedAt = (this.opts.now ?? (() => new Date()))();
    const rdns = await this.rdns;
    const helo = ctx.hello?.domain ?? null;
    const smtputf8 = tx.params.smtputf8 === true;
    const receivedHeader = buildReceived({
      helo,
      rdns,
      ip: this.clientIp,
      hostname: this.opts.hostname,
      protocol: receivedProtocol({ ehlo: ctx.hello?.verb === 'EHLO', secure: ctx.secure, smtputf8 }),
      id: tx.id,
      recipients: tx.recipients.map((r) => r.rcpt),
      date: receivedAt,
    });
    const r = await this.acceptor(
      {
        sessionId: ctx.id,
        transactionId: tx.id,
        hostname: this.opts.hostname,
        clientIp: this.clientIp,
        clientPort: this.clientPort,
        proxied: this.proxied,
        helo,
        rdns,
        secure: ctx.secure,
        mailFrom: tx.mailFrom,
        smtputf8,
        declaredSize: tx.params.size,
        recipients: [...tx.recipients],
        receivedAt,
        receivedHeader,
      },
      verifier,
      { spf: tx.spf, dkim: verifier.results(), dnsbl: await this.dnsbl },
    );
    tx.log.data = { code: r.code, ...(r.enhanced === undefined ? {} : { enhanced: r.enhanced }) };
    return r;
  }
}

export function createSmtpInServer(opts: SmtpInOptions): SmtpInServer {
  const store = opts.recipientStore ?? prismaRecipientStore(opts.db);
  const acceptor = opts.acceptMessage ?? (opts.storage === undefined ? defaultAcceptMessage : createAcceptMessage(opts.storage));
  const perIp = new Map<string, number>();
  const limits = new InboundRateLimits({ ...RATE_LIMIT_DEFAULTS, ...opts.rateLimits });
  const sessions = new Set<ServerSession>();
  const sockets = new Set<Socket>();

  const release = (ip: string): void => {
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  };

  async function handle(socket: Socket): Promise<void> {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', (err) => {
      opts.log('socket-error', { error: err.message });
    });
    const peer = socket.remoteAddress ?? '';
    let clientIp = canonicalIp(peer);
    let clientPort = socket.remotePort;
    let via: 'proxy' | 'direct' = 'direct';

    if (isTrustedProxyPeer(peer, opts.edgePeers)) {
      // From the edge, PROXY v2 is required, and it must arrive promptly.
      try {
        const { header, rest } = await readProxyHeader(socket, { timeoutMs: opts.proxyTimeoutMs, maxBytes: 4096 });
        if (header.command !== 'PROXY' || header.source === undefined) {
          opts.log('proxy-refused', { peer, reason: `PROXY ${header.command} without a source address` });
          socket.destroy();
          return;
        }
        clientIp = canonicalIp(header.source.address);
        clientPort = header.source.port;
        via = 'proxy';
        if (rest.length > 0) socket.unshift(rest);
      } catch (err) {
        opts.log('proxy-refused', { peer, reason: errorMessage(err) });
        socket.destroy();
        return;
      }
    } else {
      refuseStrayProxyHeader(socket, () => {
        opts.log('proxy-refused', { peer, reason: 'PROXY header from a peer that is not the edge' });
      });
    }

    // PST-REQ-185: counted on the real client's address (PROXY v2), never the edge's.
    const refusal = limits.onConnect(clientIp);
    if (refusal !== null) {
      opts.log('connection-refused', { clientIp, via, reason: refusal.limit, network: refusal.network });
      socket.end(formatReply(rateLimitReply(opts.hostname, refusal), { enhanced: true }));
      return;
    }

    const open = perIp.get(clientIp) ?? 0;
    if (open >= opts.maxConnectionsPerIp) {
      opts.log('connection-refused', { clientIp, via, reason: 'per-IP connection limit', open });
      socket.end(formatReply(reply(421, '4.7.0', `${opts.hostname} Too many connections from your address`), { enhanced: true }));
      return;
    }
    perIp.set(clientIp, open + 1);
    socket.once('close', () => { release(clientIp); });

    const started = Date.now();
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => { resolve(); }));
    const conn = new InboundConnection(opts, store, clientIp, clientPort, via === 'proxy', acceptor, limits, socketClosed, () => {
      socket.destroy();
    });
    const session = createServerSession(socket, {
      hostname: opts.hostname,
      maxSize: opts.maxSize,
      hooks: conn.hooks(),
      capabilities: {
        pipelining: true,
        eightBitMime: true,
        smtpUtf8: true,
        enhancedStatusCodes: true,
        dsn: false,
        startTls: true,
      },
      remoteAddress: clientIp,
      maxRecipients: opts.maxRecipientsPerMessage,
      maxErrors: opts.maxErrors,
      idleTimeoutMs: opts.idleTimeoutMs,
    });
    conn.session = session;
    // PST-T-6.3: set right after the session id is known, and before the greeting can be written
    // (createServerSession's own first write happens no sooner than its next microtask).
    const recorder = new TranscriptRecorder({
      daemon: 'smtp-in',
      sessionId: session.context.id,
      clientIp,
      db: opts.db,
      log: opts.log,
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    conn.recorder = recorder;
    attachTranscriptTap(socket, recorder);
    sessions.add(session);
    await session.done;
    sessions.delete(session);
    // The client already has its last reply and the socket is closing: awaiting here delays nothing
    // the protocol promised, and `finish()` itself never throws.
    await recorder.finish();
    // One structured line per session: envelopes and outcomes, never bodies.
    opts.log('session', {
      id: session.context.id,
      clientIp,
      clientPort,
      via,
      peer,
      helo: session.context.hello?.domain ?? null,
      tls: session.context.secure,
      commands: session.stats.commands,
      transactions: conn.transactions,
      errors: conn.errors,
      ...(conn.rateLimited === null ? {} : { rateLimited: conn.rateLimited }),
      durationMs: Date.now() - started,
    });
  }

  const server = createServer({ pauseOnConnect: false }, (socket) => {
    handle(socket).catch((err: unknown) => {
      opts.log('connection-error', { error: errorMessage(err) });
      socket.destroy();
    });
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => { resolve(); });
        for (const s of sessions) s.close();
        // Sockets still waiting on a PROXY header have no session to say goodbye.
        setTimeout(() => {
          for (const s of sockets) s.destroy();
        }, 1_000).unref();
      }),
    activeSessions: () => sessions.size,
    rateLimitTracked: () => limits.tracked(),
  };
}
