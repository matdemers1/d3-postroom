// Session transcript capture, forever (PST-T-6.3, PST-REQ-117, PST-REQ-118).
//
// A recorder per connection taps the raw bytes the session engine reads from and writes to the
// socket (attachTranscriptTap monkeypatches `read`/`write`, so no protocol code in
// @postroom/smtp-proto is touched), buffers them as CRLF-delimited "C: "/"S: " lines up to a bound,
// redacts AUTH credentials before anything is buffered or published, and — at session end —
// compresses the buffer and writes one row, kept forever. DATA's body octets are never buffered:
// the caller marks `beginBody()`/`endBody(n)` around the hook that streams them, and a single
// summary line stands in for the message.
//
// Live view (PST-REQ-117): every redacted line is also published with Postgres NOTIFY on
// SMTP_LIVE_CHANNEL, since smtp-in/submission and the admin API are separate processes.
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { audited, type Actor } from '@postroom/audit';
import type { Db } from '@postroom/db';

export type TranscriptDaemon = 'smtp-in' | 'submission';
export type TranscriptDirection = 'C' | 'S';

export interface TranscriptEntry {
  readonly dir: TranscriptDirection;
  readonly line: string;
  readonly at: string;
}

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

/** Cap on the buffered (pre-compression) transcript per session. */
export const MAX_TRANSCRIPT_BYTES = 256 * 1024;
/** Headroom under Postgres's 8000-byte NOTIFY payload limit for the JSON envelope and identifiers. */
const NOTIFY_BUDGET_BYTES = 7_800;
const TRUNCATION_MARK = '[transcript truncated]';
export const SMTP_LIVE_CHANNEL = 'smtp_live';

const SYSTEM_ACTOR: Actor = { kind: 'system', label: 'smtp-transcript' };

const AUTH_COMMAND = /^AUTH(?:[ \t]|$)/i;
const SASL_MECHANISM = /^[A-Za-z0-9_-]{1,40}$/;
/** The last line of a reply: a code followed by a space, or a bare code. `250-` lines are not. */
const FINAL_REPLY_LINE = /^(\d{3})(?: |$)/;

/** What an AUTH command line is stored as: the verb, the mechanism if it looks like one, never more. */
function summarizeAuthCommand(line: string): string {
  const parts = line.trim().split(/[ \t]+/);
  const mechanism = parts[1];
  if (mechanism === undefined) return 'AUTH';
  const shown = SASL_MECHANISM.test(mechanism) ? mechanism : '[redacted]';
  return parts.length > 2 ? `AUTH ${shown} [redacted]` : `AUTH ${shown}`;
}

/**
 * Redacts AUTH command lines and every client line of the SASL exchange that follows (PST-REQ-117).
 * Mechanism names are kept; everything that could be (or lead to) a credential is not.
 *
 * The exchange starts on the client's AUTH line itself — not on the server's `334` — so a client
 * that pipelines `AUTH PLAIN\r\n<base64>\r\n` in one read, or whose chunks arrive in any order
 * relative to the replies, is redacted all the same. From the AUTH line on, every client line is
 * `[redacted]` (a lone `*` cancel is shown as `*`) until the server's final, non-334 reply *to a
 * line of the exchange* has been observed.
 *
 * Replies are matched to client lines by count: every client line (command or SASL continuation)
 * is answered by exactly one final reply line, the greeting answers nothing, and DATA's body
 * (`noteBody()`) is one more line answered by the post-body reply. A reply to a command sent before
 * the AUTH therefore never ends the exchange, however late it is observed. Every way the count can
 * be wrong in practice (lines the server discards unanswered, a body that never gets its reply)
 * counts too many client lines, which only keeps redaction on for longer: it fails closed. A line
 * that arrives before the exchange's end has been observed is redacted even if it turns out to be
 * the next command — also closed.
 */
export class AuthRedactor {
  /** Client lines (and bodies) seen so far; the next one gets this index. */
  private linesSeen = 0;
  /** Final replies matched to client lines so far; the next one answers this index. */
  private repliesSeen = 0;
  private greetingPending: boolean;
  /** Index of the AUTH line whose exchange is in progress, or null when none is. */
  private authFrom: number | null = null;
  /** AUTH command lines that arrived (and were redacted) while an exchange was in progress. */
  private queuedAuth: number[] = [];

  /** `expectGreeting`: the server's first reply is its greeting, which answers no client line. */
  constructor(options: { readonly expectGreeting?: boolean } = {}) {
    this.greetingPending = options.expectGreeting ?? true;
  }

