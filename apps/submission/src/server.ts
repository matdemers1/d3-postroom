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
import type { Duplex, Readable } from 'node:stream';
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import { createAuthThrottle, type AuthThrottle } from '@postroom/auth-throttle';
import { verifyProtocolLogin } from '@postroom/credentials';
import type { Db, Prisma } from '@postroom/db';
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
import { acceptSubmission, AcceptReplies, type SubmissionStorage } from './accept.js';
import { allowAllCaps, allowAllEnforcement, type CheckCaps, type EnforceCaps } from './caps-seam.js';
import { isCredentialFrozen } from './caps/index.js';
import { SASL_MECHANISMS, readCredentials } from './sasl.js';
import { attachTranscriptTap, TranscriptRecorder } from './transcript.js';

// The submission path, shared with the webmail's POST /api/compose/send (PST-T-3.11): the API
// imports these from '@postroom/submission' rather than re-implementing them.
export {
  acceptSubmission,
  AcceptReplies,
  sendableAddresses,
  type AcceptDeps,
  type AcceptedMessage,
  type AcceptInput,
  type AcceptOutcome,
  type EnforceSubmitterCaps,
  type Submitter,
  type SubmissionStorage,
} from './accept.js';
export { CapExceededError, type SubmissionCredential } from './caps-seam.js';
export { formatRfc5322Date, parseAddressList } from './headers.js';

export const SubmissionReplies = {
  authRequired: reply(530, '5.7.0', 'Authentication required'),
  badCredentials: reply(535, '5.7.8', 'Authentication credentials invalid'),
  malformedCredentials: reply(501, '5.5.2', 'Cannot decode credentials'),
  authLocked: reply(454, '4.7.0', 'Too many authentication failures, try again later'),
  authUnconfigured: reply(454, '4.7.0', 'Temporary authentication failure'),
  nullSender: reply(553, '5.7.1', 'The null sender is not permitted on submission'),
  senderNotOwned: reply(553, '5.7.1', 'Sender address is not yours'),
  fromNotOwned: AcceptReplies.fromNotOwned,
  fromMissing: AcceptReplies.fromMissing,
  recipientNotQualified: reply(550, '5.1.3', 'Recipient must be a full address'),
  recipientLiteral: reply(550, '5.1.2', 'Address-literal recipients are not accepted'),
  headerTooLarge: AcceptReplies.headerTooLarge,
  dkimUnconfigured: AcceptReplies.dkimUnconfigured,
  notAccepted: reply(451, '4.3.0', 'Local error, message not accepted'),
  /** PST-REQ-044: a frozen credential may still authenticate, but every MAIL is refused. */
  credentialFrozen: reply(452, '4.7.0', 'Credential frozen by rate cap; contact the operator'),
} as const satisfies Record<string, SmtpReply>;

