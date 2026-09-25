// The submission server (RFC 6409): policy hooks around the @postroom/smtp-proto session engine.
//
//   PST-REQ-025  587 with STARTTLS, 465 with implicit TLS; AUTH only once the session is TLS.
//   PST-REQ-027  AUTH checks app passwords only (verifyProtocolLogin, scope 'smtp').
//   PST-REQ-028  MAIL FROM and the From header must both be the authenticated account's (553).
//   PST-REQ-053  no relay: MAIL before AUTH is 530, and nothing is queued without an account.
//   PST-REQ-038  every accepted message is DKIM-signed (Ed25519 + RSA) for the From domain.
//   PST-REQ-060  250 only after the signed blob is fsynced and its rows and jobs are committed.
import { randomUUID } from 'node:crypto';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { Readable, type Duplex } from 'node:stream';
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import { HeaderTooLargeError, signMessage, splitMessage } from '@postroom/auth-checks';
import { recordAudit } from '@postroom/audit';
import { tmpDir, type BlobStore } from '@postroom/blobstore';
import { verifyProtocolLogin } from '@postroom/credentials';
import type { Kek } from '@postroom/crypto';
import type { Db, Prisma } from '@postroom/db';
import { enqueueOutbound } from '@postroom/delivery';
import {
  SmtpDataRejectedError,
  createServerSession,
  formatMailbox,
  reply,
  tlsUpgrader,
  type AuthResult,
  type ServerSession,
  type SmtpReply,
} from '@postroom/smtp-proto';
import { allowAllCaps, type CheckCaps } from './caps-seam.js';
import { loadSigningKeys } from './dkim.js';
import { inspectHeaders, rewriteHeaders } from './headers.js';
import { SASL_MECHANISMS, readCredentials } from './sasl.js';
import { Spool } from './spool.js';
import { AuthThrottle } from './throttle.js';

export const SubmissionReplies = {
  authRequired: reply(530, '5.7.0', 'Authentication required'),
  badCredentials: reply(535, '5.7.8', 'Authentication credentials invalid'),
  malformedCredentials: reply(501, '5.5.2', 'Cannot decode credentials'),
  authLocked: reply(454, '4.7.0', 'Too many authentication failures, try again later'),
  authUnconfigured: reply(454, '4.7.0', 'Temporary authentication failure'),
  nullSender: reply(553, '5.7.1', 'The null sender is not permitted on submission'),
  senderNotOwned: reply(553, '5.7.1', 'Sender address is not yours'),
  fromNotOwned: reply(553, '5.7.1', 'From header address is not yours'),
  fromMissing: reply(553, '5.7.1', 'Message must have exactly one From header with your address'),
  recipientNotQualified: reply(550, '5.1.3', 'Recipient must be a full address'),
  recipientLiteral: reply(550, '5.1.2', 'Address-literal recipients are not accepted'),
  headerTooLarge: reply(552, '5.3.4', 'Header block too large'),
  dkimUnconfigured: reply(451, '4.3.5', 'DKIM keys not configured for the sender domain'),
  notAccepted: reply(451, '4.3.0', 'Local error, message not accepted'),
} as const satisfies Record<string, SmtpReply>;

