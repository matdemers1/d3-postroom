// One SMTP session against one MX address (RFC 5321 §3, §4.5.3.2; RFC 3207; RFC 1870; RFC 3461;
// RFC 6152): greeting → EHLO (HELO fallback) → STARTTLS when offered → EHLO again → MAIL → RCPT
// per recipient → DATA → streamed, dot-stuffed body → final reply.
//
// Anything that fails before MAIL FROM is sent says nothing about the message, only about this MX,
// so the caller moves on to the next address ('next'). From MAIL FROM onwards the transaction is
// definitive for this attempt: every recipient gets an outcome from what this server said, and a
// failure mid-transaction is an `error` (retried later) for everyone the server had not answered.
import { isIP } from 'node:net';
import type tls from 'node:tls';
import {
  formatMailParams,
  formatRcptParams,
  hasNonAscii,
  parseEhloCapabilities,
  type DsnNotify,
  type DsnRet,
  type MailParams,
  type RcptParams,
  type SmtpReply,
} from '@postroom/smtp-proto';
import type { AttemptOutcome } from '../state.js';
import type { AttemptDetails, DeliveryRecipient, DeliveryRequest } from '../transports/types.js';
import { errorText, SmtpClientError, type SmtpConnection } from './connection.js';
import { DotStuffer } from './dot-stuff.js';

/** RFC 5321 §4.5.3.2 client timeouts, in milliseconds. */
export interface CommandTimeouts {
  /** Initial 220 greeting: 5 minutes. */
  greeting: number;
  /** EHLO/HELO: not given by the RFC; the MAIL figure is used. */
  ehlo: number;
  /** STARTTLS reply. */
  starttls: number;
  /** TLS handshake after the 220 to STARTTLS. */
  tlsHandshake: number;
  /** MAIL: 5 minutes. */
  mail: number;
  /** RCPT: 5 minutes. */
  rcpt: number;
  /** DATA initiation (the 354): 2 minutes. */
  dataInit: number;
  /** Each data block write to be accepted: 3 minutes. */
  dataBlock: number;
  /** DATA termination (the final reply): 10 minutes. */
  dataTerm: number;
  /** QUIT, sent after the attempt has resolved. Short: nothing depends on it. */
  quit: number;
}

export const RFC5321_TIMEOUTS: CommandTimeouts = {
  greeting: 5 * 60_000,
  ehlo: 5 * 60_000,
  starttls: 2 * 60_000,
  tlsHandshake: 60_000,
  mail: 5 * 60_000,
  rcpt: 5 * 60_000,
  dataInit: 2 * 60_000,
  dataBlock: 3 * 60_000,
  dataTerm: 10 * 60_000,
  quit: 10_000,
};

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface SessionConfig {
  heloName: string;
  timeouts: CommandTimeouts;
  tlsOptions: tls.ConnectionOptions;
  log: Log;
}

export interface Target {
  host: string;
  ip: string;
}

export type SessionResult =
  | { kind: 'definitive'; results: Record<string, AttemptOutcome> }
  | { kind: 'next'; outcome: AttemptOutcome };

function replyText(reply: SmtpReply): string {
  return reply.lines.join(' ').trim();
}

/** 2xx delivered, 4xx temporary, 5xx permanent; anything else is a protocol surprise, retried. */
export function classifyReply(reply: SmtpReply): AttemptOutcome {
  const text = replyText(reply);
  const enhanced = reply.enhanced === undefined ? {} : { enhanced: reply.enhanced };
  if (reply.code >= 200 && reply.code < 300) return { kind: 'delivered', code: reply.code, ...enhanced, text };
  if (reply.code >= 500) return { kind: 'permanent', code: reply.code, ...enhanced, text };
  if (reply.code >= 400) return { kind: 'temporary', code: reply.code, ...enhanced, text };
  return { kind: 'temporary', code: reply.code, ...enhanced, text: `unexpected reply: ${text}` };
}

/** A reply that makes us give up on this MX (not the message): 4xx keeps its code, anything else is an error. */
function nextFromReply(target: Target, stage: string, reply: SmtpReply): SessionResult {
  const text = `${target.host} [${target.ip}] ${stage}: ${String(reply.code)} ${replyText(reply)}`;
  if (reply.code >= 400 && reply.code < 500) {
    return { kind: 'next', outcome: { kind: 'temporary', code: reply.code, ...(reply.enhanced === undefined ? {} : { enhanced: reply.enhanced }), text } };
  }
  return { kind: 'next', outcome: { kind: 'error', error: text } };
}

