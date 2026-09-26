// The IMAP client the import runs on (PST-T-10.2, PST-REQ-152): hand-rolled over node:tls, one
// command at a time, reading responses with @postroom/imap-proto's StreamingResponseReader so a
// FETCH BODY[] literal streams straight through to its consumer and is never held whole.
//
// TLS is always on (implicit TLS, RFC 8314) and always verified: the system CAs and the host name,
// or — for a home server with a self-signed certificate — ONE pinned SHA-256 fingerprint the user
// supplied, compared before a single byte is written. There is no "accept anything" mode. Without
// a pin, a refused certificate is reported with its reason but not its fingerprint: the user must
// get the fingerprint from the server itself (openssl x509 -fingerprint -sha256), never by copying
// whatever a possibly-intercepted connection presented.
//
// Credentials go to the socket and nowhere else: no command text is ever logged or put into an
// error message.
import { isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { StreamingResponseReader, respText, type ParsedResponse, type ResponseStreamEvent, type RespValue } from '@postroom/imap-proto';
import { canonicalFingerprint, type Astring } from './names.js';

export type ImportErrorKind = 'certificate' | 'auth' | 'connect' | 'protocol' | 'config';

/** A failure the import reports to its owner. `permanent` ones are not retried. */
export class ImportError extends Error {
  constructor(
    readonly kind: ImportErrorKind,
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImapConnectOptions {
  readonly host: string;
  readonly port: number;
  /** Canonical (64 upper-case hex) SHA-256 fingerprint to trust instead of the CA chain, or null. */
  readonly pinnedFingerprint: string | null;
  /** Extra trust anchors, for tests (a test CA); production uses the system store. */
  readonly ca?: ConnectionOptions['ca'];
  readonly connectTimeoutMs?: number;
  /** A silent server this long is a dead one. */
  readonly idleTimeoutMs?: number;
}

export type StatusResponse = Extract<ParsedResponse, { kind: 'status' }>;

/** A command part: raw text, or an astring (which may need to go as a literal). */
export type CommandPart = string | Astring;

/** Upper-case capability names, from a CAPABILITY response or response code. */
export function capabilitiesOf(values: readonly RespValue[]): Set<string> {
  const caps = new Set<string>();
  for (const v of values) {
    const t = respText(v);
    if (t !== null) caps.add(t.toUpperCase());
  }
  return caps;
}

function tlsError(err: Error & { code?: string }, host: string): ImportError {
  const code = err.code ?? '';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new ImportError('certificate', `The certificate of ${host} is not for that name. If this is your own server, pin its SHA-256 fingerprint.`, true);
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO|ISSUER|EXPIRED/.test(code)) {
    return new ImportError(
      'certificate',
      `The certificate of ${host} is not trusted (${code}). If this is your own server with a self-signed certificate, pin its SHA-256 fingerprint (openssl x509 -noout -fingerprint -sha256).`,
      true,
    );
  }
  return new ImportError('connect', `Could not connect to ${host}: ${code === '' ? err.message : code}`, false);
}

export class ImapImportClient {
  capabilities = new Set<string>();
  private readonly reader = new StreamingResponseReader({
    streamLiteralsFrom: 16 * 1024,
    maxLineLength: 1024 * 1024,
    maxLiteralSize: 1024 * 1024,
    maxResponseSize: 16 * 1024 * 1024,
  });
  private readonly chunks: AsyncIterator<Buffer>;
  private n = 0;
  private closed = false;

  private constructor(private readonly socket: TLSSocket) {
    this.chunks = (socket as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }

  /** Connects, verifies the certificate (CA + name, or the pin), and reads the greeting. */
  static async connect(o: ImapConnectOptions): Promise<ImapImportClient> {
    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({
        host: o.host,
        port: o.port,
        ...(isIP(o.host) === 0 ? { servername: o.host } : {}),
        minVersion: 'TLSv1.2',
        // Verified by Node against the CAs unless the user pinned a fingerprint — then verified
        // here, against that pin only, before anything is written (below).
        rejectUnauthorized: o.pinnedFingerprint === null,
        ...(o.ca === undefined ? {} : { ca: o.ca }),
      });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new ImportError('connect', `Timed out connecting to ${o.host}:${String(o.port)}`, false));
      }, o.connectTimeoutMs ?? 30_000);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        s.off('error', onError);
        if (o.pinnedFingerprint !== null) {
          const presented = canonicalFingerprint(s.getPeerCertificate().fingerprint256);
          if (presented !== o.pinnedFingerprint) {
            s.destroy();
            reject(new ImportError('certificate', `The certificate of ${o.host} does not match the pinned fingerprint.`, true));
            return;
          }
        }
        resolve(s);
      });
      const onError = (err: Error): void => {
        clearTimeout(timer);
        reject(tlsError(err, o.host));
      };
      s.once('error', onError);
    });
    socket.setTimeout(o.idleTimeoutMs ?? 300_000, () => socket.destroy(new Error('the source server went silent')));
    socket.on('error', () => undefined); // surfaced through the iterator
    const client = new ImapImportClient(socket);
    const greeting = await client.nextResponse();
    if (greeting.kind !== 'status' || greeting.tag !== null || (greeting.status !== 'OK' && greeting.status !== 'PREAUTH')) {
      client.close();
      throw new ImportError('protocol', `${o.host} did not greet like an IMAP server`, false);
    }
    if (greeting.code?.name === 'CAPABILITY') client.capabilities = capabilitiesOf(greeting.code.args);
    return client;
  }

  /** The next event off the wire; throws when the connection ends. */
  async nextEvent(): Promise<ResponseStreamEvent> {
    for (;;) {
      const ev = this.reader.next();
      if (ev !== null) {
        if (ev.type === 'response' && ev.response.kind === 'error') {
          throw new ImportError('protocol', `unparseable response from the source: ${ev.response.message}`, false);
        }
        return ev;
      }
      let chunk: IteratorResult<Buffer>;
      try {
        chunk = await this.chunks.next();
      } catch (err) {
        throw new ImportError('connect', `connection to the source failed: ${err instanceof Error ? err.message : String(err)}`, false);
      }
      if (chunk.done === true) throw new ImportError('connect', 'the source server closed the connection', false);
      this.reader.push(chunk.value);
    }
  }

  /** The next whole response, for commands that never carry big literals. */
  async nextResponse(): Promise<ParsedResponse> {
    for (;;) {
      const ev = await this.nextEvent();
      if (ev.type === 'response') return ev.response;
      if (ev.type === 'literal-start') throw new ImportError('protocol', 'unexpected large literal from the source', false);
    }
  }

  /**
   * Sends one command and returns its tag. An astring that must go as a literal uses LITERAL+ (or
   * LITERAL- up to 4096 octets) when advertised, else waits for the server's continuation.
   */
  async send(parts: readonly CommandPart[]): Promise<string> {
    const tag = `i${String(++this.n)}`;
    let text = `${tag} `;
    for (const part of parts) {
      if (typeof part === 'string') {
        text += part;
      } else if (part.kind === 'text') {
        text += part.value;
      } else {
        const size = part.value.length;
        const nonSync = this.capabilities.has('LITERAL+') || (this.capabilities.has('LITERAL-') && size <= 4096);
        this.write(Buffer.from(`${text}{${String(size)}${nonSync ? '+' : ''}}\r\n`, 'utf8'));
        if (!nonSync) {
          const r = await this.nextResponse();
          if (r.kind !== 'continuation') throw new ImportError('protocol', 'the source refused a literal', false);
        }
        this.write(part.value);
        text = '';
      }
    }
    this.write(Buffer.from(`${text}\r\n`, 'utf8'));
    return tag;
  }

  /**
   * Sends `<tag> <text><secret>` as one write — AUTHENTICATE PLAIN with its initial response
   * (SASL-IR). `secret` carries its own CRLF; the caller zeroes it afterwards.
   */
  sendWithSecret(text: string, secret: Buffer): string {
    const tag = `i${String(++this.n)}`;
    const line = Buffer.concat([Buffer.from(`${tag} ${text}`, 'utf8'), secret]);
    this.write(line);
    line.fill(0);
    return tag;
  }

  /** Runs one command whose responses are all small; untagged ones go to `onUntagged`. */
  async command(parts: readonly CommandPart[], onUntagged: (r: ParsedResponse) => void = () => undefined): Promise<StatusResponse> {
    const tag = await this.send(parts);
    return this.untilTagged(tag, onUntagged);
  }

  async untilTagged(tag: string, onUntagged: (r: ParsedResponse) => void = () => undefined): Promise<StatusResponse> {
    for (;;) {
      const r = await this.nextResponse();
      if (r.kind === 'status' && r.tag === tag) return r;
      if (r.kind === 'status' && r.status === 'BYE') throw new ImportError('connect', `the source server said goodbye: ${r.text}`, false);
      onUntagged(r);
    }
  }

  /** Writes raw bytes (a SASL response). */
  write(bytes: Buffer): void {
    if (this.closed) throw new ImportError('connect', 'the connection to the source is closed', false);
    this.socket.write(bytes);
  }

  async logout(): Promise<void> {
    try {
      await Promise.race([this.command(['LOGOUT']), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    } catch {
      // Best effort: the import is already committed.
    }
    this.close();
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}