/** Test seam: runs inside the accepting transaction, after every write, before the commit. */
export interface SubmissionFaults {
  readonly beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface SubmissionStorage {
  readonly blobs: BlobStore;
  readonly kek: Kek;
}

export interface SubmissionOptions {
  readonly db: Db;
  readonly hostname: string;
  readonly maxSize: number;
  readonly maxRecipients: number;
  /** PASSWORD_PEPPER. Without it AUTH answers 454 (nothing can authenticate, so nothing is sent). */
  readonly pepper: string | undefined;
  /** Opened on first use, so the daemon can boot (and report health) before the KEK is needed. */
  readonly storage: () => SubmissionStorage;
  /** PEM key + certificate. Null: 587 serves without STARTTLS, so AUTH (and so MAIL) is impossible. */
  readonly tls: { readonly key: string | Buffer; readonly cert: string | Buffer } | null;
  readonly throttle?: AuthThrottle;
  readonly checkCaps?: CheckCaps;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
  readonly faults?: SubmissionFaults;
  readonly idleTimeoutMs?: number;
  readonly maxHeaderBytes?: number;
  readonly now?: () => Date;
}

interface Login {
  readonly accountId: string;
  readonly appPasswordId: string;
  readonly username: string;
  /** Lowercased `local@domain` the account may send as. */
  readonly addresses: ReadonlySet<string>;
}

const TX_OPTIONS = { maxWait: 30_000, timeout: 600_000 } as const;
const DEFAULT_MAX_HEADER_BYTES = 1024 * 1024;

const noLog = (): void => undefined;

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Serve one SMTP submission connection. `secure` is true for implicit TLS (465). */
export function serveSubmission(socket: Duplex, secure: boolean, remoteAddress: string | undefined, o: SubmissionOptions): ServerSession {
  const throttle = o.throttle ?? new AuthThrottle();
  const checkCaps = o.checkCaps ?? allowAllCaps;
  const log = o.log ?? noLog;
  const now = o.now ?? ((): Date => new Date());
  const ip = remoteAddress ?? 'unknown';
  let login: Login | null = null;

  const owns = (address: string): boolean => login?.addresses.has(address.toLowerCase()) === true;

  return createServerSession(socket, {
    hostname: o.hostname,
    maxSize: o.maxSize,
    maxRecipients: o.maxRecipients,
    secure,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    ...(o.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: o.idleTimeoutMs }),
    capabilities: {
      pipelining: true,
      eightBitMime: true,
      smtpUtf8: true,
      enhancedStatusCodes: true,
      dsn: true,
      auth: SASL_MECHANISMS,
      authRequiresTls: true,
      startTls: true,
    },
    hooks: {
      ...(o.tls === null ? {} : { upgradeTls: tlsUpgrader({ key: o.tls.key, cert: o.tls.cert }) }),

      onAuth: async (request, sasl, ctx): Promise<AuthResult> => {
        if (throttle.isLocked(ip)) {
          log('auth', { session: ctx.id, ip, mechanism: request.mechanism, ok: false, reason: 'locked' });
          return { ok: false, reply: SubmissionReplies.authLocked };
        }
        const creds = await readCredentials(request, sasl);
        if (creds === null) {
          await sleep(throttle.fail(ip));
          log('auth', { session: ctx.id, ip, mechanism: request.mechanism, ok: false, reason: 'malformed' });
          return { ok: false, reply: SubmissionReplies.malformedCredentials };
        }
        if (o.pepper === undefined) {
          log('auth', { session: ctx.id, ip, ok: false, reason: 'no-pepper-configured' });
          return { ok: false, reply: SubmissionReplies.authUnconfigured };
        }
        const result = await verifyProtocolLogin(
          o.db,
          { username: creds.username, password: creds.password, scope: 'smtp', ip: remoteAddress ?? null },
          { pepper: o.pepper },
        );
        if (!result.ok) {
          // One generic refusal for every reason (the reason goes to the log only). A frozen
          // credential is refused like the rest until PST-T-1.10 decides how held mail is reported.
          await sleep(throttle.fail(ip));
          log('auth', { session: ctx.id, ip, mechanism: request.mechanism, username: creds.username, ok: false, reason: result.reason });
          return { ok: false, reply: SubmissionReplies.badCredentials };
        }
        throttle.succeed(ip);
        login = {
          accountId: result.accountId,
          appPasswordId: result.appPasswordId,
          username: creds.username,
          addresses: new Set(result.addresses.map((a) => a.toLowerCase())),
        };
        log('auth', { session: ctx.id, ip, mechanism: request.mechanism, username: creds.username, ok: true, accountId: result.accountId });
        return { ok: true, identity: creds.username };
      },

      onMail: (from, _params, ctx) => {
        // PST-REQ-053: no transaction without an authenticated account, from any address.
        if (ctx.auth === null || login === null) return SubmissionReplies.authRequired;
        if (from.kind === 'null') return SubmissionReplies.nullSender;
        if (!owns(formatMailbox(from.mailbox))) {
          log('sender-refused', { session: ctx.id, accountId: login.accountId, reason: 'envelope' });
          return SubmissionReplies.senderNotOwned;
        }
        return undefined;
      },

      onRcpt: (to, _params, ctx) => {
        if (ctx.auth === null || login === null) return SubmissionReplies.authRequired;
        if (to.kind === 'postmaster') return SubmissionReplies.recipientNotQualified;
        if (to.mailbox.domain.startsWith('[')) return SubmissionReplies.recipientLiteral;
        return reply(250, '2.1.5', 'Recipient OK');
      },

      onData: async (body, ctx): Promise<SmtpReply> => {
        const tx = ctx.transaction;
        const who = login;
        if (ctx.auth === null || who === null || tx === null || tx.from.kind === 'null') return SubmissionReplies.authRequired;
        try {
          return await acceptMessage(body, {
            login: who,
            envelopeFrom: formatMailbox(tx.from.mailbox),
            recipients: tx.recipients.map((r) => ({
              address: r.to.kind === 'mailbox' ? formatMailbox(r.to.mailbox) : '',
              ...(r.params.notify === undefined ? {} : { notify: r.params.notify.join(',') }),
            })),
            dsnRet: tx.params.ret,
            dsnEnvid: tx.params.envid,
            sessionId: ctx.id,
          });
        } catch (err) {
          // The engine answers protocol-level rejections itself (bare LF, too large, dropped).
          if (err instanceof SmtpDataRejectedError) throw err;
          log('data-error', { session: ctx.id, ip, error: errorText(err) });
          return SubmissionReplies.notAccepted;
        }
      },

      onError: (error, ctx) => {
        log('session-error', { session: ctx.id, ip, error: errorText(error) });
      },
    },
  });

