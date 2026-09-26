// Test support for the direct MX client, in the spirit of transports/fake.ts: a scriptable loopback
// MX (node:net, optional STARTTLS) that records the client's source address, the full transcript
// and the unstuffed body; and an in-memory Resolver. Not used by the daemon.
import net from 'node:net';
import tls from 'node:tls';
import { DnsServfailError, RCode, RRType, type DnsAnswer, type Resolver, type ResolverResult } from '@postroom/dns';

export type FakeMxStep = 'greeting' | 'ehlo' | 'starttls' | 'mail' | 'rcpt' | 'data' | 'final';

export interface FakeMxScript {
  /** Greeting reply line(s), without CRLF. Default '220 fake.mx.test ESMTP'. */
  greeting?: string[];
  /** EHLO capability keywords; `secure` is true after STARTTLS. STARTTLS is added when TLS is configured and not yet secure. */
  capabilities?: (secure: boolean) => string[];
  /** Reply to EHLO instead of the capability list (e.g. '502 5.5.1 no EHLO here'). */
  ehloReply?: string;
  mail?: (from: string) => string;
  rcpt?: (to: string) => string;
  data?: string;
  final?: (session: FakeMxSession) => string;
  delayMs?: Partial<Record<FakeMxStep, number>>;
  /** Pause the socket for this long after every DATA chunk: a slow reader, so backpressure builds. */
  throttleMs?: number;
  /** Keep at most this many body bytes as text (the byte count is always exact). Default 1 MiB. */
  keepBodyBytes?: number;
  /** Smarthost mode (the SES fallback): AUTH is advertised and required before MAIL. */
  auth?: FakeMxAuth;
}

export interface FakeMxAuth {
  user: string;
  password: string;
  /** Default ['PLAIN', 'LOGIN']. */
  mechanisms?: string[];
  /** Also advertise AUTH before STARTTLS (as a careless server might), to prove the client still waits. */
  advertiseInPlaintext?: boolean;
  /** Reply to a correct credential instead of '235 2.7.0 Authentication successful' (e.g. a 454). */
  reply?: string;
}

export interface FakeMxTls {
  key: string | Buffer;
  cert: string | Buffer;
  minVersion?: tls.SecureVersion;
  maxVersion?: tls.SecureVersion;
}

export interface FakeMxSession {
  /** The client's address as the MX saw it: on the real path, the Lightsail edge's static IP. */
  remoteAddress: string | undefined;
  transcript: string[];
  secure: boolean;
  tlsProtocol: string | null;
  mailFrom: string | null;
  rcptTo: string[];
  /** Body bytes after unstuffing, counting CRLFs. */
  bodyBytes: number;
  body: string;
  /** True once the terminating '.' line was received. */
  dataComplete: boolean;
  /** The user that authenticated (smarthost mode), and whether any AUTH command arrived before TLS. */
  authUser: string | null;
  authInPlaintext: boolean;
  /** Body bytes exactly as received after unstuffing (up to keepBodyBytes), for byte comparisons. */
  bodyBuffer: () => Buffer;
  closed: Promise<void>;
}

export interface FakeMx {
  port: number;
  sessions: FakeMxSession[];
  close: () => Promise<void>;
}

const CRLF = Buffer.from('\r\n');

