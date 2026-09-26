// PST-T-1.3 doneWhen, at the protocol level: "a generated password authenticates over submission;
// revocation takes effect immediately". A real TCP loopback socket, the real SMTP session engine
// from @postroom/smtp-proto, and an onAuth hook that does what the submission daemon (PST-T-1.2)
// will do — decode SASL PLAIN / LOGIN and call verifyProtocolLogin with scope 'smtp'.
import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import {
  ReplyParser,
  createServerSession,
  reply,
  type AuthResult,
  type SaslExchange,
  type SmtpReply,
} from '@postroom/smtp-proto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppPassword, revokeAppPassword, verifyProtocolLogin } from '../../src/index.js';
import { OPERATOR, PEPPER, makeAccount } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8');
const BAD_CREDENTIALS = reply(535, '5.7.8', 'Authentication credentials invalid');

/** Decode the SASL exchange into (username, password); null when malformed. */
async function credentials(
  req: { mechanism: string; initialResponse: string | undefined },
  sasl: SaslExchange,
): Promise<{ username: string; password: string } | null> {
  if (req.mechanism === 'PLAIN') {
    const [, username, password] = unb64(req.initialResponse ?? (await sasl.challenge(''))).split('\0');
    return username === undefined || password === undefined ? null : { username, password };
  }
  const username = unb64(req.initialResponse ?? (await sasl.challenge(b64('Username:'))));
  const password = unb64(await sasl.challenge(b64('Password:')));
  return { username, password };
}

/** A line-oriented SMTP client over a real socket. */
class Client {
  private readonly parser = new ReplyParser();
  private readonly queue: SmtpReply[] = [];
  private waiter: (() => void) | null = null;
  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.queue.push(...this.parser.push(chunk));
      const w = this.waiter;
      this.waiter = null;
      w?.();
    });
  }

  static async connect(port: number): Promise<Client> {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    return new Client(socket);
  }

  async next(): Promise<SmtpReply> {
    for (;;) {
      const r = this.queue.shift();
      if (r !== undefined) return r;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  async send(line: string): Promise<SmtpReply> {
    this.socket.write(`${line}\r\n`);
    return this.next();
  }

  close(): void {
    this.socket.destroy();
  }
}

describe.skipIf(!baseUrl)('an app password over SMTP submission AUTH (PST-T-1.3 doneWhen)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let server: Server;
  let port = 0;
  const identities: string[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t13');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    server = createServer((socket) => {
      createServerSession(socket, {
        hostname: 'mail.d3cloud.io',
        maxSize: 1_000_000,
        remoteAddress: socket.remoteAddress ?? '',
        // Test only: loopback plaintext. Production submission requires TLS before AUTH (the
        // engine's default, authRequiresTls: true) — 465 is implicit TLS, 587 needs STARTTLS.
        capabilities: { auth: ['PLAIN', 'LOGIN'], authRequiresTls: false },
        hooks: {
          onAuth: async (req, sasl, ctx): Promise<AuthResult> => {
            const creds = await credentials(req, sasl);
            if (creds === null) return { ok: false, reply: reply(501, '5.5.2', 'Malformed credentials') };
            const result = await verifyProtocolLogin(
              db,
              { username: creds.username, password: creds.password, scope: 'smtp', ip: ctx.remoteAddress ?? null },
              { pepper: PEPPER },
            );
            if (!result.ok) return { ok: false, reply: BAD_CREDENTIALS };
            identities.push(result.accountId);
            return { ok: true, identity: creds.username };
          },
          onRcpt: () => reply(250, '2.1.5', 'OK'),
          onData: () => reply(250, '2.0.0', 'OK'),
        },
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    server.close();
    await testDb.drop();
  });

  const greet = async (): Promise<Client> => {
    const client = await Client.connect(port);
    expect((await client.next()).code).toBe(220);
    const ehlo = await client.send('EHLO client.example');
    expect(ehlo.code).toBe(250);
    expect(ehlo.lines).toContain('AUTH PLAIN LOGIN');
    return client;
  };

  const authPlain = async (username: string, password: string): Promise<SmtpReply> => {
    const client = await greet();
    try {
      return await client.send(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`);
    } finally {
      client.close();
    }
  };

  it('AUTH PLAIN with a generated password → 235; after revocation the very next AUTH → 535 5.7.8', async () => {
    const acct = await makeAccount(db);
    const { password, appPassword } = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'Mail.app', scopes: ['smtp'] }, { pepper: PEPPER });

    const ok = await authPlain(acct.address, password);
    expect(ok).toMatchObject({ code: 235, enhanced: '2.7.0' });
    expect(identities.at(-1)).toBe(acct.id);
    expect((await db.appPassword.findUniqueOrThrow({ where: { id: appPassword.id } })).lastUsedIp).toBe('127.0.0.1');

    // Authenticated sessions can submit: MAIL is accepted after 235.
    const client = await greet();
    expect((await client.send(`AUTH PLAIN ${b64(`\0${acct.address}\0${password}`)}`)).code).toBe(235);
    expect((await client.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    client.close();

    await revokeAppPassword(db, OPERATOR, { id: appPassword.id, accountId: acct.id });
    expect(await authPlain(acct.address, password)).toMatchObject({ code: 535, enhanced: '5.7.8' });
  });

  it('AUTH LOGIN with a generated password → 235, then 535 once revoked', async () => {
    const acct = await makeAccount(db);
    const { password, appPassword } = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'Phone', scopes: ['smtp', 'imap'] }, { pepper: PEPPER });
    const run = async (): Promise<SmtpReply> => {
      const client = await greet();
      try {
        expect(await client.send('AUTH LOGIN')).toMatchObject({ code: 334, lines: [b64('Username:')] });
        expect(await client.send(b64(acct.address))).toMatchObject({ code: 334, lines: [b64('Password:')] });
        return await client.send(b64(password));
      } finally {
        client.close();
      }
    };
    expect((await run()).code).toBe(235);
    await revokeAppPassword(db, OPERATOR, { id: appPassword.id });
    expect(await run()).toMatchObject({ code: 535, enhanced: '5.7.8' });
  });

  it('refuses the account’s web password and a password without the smtp scope', async () => {
    const acct = await makeAccount(db);
    const imapOnly = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'IMAP', scopes: ['imap'] }, { pepper: PEPPER });
    expect((await authPlain(acct.address, acct.webPassword)).code).toBe(535);
    expect((await authPlain(acct.address, imapOnly.password)).code).toBe(535);
  });
});