  interface Envelope {
    readonly login: Login;
    readonly envelopeFrom: string;
    readonly recipients: readonly { readonly address: string; readonly notify?: string }[];
    readonly dsnRet: string | undefined;
    readonly dsnEnvid: string | undefined;
    readonly sessionId: string;
  }

  async function acceptMessage(body: Readable, env: Envelope): Promise<SmtpReply> {
    // 1. The header block (bounded), and the sender check on it (PST-REQ-028).
    let split;
    try {
      split = await splitMessage(body, { maxHeaderBytes: o.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES });
    } catch (err) {
      if (err instanceof HeaderTooLargeError) return SubmissionReplies.headerTooLarge;
      throw err;
    }
    const headers = inspectHeaders(split.headerBlock);
    if (!headers.ok) {
      log('sender-refused', { session: env.sessionId, accountId: env.login.accountId, reason: headers.reason });
      return SubmissionReplies.fromMissing;
    }
    if (!headers.from.every(owns)) {
      log('sender-refused', { session: env.sessionId, accountId: env.login.accountId, reason: 'header-from' });
      return SubmissionReplies.fromNotOwned;
    }
    const headerFrom = headers.from[0] ?? env.envelopeFrom;
    const signingDomain = domainOf(headerFrom);

    // 2. Keys before any work: never send unsigned (PST-REQ-038).
    const storage = o.storage();
    const keys = await loadSigningKeys(o.db, storage.kek, signingDomain, now());
    if (keys === null) {
      log('dkim-unconfigured', { session: env.sessionId, domain: signingDomain });
      return SubmissionReplies.dkimUnconfigured;
    }

    // 3. Header fix-ups, then pass 1: the fixed message into the encrypted spool.
    const fixed = rewriteHeaders(headers.fields, { domain: signingDomain, now: now() });
    const spool = await Spool.create(tmpDir(storage.blobs.root));
    try {
      await spool.write(
        (async function* message(): AsyncGenerator<Buffer> {
          yield fixed.block;
          yield Buffer.from('\r\n', 'latin1');
          for await (const chunk of split.body) yield chunk;
        })(),
      );

      // Pass 2: sign (one read of the spool; body hashed once for both keys).
      const signatures = await signMessage(spool.open(), { domain: signingDomain, keys, now: now() });

      const recipients = env.recipients.map((r) => r.address);
      const caps = await checkCaps({ accountId: env.login.accountId, appPasswordId: env.login.appPasswordId }, recipients);
      if (caps.action === 'reject') {
        log('caps-refused', { session: env.sessionId, accountId: env.login.accountId });
        return caps.reply;
      }

      // Pass 3, inside the one accepting transaction: signatures + spool → the final blob
      // (fsynced before put() returns), the queue rows and jobs, the audit row. Commit, then 250.
      const accepted = await o.db.$transaction(async (dbTx) => {
        const blob = await storage.blobs.put(
          Readable.from(
            (async function* signed(): AsyncGenerator<Buffer> {
              for (const s of signatures) yield Buffer.from(s, 'latin1');
              for await (const chunk of spool.open()) yield chunk as Buffer;
            })(),
          ),
          { tx: dbTx },
        );
        const queued = await enqueueOutbound(dbTx, {
          accountId: env.login.accountId,
          appPasswordId: env.login.appPasswordId,
          envelopeFrom: env.envelopeFrom,
          headerFrom,
          messageId: fixed.messageId,
          ...(headers.subject === undefined ? {} : { subject: headers.subject.slice(0, 998) }),
          blobSha256: blob.sha256,
          size: blob.size,
          ...(env.dsnRet === undefined ? {} : { dsnRet: env.dsnRet }),
          ...(env.dsnEnvid === undefined ? {} : { dsnEnvid: env.dsnEnvid }),
          submittedVia: 'submission',
          recipients: env.recipients,
        });
        await recordAudit(dbTx, {
          actor: { kind: 'account', accountId: env.login.accountId },
          action: 'submission.accept',
          entityType: 'outbound_message',
          entityId: queued.message.id,
          before: null,
          after: {
            appPasswordId: env.login.appPasswordId,
            envelopeFrom: env.envelopeFrom,
            headerFrom,
            messageId: fixed.messageId,
            blobSha256: blob.sha256,
            size: blob.size,
            recipients: queued.recipients,
            domains: queued.domains,
            dkim: keys.map((k) => `${k.algorithm}:${k.selector}`),
            addedMessageId: fixed.addedMessageId,
            addedDate: fixed.addedDate,
            strippedBcc: fixed.strippedBcc,
          },
          context: { requestId: randomUUID(), ip: remoteAddress ?? null },
        });
        await o.faults?.beforeCommit?.(dbTx);
        return queued.message.id;
      }, TX_OPTIONS);

      log('accepted', { session: env.sessionId, accountId: env.login.accountId, outboundMessageId: accepted, recipients: recipients.length });
      return reply(250, '2.0.0', `Queued as ${accepted}`);
    } finally {
      await spool.dispose();
    }
  }
}