  /** Whether client lines are currently being redacted. */
  get authInProgress(): boolean {
    return this.authFrom !== null;
  }

  redactIncoming(line: string): string {
    const index = this.linesSeen++;
    const isAuth = AUTH_COMMAND.test(line);
    if (this.authFrom !== null) {
      if (isAuth) this.queuedAuth.push(index);
      return line === '*' ? '*' : '[redacted]';
    }
    if (isAuth) {
      this.authFrom = index;
      return summarizeAuthCommand(line);
    }
    return line;
  }

  /** A client "line" that is never recorded but is answered: DATA's message body. */
  noteBody(): void {
    this.linesSeen++;
  }

  /** Called for every outgoing line, in order. Only final reply lines move the state. */
  observeOutgoing(line: string): void {
    const m = FINAL_REPLY_LINE.exec(line);
    if (m === null) return;
    if (this.greetingPending) {
      this.greetingPending = false;
      return;
    }
    // A reply with no client line outstanding (an unsolicited 421, say) answers nothing.
    if (this.repliesSeen >= this.linesSeen) return;
    const answered = this.repliesSeen++;
    if (this.authFrom === null || answered < this.authFrom) return;
    if (m[1] === '334') return;
    // The exchange is over. A later AUTH that arrived meanwhile (redacted) starts the next one.
    this.queuedAuth = this.queuedAuth.filter((i) => i > answered);
    this.authFrom = this.queuedAuth.shift() ?? null;
  }
}

export interface TranscriptRecorderOptions {
  readonly daemon: TranscriptDaemon;
  readonly sessionId: string;
  readonly clientIp: string;
  readonly db: Db;
  readonly log?: Logger;
  readonly now?: () => Date;
  /** Off in tests that do not want NOTIFY traffic. Default true. */
  readonly publishLive?: boolean;
}

/** One session's transcript: buffer, redact, publish live, and — once — store compressed. */
export class TranscriptRecorder {
  private readonly entries: TranscriptEntry[] = [];
  private readonly redactor = new AuthRedactor();
  private readonly startedAt: Date;
  private endedAt: Date | null = null;
  private bytes = 0;
  private truncated = false;
  private inBody = false;
  private incomingBuf = '';
  private outgoingBuf = '';
  private finished = false;

  constructor(private readonly opts: TranscriptRecorderOptions) {
    this.startedAt = this.nowFn();
  }

  private nowFn(): Date {
    return (this.opts.now ?? ((): Date => new Date()))();
  }

  /** Raw bytes pulled from the client socket in command mode. A no-op while `inBody`. */
  recordIncomingRaw(chunk: Buffer): void {
    if (this.inBody) return;
    this.incomingBuf += chunk.toString('latin1');
    for (;;) {
      const idx = this.incomingBuf.indexOf('\n');
      if (idx === -1) break;
      let line = this.incomingBuf.slice(0, idx);
      this.incomingBuf = this.incomingBuf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.push('C', this.redactor.redactIncoming(line));
    }
  }

  /** Raw bytes queued to the client socket (replies; never the message a client downloads). */
  recordOutgoingRaw(chunk: Buffer): void {
    this.outgoingBuf += chunk.toString('latin1');
    for (;;) {
      const idx = this.outgoingBuf.indexOf('\n');
      if (idx === -1) break;
      let line = this.outgoingBuf.slice(0, idx);
      this.outgoingBuf = this.outgoingBuf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.redactor.observeOutgoing(line);
      this.push('S', line);
    }
  }

  /** Call exactly when the DATA hook fires, before any body octet is read. */
  beginBody(): void {
    if (this.inBody) return;
    this.inBody = true;
    this.redactor.noteBody();
  }

  /** Call once the body stream has ended (or been destroyed), with the bytes actually seen. */
  endBody(byteCount: number): void {
    if (!this.inBody) return;
    this.inBody = false;
    this.push('C', `[message body: ${byteCount} bytes]`);
  }

  private push(dir: TranscriptDirection, line: string): void {
    const at = this.nowFn().toISOString();
    const entry: TranscriptEntry = { dir, line, at };
    if (!this.truncated) {
      const size = Buffer.byteLength(`${at}\t${dir}: ${line}\n`, 'utf8');
      if (this.bytes + size > MAX_TRANSCRIPT_BYTES) {
        this.truncated = true;
        this.entries.push({ dir: 'S', line: TRUNCATION_MARK, at });
      } else {
        this.entries.push(entry);
        this.bytes += size;
      }
    }
    if (this.opts.publishLive !== false) this.publish(entry);
  }