const DSN_NOTIFY = new Set<string>(['NEVER', 'SUCCESS', 'FAILURE', 'DELAY']);

function isDsnNotify(word: string): word is DsnNotify {
  return DSN_NOTIFY.has(word);
}

function notifyWords(notify: string | null): DsnNotify[] {
  if (notify === null) return [];
  return notify.split(',').map((w) => w.trim().toUpperCase()).filter(isDsnNotify);
}

function dsnRet(value: string | null): DsnRet | undefined {
  const v = value?.toUpperCase();
  return v === 'FULL' || v === 'HDRS' ? v : undefined;
}

/** An address that could break command framing never reaches the wire. */
function unsafeAddress(address: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x20<>\x7f]/.test(address);
}

/** EHLO, falling back to HELO when the server does not know EHLO. Null capabilities = give up on this MX. */
async function hello(conn: SmtpConnection, cfg: SessionConfig, target: Target, afterTls: boolean): Promise<Map<string, string[]> | SessionResult> {
  const ehlo = await conn.command('ehlo', `EHLO ${cfg.heloName}`, cfg.timeouts.ehlo);
  if (ehlo.code === 250) return parseEhloCapabilities(ehlo);
  if (ehlo.code >= 500 && !afterTls) {
    const helo = await conn.command('helo', `HELO ${cfg.heloName}`, cfg.timeouts.ehlo);
    if (helo.code === 250) return new Map<string, string[]>();
    return nextFromReply(target, 'HELO', helo);
  }
  return nextFromReply(target, afterTls ? 'EHLO after STARTTLS' : 'EHLO', ehlo);
}

function describePeer(secure: tls.TLSSocket): string {
  const cert = secure.getPeerCertificate();
  const parts: string[] = [];
  const subject = (cert as Partial<typeof cert>).subject;
  const issuer = (cert as Partial<typeof cert>).issuer;
  if (subject?.CN !== undefined) parts.push(`CN=${String(subject.CN)}`);
  if (issuer?.CN !== undefined) parts.push(`issuer=CN=${String(issuer.CN)}`);
  parts.push(`verified=${String(secure.authorized)}`);
  if (!secure.authorized) parts.push(`reason=${String(secure.authorizationError)}`);
  return parts.join('; ');
}

function tlsOptionsFor(target: Target, cfg: SessionConfig): tls.ConnectionOptions {
  const host = target.host.replace(/\.$/, '');
  return {
    // Opportunistic STARTTLS (RFC 3207): without DANE or MTA-STS there is no authenticated name to
    // hold the peer to, so an unverifiable certificate still beats plaintext. Whether it verified is
    // recorded in tlsPeer; enforcement arrives with MTA-STS/DANE (PST-T-7.5).
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    ...(isIP(host) === 0 ? { servername: host } : {}),
    ...cfg.tlsOptions,
  };
}

async function streamBody(conn: SmtpConnection, request: DeliveryRequest, blockTimeoutMs: number): Promise<void> {
  const stream = await request.message();
  // If the connection dies while we wait on the blob store, stop waiting.
  const unsubscribe = conn.onFail((error) => { stream.destroy(error); });
  const stuffer = new DotStuffer();
  try {
    for await (const chunk of stream) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Uint8Array);
      const out = stuffer.push(bytes);
      if (out.length > 0) await conn.write('data-body', out, blockTimeoutMs);
    }
    await conn.write('data-body', stuffer.end(), blockTimeoutMs);
  } finally {
    unsubscribe();
    if (!stream.destroyed) stream.destroy();
  }
}

