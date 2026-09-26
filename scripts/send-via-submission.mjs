#!/usr/bin/env node
// A small, dependency-free SMTP submission client — for ecosystem apps and the operator to send
// through one of Postroom's service mailboxes (PST-T-1.12 / PST-REQ-046). Copy this file into
// whatever app needs to send mail rather than depend on Postroom's internal packages: it only uses
// Node's built-in net/tls, and speaks the same AUTH PLAIN over implicit TLS (465, default) or
// STARTTLS (587) that every other submission client uses (protocols accept app passwords only —
// PST-REQ-027 — never the account password).
//
// Usage:
//   node send-via-submission.mjs \
//     --host mail.d3cloud.io --port 465 --user alerts@d3cloud.io --pass '<app password>' \
//     --from alerts@d3cloud.io --to ops@d3cloud.io --subject 'Build failed' --body 'See the log.' \
//     [--starttls] [--insecure]
//
// --starttls switches to port 587 semantics (plaintext connect, STARTTLS, then AUTH); --insecure
// disables certificate verification (self-signed test servers only — never in production).
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

function parseArgs(argv) {
  const out = { port: 465, starttls: false, insecure: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--host':
        out.host = next();
        break;
      case '--port':
        out.port = Number(next());
        break;
      case '--user':
        out.user = next();
        break;
      case '--pass':
        out.pass = next();
        break;
      case '--from':
        out.from = next();
        break;
      case '--to':
        out.to = next();
        break;
      case '--subject':
        out.subject = next();
        break;
      case '--body':
        out.body = next();
        break;
      case '--starttls':
        out.starttls = true;
        break;
      case '--insecure':
        out.insecure = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const required of ['host', 'user', 'pass', 'from', 'to', 'subject', 'body']) {
    if (out[required] === undefined) throw new Error(`missing --${required}`);
  }
  return out;
}

/** A minimal SMTP client: strict CRLF, multiline replies (`250-…` / `250 …`) collected in order. */
class SmtpClient {
  #buffer = '';
  #pendingLines = [];
  #queue = [];
  #waiter = null;
  #closed = false;
  #socket;

  constructor(socket) {
    this.#attach(socket);
  }

  #attach(socket) {
    this.#socket = socket;
    socket.on('data', (chunk) => {
      this.#buffer += chunk.toString('latin1');
      this.#drain();
    });
    socket.on('close', () => {
      this.#closed = true;
      this.#wake();
    });
    socket.on('error', () => {
      this.#closed = true;
      this.#wake();
    });
  }

  #drain() {
    for (;;) {
      const nl = this.#buffer.indexOf('\r\n');
      if (nl < 0) return;
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 2);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (m === null) continue;
      const [, code, sep, text] = m;
      this.#pendingLines.push(text);
      if (sep === ' ') {
        this.#queue.push({ code: Number(code), lines: this.#pendingLines });
        this.#pendingLines = [];
        this.#wake();
      }
    }
  }

  #wake() {
    const waiter = this.#waiter;
    this.#waiter = null;
    if (waiter) waiter();
  }

  async next() {
    for (;;) {
      const reply = this.#queue.shift();
      if (reply !== undefined) return reply;
      if (this.#closed) throw new Error('connection closed before a reply arrived');
      await new Promise((resolve) => {
        this.#waiter = resolve;
      });
    }
  }

  async send(line) {
    this.#socket.write(`${line}\r\n`, 'latin1');
    return this.next();
  }

  /** STARTTLS, then the TLS handshake over the same socket. */
  async startTls(rejectUnauthorized) {
    const reply = await this.send('STARTTLS');
    if (reply.code !== 220) return reply;
    const plain = this.#socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('close');
    plain.removeAllListeners('error');
    const secure = tlsConnect({ socket: plain, rejectUnauthorized });
    await once(secure, 'secureConnect');
    this.#buffer = '';
    this.#pendingLines = [];
    this.#queue = [];
    this.#attach(secure);
    return reply;
  }

  /** DATA, the message (dot-stuffed here), and the final reply. */
  async data(message) {
    const start = await this.send('DATA');
    if (start.code !== 354) return { start, final: null };
    const stuffed = message.replace(/(^|\r\n)\./g, '$1..');
    this.#socket.write(`${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`, 'latin1');
    return { start, final: await this.next() };
  }

  /** Destroy rather than a graceful `end()`: this script is exiting either way, and a half-closed
   * socket waiting on the server's own FIN would otherwise keep the process alive indefinitely. */
  close() {
    this.#socket.destroy();
  }
}

function expectCode(reply, code, step) {
  if (reply.code !== code) throw new Error(`${step}: expected ${code}, got ${reply.code} ${reply.lines.join(' ')}`);
}

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function formatDate(date) {
  return date.toUTCString().replace('GMT', '+0000');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rejectUnauthorized = !args.insecure;

  let socket;
  if (args.starttls) {
    socket = createConnection({ host: args.host, port: args.port });
    await once(socket, 'connect');
  } else {
    socket = tlsConnect({ host: args.host, port: args.port, rejectUnauthorized });
    await once(socket, 'secureConnect');
  }
  const client = new SmtpClient(socket);

  // However this ends, the socket must close: an open connection would otherwise leave this
  // process's event loop with an active handle and it would never exit, success or failure.
  try {
    expectCode(await client.next(), 220, 'connect');
    expectCode(await client.send(`EHLO ${args.host}`), 250, 'EHLO');
    if (args.starttls) {
      expectCode(await client.startTls(rejectUnauthorized), 220, 'STARTTLS');
      expectCode(await client.send(`EHLO ${args.host}`), 250, 'EHLO (secure)');
    }

    expectCode(await client.send(`AUTH PLAIN ${b64(`\0${args.user}\0${args.pass}`)}`), 235, 'AUTH PLAIN');
    expectCode(await client.send(`MAIL FROM:<${args.from}>`), 250, 'MAIL FROM');
    expectCode(await client.send(`RCPT TO:<${args.to}>`), 250, 'RCPT TO');

    const body = args.body.replace(/\r\n|\r|\n/g, '\r\n');
    const message = [
      `From: <${args.from}>`,
      `To: <${args.to}>`,
      `Subject: ${args.subject}`,
      `Date: ${formatDate(new Date())}`,
      '',
      body,
      '',
    ].join('\r\n');

    const { final } = await client.data(message);
    if (final === null || final.code !== 250) {
      throw new Error(`DATA: expected 250, got ${final ? `${String(final.code)} ${final.lines.join(' ')}` : 'no reply'}`);
    }
    await client.send('QUIT');
    process.stdout.write(`250 ${final.lines.join(' ')}\n`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