export async function startFakeMx(script: FakeMxScript = {}, tlsConfig?: FakeMxTls): Promise<FakeMx> {
  const sessions: FakeMxSession[] = [];
  const sockets = new Set<net.Socket>();
  const keep = script.keepBodyBytes ?? 1024 * 1024;

  const server = net.createServer((plain) => {
    sockets.add(plain);
    const bodyChunks: Buffer[] = [];
    let bodyKept = 0;
    /** AUTH LOGIN in progress: the next line is the username, then the password. */
    let loginStep: 'user' | 'password' | null = null;
    let loginUser = '';
    let closedResolve: () => void = () => undefined;
    const session: FakeMxSession = {
      remoteAddress: plain.remoteAddress,
      transcript: [],
      secure: false,
      tlsProtocol: null,
      mailFrom: null,
      rcptTo: [],
      bodyBytes: 0,
      body: '',
      dataComplete: false,
      authUser: null,
      authInPlaintext: false,
      bodyBuffer: () => Buffer.concat(bodyChunks),
      closed: new Promise<void>((resolve) => { closedResolve = resolve; }),
    };
    sessions.push(session);
    plain.on('close', () => { sockets.delete(plain); closedResolve(); });
    plain.on('error', (error) => { session.transcript.push(`!! ${error.message}`); });

    let socket: net.Socket = plain;
    let pending: Buffer = Buffer.alloc(0);
    let inData = false;
    let busy = Promise.resolve();

    const write = (lines: string[]): void => {
      for (const line of lines) session.transcript.push(`S: ${line}`);
      if (!socket.destroyed) socket.write(lines.map((l) => `${l}\r\n`).join(''));
    };
    const later = (step: FakeMxStep, lines: string[]): void => {
      const ms = script.delayMs?.[step] ?? 0;
      busy = busy.then(() => new Promise<void>((resolve) => {
        setTimeout(() => { write(lines); resolve(); }, ms);
      }));
    };

    const onLine = (raw: Buffer): void => {
      if (inData) {
        const line = raw.toString('latin1');
        if (line === '.') {
          inData = false;
          session.dataComplete = true;
          session.transcript.push('C: .');
          later('final', [script.final?.(session) ?? '250 2.0.0 queued as FAKE']);
          return;
        }
        const text = line.startsWith('.') ? line.slice(1) : line;
        if (bodyKept < keep) {
          const bytes = Buffer.concat([raw.subarray(line.startsWith('.') ? 1 : 0), CRLF]);
          bodyChunks.push(bytes);
          bodyKept += bytes.length;
        }
        session.bodyBytes += text.length + 2;
        if (session.body.length < keep) session.body += `${text}\r\n`;
        return;
      }
      const line = raw.toString('utf8');
      session.transcript.push(`C: ${line}`);
      const auth = script.auth;
      const finishAuth = (user: string, password: string): void => {
        if (auth !== undefined && user === auth.user && password === auth.password) {
          const reply = auth.reply ?? '235 2.7.0 Authentication successful';
          if (reply.startsWith('235')) session.authUser = user;
          later('mail', [reply]);
        } else {
          later('mail', ['535 5.7.8 Authentication credentials invalid']);
        }
      };
      if (loginStep !== null) {
        const decoded = Buffer.from(line, 'base64').toString('utf8');
        if (loginStep === 'user') {
          loginUser = decoded;
          loginStep = 'password';
          later('mail', ['334 UGFzc3dvcmQ6']);
        } else {
          loginStep = null;
          finishAuth(loginUser, decoded);
        }
        return;
      }
      const verb = line.split(' ', 1)[0]?.toUpperCase() ?? '';
      if (verb === 'EHLO') {
        if (script.ehloReply !== undefined) {
          later('ehlo', [script.ehloReply]);
          return;
        }
        const caps = [...(script.capabilities?.(session.secure) ?? ['8BITMIME'])];
        if (tlsConfig !== undefined && !session.secure) caps.push('STARTTLS');
        if (script.auth !== undefined && (session.secure || script.auth.advertiseInPlaintext === true)) caps.push(`AUTH ${(script.auth.mechanisms ?? ['PLAIN', 'LOGIN']).join(' ')}`);
        const lines = ['fake.mx.test hello', ...caps];
        later('ehlo', lines.map((l, i) => `250${i === lines.length - 1 ? ' ' : '-'}${l}`));
      } else if (verb === 'HELO') {
        later('ehlo', ['250 fake.mx.test']);
      } else if (verb === 'STARTTLS' && tlsConfig !== undefined && !session.secure) {
        busy = busy.then(() => {
          write(['220 2.0.0 ready to start TLS']);
          plain.off('data', onData);
          const secure = new tls.TLSSocket(plain, {
            isServer: true,
            key: tlsConfig.key,
            cert: tlsConfig.cert,
            ...(tlsConfig.minVersion === undefined ? {} : { minVersion: tlsConfig.minVersion }),
            ...(tlsConfig.maxVersion === undefined ? {} : { maxVersion: tlsConfig.maxVersion }),
          });
          secure.on('secure', () => {
            session.secure = true;
            session.tlsProtocol = secure.getProtocol();
          });
          secure.on('error', (error: Error) => { session.transcript.push(`!! tls ${error.message}`); });
          secure.on('data', onData);
          socket = secure;
          pending = Buffer.alloc(0);
        });
      } else if (verb === 'AUTH' && auth !== undefined) {
        if (!session.secure) session.authInPlaintext = true;
        const [, mechanism = '', initial] = line.split(' ');
        const offered = (auth.mechanisms ?? ['PLAIN', 'LOGIN']).map((m) => m.toUpperCase());
        if (!offered.includes(mechanism.toUpperCase())) {
          later('mail', ['504 5.5.4 mechanism not supported']);
        } else if (mechanism.toUpperCase() === 'PLAIN') {
          const [, user = '', password = ''] = Buffer.from(initial ?? '', 'base64').toString('utf8').split('\0');
          finishAuth(user, password);
        } else {
          loginStep = 'user';
          later('mail', ['334 VXNlcm5hbWU6']);
        }
      } else if (verb === 'MAIL' && auth !== undefined && session.authUser === null) {
        later('mail', ['530 5.7.0 Authentication required']);
      } else if (verb === 'MAIL') {
        session.mailFrom = line;
        later('mail', [script.mail?.(line) ?? '250 2.1.0 ok']);
      } else if (verb === 'RCPT') {
        const to = /<([^>]*)>/.exec(line)?.[1] ?? '';
        const reply = script.rcpt?.(to) ?? '250 2.1.5 ok';
        if (reply.startsWith('2')) session.rcptTo.push(to);
        later('rcpt', [reply]);
      } else if (verb === 'DATA') {
        const reply = script.data ?? '354 go ahead';
        if (reply.startsWith('354')) inData = true;
        later('data', [reply]);
      } else if (verb === 'QUIT') {
        busy = busy.then(() => { write(['221 2.0.0 bye']); socket.end(); });
      } else if (verb === 'RSET' || verb === 'NOOP') {
        later('mail', ['250 2.0.0 ok']);
      } else {
        later('mail', ['502 5.5.2 not implemented']);
      }
    };

    const onData = (chunk: Buffer): void => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let start = 0;
      for (;;) {
        const end = pending.indexOf(CRLF, start);
        if (end < 0) break;
        onLine(pending.subarray(start, end));
        start = end + 2;
      }
      pending = pending.subarray(start);
      if (inData && script.throttleMs !== undefined) {
        socket.pause();
        setTimeout(() => { socket.resume(); }, script.throttleMs);
      }
    };

    plain.on('data', onData);
    later('greeting', script.greeting ?? ['220 fake.mx.test ESMTP']);
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake MX did not bind a TCP port');
  return {
    port: address.port,
    sessions,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => { resolve(); });
    }),
  };
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export interface FakeDns {
  /** Domain → MX records ('.' with preference 0 is a null MX), or a failure. Absent = NOERROR, no MX. */
  mx?: Record<string, { preference: number; exchange: string }[] | 'nxdomain' | 'servfail'>;
  a?: Record<string, string[]>;
  aaaa?: Record<string, string[]>;
}