/** Run one session. Resolves once the final reply to DATA (or the last definitive reply) is read. */
export async function runSession(conn: SmtpConnection, target: Target, request: DeliveryRequest, cfg: SessionConfig, details: AttemptDetails): Promise<SessionResult> {
  const t = cfg.timeouts;
  const results: Record<string, AttemptOutcome> = {};
  const all = (outcome: AttemptOutcome): Record<string, AttemptOutcome> => {
    for (const r of request.recipients) results[r.id] ??= outcome;
    return results;
  };
  let inTransaction = false;
  try {
    const greeting = await conn.read('greeting', t.greeting);
    if (greeting.code !== 220) return nextFromReply(target, 'greeting', greeting);

    let caps = await hello(conn, cfg, target, false);
    if (!(caps instanceof Map)) return caps;

    if (caps.has('STARTTLS')) {
      const starttls = await conn.command('starttls', 'STARTTLS', t.starttls);
      if (starttls.code === 220) {
        const secure = await conn.startTls(tlsOptionsFor(target, cfg), t.tlsHandshake);
        const protocol = secure.getProtocol();
        if (protocol !== null) details.tlsVersion = protocol;
        details.tlsCipher = secure.getCipher().name;
        details.tlsPeer = describePeer(secure);
        // RFC 3207 §4.2: forget everything learned before the handshake.
        caps = await hello(conn, cfg, target, true);
        if (!(caps instanceof Map)) return caps;
      } else {
        cfg.log('starttls-refused', { mxHost: target.host, mxIp: target.ip, code: starttls.code, text: replyText(starttls) });
      }
    }

    if (unsafeAddress(request.envelopeFrom)) {
      return { kind: 'definitive', results: all({ kind: 'permanent', code: 553, enhanced: '5.1.7', text: 'invalid envelope sender' }) };
    }
    const smtputf8 = caps.has('SMTPUTF8') && (hasNonAscii(request.envelopeFrom) || request.recipients.some((r) => hasNonAscii(r.address)));
    const ret = caps.has('DSN') ? dsnRet(request.dsnRet) : undefined;
    const mailParams: MailParams = {
      ...(caps.has('SIZE') ? { size: request.size } : {}),
      ...(caps.has('8BITMIME') ? { body: '8BITMIME' as const } : {}),
      ...(smtputf8 ? { smtputf8: true } : {}),
      ...(ret === undefined ? {} : { ret }),
      ...(caps.has('DSN') && request.dsnEnvid !== null ? { envid: request.dsnEnvid } : {}),
    };

    inTransaction = true;
    const mail = await conn.command('mail', `MAIL FROM:<${request.envelopeFrom}>${formatMailParams(mailParams)}`, t.mail);
    if (mail.code < 200 || mail.code >= 300) {
      const outcome = classifyReply(mail);
      return { kind: 'definitive', results: all(outcome.kind === 'delivered' ? { kind: 'temporary', text: 'unexpected reply to MAIL' } : outcome) };
    }

    const accepted: DeliveryRecipient[] = [];
    for (const r of request.recipients) {
      if (unsafeAddress(r.address)) {
        results[r.id] = { kind: 'permanent', code: 553, enhanced: '5.1.3', text: 'invalid recipient address' };
        continue;
      }
      const notify = caps.has('DSN') ? notifyWords(r.notify) : [];
      const params: RcptParams = notify.length > 0 ? { notify } : {};
      const rcpt = await conn.command('rcpt', `RCPT TO:<${r.address}>${formatRcptParams(params)}`, t.rcpt);
      if (rcpt.code >= 200 && rcpt.code < 300) accepted.push(r);
      else results[r.id] = classifyReply(rcpt);
    }
    if (accepted.length === 0) return { kind: 'definitive', results };

    const data = await conn.command('data', 'DATA', t.dataInit);
    if (data.code !== 354) {
      const outcome = classifyReply(data);
      const o: AttemptOutcome = outcome.kind === 'delivered' ? { kind: 'temporary', code: data.code, text: `unexpected reply to DATA: ${replyText(data)}` } : outcome;
      for (const r of accepted) results[r.id] = o;
      return { kind: 'definitive', results };
    }

    await streamBody(conn, request, t.dataBlock);
    const final = await conn.read('data-end', t.dataTerm);
    const outcome = classifyReply(final);
    for (const r of accepted) results[r.id] = outcome;
    return { kind: 'definitive', results };
  } catch (error) {
    // A failure mid-body must never be followed by the terminator: dropping the connection is what
    // tells the server to discard a partial message.
    const text = error instanceof SmtpClientError ? `${target.host} [${target.ip}] ${error.message}` : `${target.host} [${target.ip}] ${errorText(error)}`;
    conn.fail(error instanceof Error ? error : new Error(text));
    if (!inTransaction) return { kind: 'next', outcome: { kind: 'error', error: text } };
    return { kind: 'definitive', results: all({ kind: 'error', error: text }) };
  }
}

/** QUIT after the attempt resolved: nothing waits on it, but a failure is logged, never dropped. */
export function quitInBackground(conn: SmtpConnection, cfg: SessionConfig, fields: Record<string, unknown>): void {
  if (conn.failed !== null) return;
  conn.command('quit', 'QUIT', cfg.timeouts.quit).then(
    (reply) => {
      if (reply.code !== 221) cfg.log('quit-unexpected-reply', { ...fields, code: reply.code, text: replyText(reply) });
      conn.destroy('QUIT done');
    },
    (error: unknown) => {
      cfg.log('quit-failed', { ...fields, error: errorText(error) });
      conn.destroy('QUIT failed');
    },
  );
}