/** Test seam: runs inside the accepting transaction, after every write, before the commit. */
export interface SubmissionFaults {
  readonly beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
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
  /** PST-REQ-075: shared, audit-backed tarpit. Default: one per listener set, on `db`. */
  readonly throttle?: AuthThrottle;
  /** RCPT-time, best-effort (see caps-seam.ts). Not what makes the cap correct under concurrency. */
  readonly checkCaps?: CheckCaps;
  /** Authoritative: run inside the accepting transaction, before the insert (see caps-seam.ts). */
  readonly enforceCaps?: EnforceCaps;
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

const noLog = (): void => undefined;

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Serve one SMTP submission connection. `secure` is true for implicit TLS (465). */
export function serveSubmission(socket: Duplex, secure: boolean, remoteAddress: string | undefined, o: SubmissionOptions): ServerSession {
  const throttle = o.throttle ?? createAuthThrottle({ db: o.db });
  const checkCaps = o.checkCaps ?? allowAllCaps;
  const enforceCaps = o.enforceCaps ?? allowAllEnforcement;
  const log = o.log ?? noLog;
  const now = o.now ?? ((): Date => new Date());
  const ip = remoteAddress ?? 'unknown';
  const hangup = new AbortController();
  socket.once('close', () => {
    hangup.abort();
  });
  let login: Login | null = null;

  const owns = (address: string): boolean => login?.addresses.has(address.toLowerCase()) === true;

  // PST-T-6.3: no InboundSession here, so the transcript's sessionId is just a random id (as the
  // schema comment says) — attached before createServerSession so the greeting (its first write) is
  // captured too.
  const recorder = new TranscriptRecorder({ daemon: 'submission', sessionId: randomUUID(), clientIp: ip, db: o.db, log, now });
  attachTranscriptTap(socket, recorder);

  const session = createServerSession(socket, {
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
      ...(o.tls === null
        ? {}
        : {
            upgradeTls: ((tls) => async (sock: Duplex) => {
              const secured = await tlsUpgrader({ key: tls.key, cert: tls.cert })(sock);
              // The tap was on the plaintext socket; STARTTLS hands the engine a new Duplex.
              attachTranscriptTap(secured, recorder);
              return secured;
            })(o.tls),
          }),

      onAuth: async (request, sasl, ctx): Promise<AuthResult> => {
        const creds = await readCredentials(request, sasl);
        // PST-REQ-075: the tarpit runs before the credentials are evaluated, and every failure is an
        // audit row (auth.failure, no secrets). Aborted when the client hangs up mid-delay.
        const attempt = { protocol: 'submission', username: creds?.username ?? '', ip };
        const gate = await throttle.before(attempt, hangup.signal);
        if (gate.outcome !== 'proceed') {
          log('auth', { session: ctx.id, ip, mechanism: request.mechanism, ok: false, reason: gate.outcome === 'refuse' ? 'locked' : 'disconnected' });
          return { ok: false, reply: SubmissionReplies.authLocked };
        }
        if (creds === null) {
          await throttle.failure(attempt, 'malformed');
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
          // One generic refusal for every reason (the reason goes to the log and the audit row only). A frozen
          // credential is refused like the rest until PST-T-1.10 decides how held mail is reported.
          await throttle.failure(attempt, result.reason);
          log('auth', { session: ctx.id, ip, mechanism: request.mechanism, username: creds.username, ok: false, reason: result.reason });
          return { ok: false, reply: SubmissionReplies.badCredentials };
        }
        await throttle.success(attempt);
        login = {
          accountId: result.accountId,
          appPasswordId: result.appPasswordId,
          username: creds.username,
          addresses: new Set(result.addresses.map((a) => a.toLowerCase())),
        };
        log('auth', { session: ctx.id, ip, mechanism: request.mechanism, username: creds.username, ok: true, accountId: result.accountId });
        return { ok: true, identity: creds.username };
      },

      onMail: async (from, _params, ctx) => {
        // PST-REQ-053: no transaction without an authenticated account, from any address.
        if (ctx.auth === null || login === null) return SubmissionReplies.authRequired;
        if (from.kind === 'null') return SubmissionReplies.nullSender;
        if (!owns(formatMailbox(from.mailbox))) {
          log('sender-refused', { session: ctx.id, accountId: login.accountId, reason: 'envelope' });
          return SubmissionReplies.senderNotOwned;
        }
        // PST-REQ-044: AUTH still succeeds for a frozen credential, but no new message may start.
        if (await isCredentialFrozen(o.db, login.appPasswordId)) {
          log('caps-refused', { session: ctx.id, accountId: login.accountId, stage: 'mail' });
          return SubmissionReplies.credentialFrozen;
        }
        return undefined;
      },

      onRcpt: async (to, _params, ctx) => {
        if (ctx.auth === null || login === null) return SubmissionReplies.authRequired;
        if (to.kind === 'postmaster') return SubmissionReplies.recipientNotQualified;
        if (to.mailbox.domain.startsWith('[')) return SubmissionReplies.recipientLiteral;
        // PST-REQ-043: the cap+1th recipient (counting this transaction's accepted recipients plus
        // this candidate, against the credential's rolling window) is refused with 452.
        const tx = ctx.transaction;
        const soFar = tx === null ? [] : tx.recipients.map((r) => (r.to.kind === 'mailbox' ? formatMailbox(r.to.mailbox) : ''));
        const decision = await checkCaps({ accountId: login.accountId, appPasswordId: login.appPasswordId }, [...soFar, formatMailbox(to.mailbox)]);
        if (decision.action === 'reject') {
          log('caps-refused', { session: ctx.id, accountId: login.accountId, stage: 'rcpt' });
          return decision.reply;
        }
        return reply(250, '2.1.5', 'Recipient OK');
      },

      onData: async (body, ctx): Promise<SmtpReply> => {
        // PST-T-6.3: the body's octets are never buffered or published — a summary line stands in
        // once the stream ends, however it ends ('close' always fires, so this runs exactly once).
        recorder.beginBody();
        let bodyBytes = 0;
        let bodyEnded = false;
        body.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.length;
        });
        const endBody = (): void => {
          if (bodyEnded) return;
          bodyEnded = true;
          recorder.endBody(bodyBytes);
        };
        body.once('end', endBody);
        body.once('close', endBody);
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
  // The client already has its last reply once `done` resolves: finishing the transcript here
  // delays nothing the protocol promised, and `finish()` itself never throws.
  void session.done.then(() => recorder.finish());
  return session;

  interface Envelope {
    readonly login: Login;
    readonly envelopeFrom: string;
    readonly recipients: readonly { readonly address: string; readonly notify?: string }[];
    readonly dsnRet: string | undefined;
    readonly dsnEnvid: string | undefined;
    readonly sessionId: string;
  }

  async function acceptMessage(body: Readable, env: Envelope): Promise<SmtpReply> {
    // The submission path itself is shared with the webmail (accept.ts, PST-T-3.11).
    const credential = { accountId: env.login.accountId, appPasswordId: env.login.appPasswordId };
    const outcome = await acceptSubmission(
      body,
      {
        submitter: { accountId: env.login.accountId, appPasswordId: env.login.appPasswordId, addresses: env.login.addresses },
        envelopeFrom: env.envelopeFrom,
        recipients: env.recipients,
        dsnRet: env.dsnRet,
        dsnEnvid: env.dsnEnvid,
        sessionId: env.sessionId,
        submittedVia: 'submission',
        enforceCaps: (tx, recipients, at) => enforceCaps(tx, credential, recipients, at),
        auditContext: { requestId: randomUUID(), ip: remoteAddress ?? null },
      },
      {
        db: o.db,
        storage: o.storage,
        now,
        log,
        ...(o.maxHeaderBytes === undefined ? {} : { maxHeaderBytes: o.maxHeaderBytes }),
        ...(o.faults?.beforeCommit === undefined ? {} : { beforeCommit: o.faults.beforeCommit }),
      },
    );
    if (outcome.ok) return reply(250, '2.0.0', `Queued as ${outcome.outboundId}`);
    return outcome.reply;
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
export function createSubmissionListeners(options: SubmissionOptions): SubmissionListeners {
  // One throttle for every session, so a success in one connection ends the streak for the next.
  const o: SubmissionOptions = { ...options, throttle: options.throttle ?? createAuthThrottle({ db: options.db }) };
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