export interface SubmissionListeners {
  /** 587: plaintext, STARTTLS when a certificate is configured. */
  readonly submission: TcpServer;
  /** 465: implicit TLS. Null without a certificate. */
  readonly submissions: TlsServer | null;
  close(): Promise<void>;
}

/** Create (not yet listening) the 587 and 465 servers. */
export function createSubmissionListeners(o: SubmissionOptions): SubmissionListeners {
  const sockets = new Set<Socket | TLSSocket>();
  const track = (s: Socket | TLSSocket): void => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };
  const log = o.log ?? noLog;
  const submission = createTcpServer((socket) => {
    track(socket);
    serveSubmission(socket, false, socket.remoteAddress, o);
  });
  let submissions: TlsServer | null = null;
  if (o.tls !== null) {
    submissions = createTlsServer({ key: o.tls.key, cert: o.tls.cert, minVersion: 'TLSv1.2' }, (socket) => {
      track(socket);
      serveSubmission(socket, true, socket.remoteAddress, o);
    });
    submissions.on('tlsClientError', (err, socket) => {
      log('tls-error', { ip: socket.remoteAddress, error: errorText(err) });
      socket.destroy();
    });
  }
  const closeServer = (server: TcpServer | TlsServer): Promise<void> =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
  return {
    submission,
    submissions,
    close: async () => {
      const closing = [closeServer(submission), ...(submissions === null ? [] : [closeServer(submissions)])];
      for (const s of sockets) s.destroy();
      await Promise.all(closing);
    },
  };
}