export interface FakeResolver extends Resolver {
  queries: { type: 'MX' | 'A' | 'AAAA'; name: string }[];
}

export function fakeResolver(dns: FakeDns): FakeResolver {
  const queries: FakeResolver['queries'] = [];
  const ok = (answers: DnsAnswer[]): ResolverResult => ({ rcode: RCode.NOERROR, ad: false, answers, authority: [] });
  const unsupported = (): Promise<ResolverResult> => Promise.reject(new Error('fakeResolver: not scripted'));
  return {
    queries,
    query: unsupported,
    txt: unsupported,
    tlsa: unsupported,
    ptr: unsupported,
    mx: (name) => {
      queries.push({ type: 'MX', name });
      const entry = dns.mx?.[name];
      if (entry === 'servfail') return Promise.reject(new DnsServfailError(name, RRType.MX));
      if (entry === 'nxdomain') return Promise.resolve({ rcode: RCode.NXDOMAIN, ad: false, answers: [], authority: [] });
      return Promise.resolve(ok((entry ?? []).map((r) => ({ name, ttl: 300, type: RRType.MX, class: 1, kind: 'MX' as const, preference: r.preference, exchange: r.exchange }))));
    },
    a: (name) => {
      queries.push({ type: 'A', name });
      return Promise.resolve(ok((dns.a?.[name] ?? []).map((address) => ({ name, ttl: 300, type: RRType.A, class: 1, kind: 'A' as const, address }))));
    },
    aaaa: (name) => {
      queries.push({ type: 'AAAA', name });
      return Promise.resolve(ok((dns.aaaa?.[name] ?? []).map((address) => ({ name, ttl: 300, type: RRType.AAAA, class: 1, kind: 'AAAA' as const, address }))));
    },
  };
}