  private publish(entry: TranscriptEntry): void {
    let line = entry.line;
    if (Buffer.byteLength(line, 'utf8') > NOTIFY_BUDGET_BYTES) {
      line = `${Buffer.from(line, 'utf8').subarray(0, NOTIFY_BUDGET_BYTES).toString('utf8')}…`;
    }
    const payload = JSON.stringify({ daemon: this.opts.daemon, sessionId: this.opts.sessionId, dir: entry.dir, line, at: entry.at });
    this.opts.db.$executeRaw`SELECT pg_notify(${SMTP_LIVE_CHANNEL}, ${payload})`.catch((err: unknown) => {
      this.opts.log?.('transcript-publish-failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** The buffered transcript as text, `"{iso}\t{dir}: {line}"` per line — for tests and storage. */
  snapshotText(): string {
    return this.entries.map((e) => `${e.at}\t${e.dir}: ${e.line}`).join('\n') + (this.entries.length > 0 ? '\n' : '');
  }

  get lineCount(): number {
    return this.entries.length;
  }

  /**
   * Compresses and writes one row, kept forever (PST-REQ-118). Never throws: a failed write is
   * logged and the session is otherwise unaffected — this always runs after the session has ended,
   * so there is nothing left to delay or fail.
   */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.endedAt = this.nowFn();
    const text = this.snapshotText();
    const raw = Buffer.from(text, 'utf8');
    const compressed = gzipSync(raw);
    try {
      await audited(this.opts.db, SYSTEM_ACTOR, { action: 'smtp.transcript.store', entityType: 'smtp_transcript' }, async (tx) => {
        const row = await tx.smtpTranscript.create({
          data: {
            daemon: this.opts.daemon,
            sessionId: this.opts.sessionId,
            clientIp: this.opts.clientIp,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            lineCount: this.entries.length,
            rawBytes: raw.length,
            compressedBytes: compressed.length,
            compression: 'gzip',
            body: compressed,
          },
        });
        return {
          entityId: row.id,
          after: { daemon: row.daemon, sessionId: row.sessionId, lineCount: row.lineCount, compressedBytes: row.compressedBytes },
          result: undefined,
        };
      });
    } catch (err) {
      this.opts.log?.('transcript-store-failed', {
        error: err instanceof Error ? err.message : String(err),
        daemon: this.opts.daemon,
        sessionId: this.opts.sessionId,
      });
    }
  }
}

type ReadFn = (size?: number) => Buffer | string | null;
type WriteFn = (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;
interface Tappable {
  read: ReadFn;
  write: WriteFn;
}

/**
 * Monkeypatches a Duplex's `read`/`write` to also feed a recorder — one hook into the session
 * engine's own pull-based reads (`socket.read()`) and queued writes (`socket.write()`), with no
 * change to @postroom/smtp-proto. Safe to call again on a new socket after STARTTLS.
 */
export function attachTranscriptTap(socket: unknown, recorder: TranscriptRecorder): void {
  const target = socket as Tappable;
  const origRead = target.read.bind(target);
  target.read = ((size?: number): Buffer | string | null => {
    const result = origRead(size);
    if (result !== null) {
      try {
        recorder.recordIncomingRaw(Buffer.isBuffer(result) ? result : Buffer.from(result));
      } catch {
        // Never let transcript recording break the session.
      }
    }
    return result;
  });
  const origWrite = target.write.bind(target);
  target.write = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    try {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
        recorder.recordOutgoingRaw(buf);
      }
    } catch {
      // Never let transcript recording break the session.
    }
    return origWrite(chunk, encoding, cb);
  });
}

/** Decompresses a stored transcript back to its exact text (PST-T-6.3: byte for byte). */
export function decompressTranscript(row: { body: Uint8Array; compression: string }): string {
  const buf = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body);
  const raw = row.compression === 'br' ? brotliDecompressSync(buf) : gunzipSync(buf);
  return raw.toString('utf8');
}

/** Parses `snapshotText()`'s format back into entries, for the admin viewer. */
export function parseTranscriptText(text: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const tab = raw.indexOf('\t');
    const at = tab === -1 ? '' : raw.slice(0, tab);
    const rest = tab === -1 ? raw : raw.slice(tab + 1);
    const dir: TranscriptDirection = rest.startsWith('C: ') ? 'C' : 'S';
    const line = rest.startsWith('C: ') || rest.startsWith('S: ') ? rest.slice(3) : rest;
    out.push({ dir, line, at });
  }
  return out;
}
