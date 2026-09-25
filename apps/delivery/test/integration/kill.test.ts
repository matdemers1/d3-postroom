// doneWhen, second half: kill -9 mid-attempt delivers exactly once. The worker runs in a child
// process and talks SMTP over a real socket to a sink in this process. The sink stalls the first
// connection mid-DATA (it stops reading, so the child blocks on TCP backpressure part-way through
// the body), the child is SIGKILLed, a fresh child recovers the attempt once its lease is gone, and
// the sink must have completed exactly one message.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore } from '@postroom/blobstore';
import { exportKekBase64, generateKek } from '@postroom/crypto';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { enqueueOutbound } from '../../src/enqueue.js';
import { INTERRUPTED } from '../../src/worker.js';

const baseUrl = process.env['DATABASE_URL'];
const LEASE_MS = 2_500;
const ATTEMPT_TIMEOUT_MS = 2_000;
const appDir = join(import.meta.dirname, '..', '..');

interface Sink {
  server: Server;
  port: number;
  completed: number;
  connections: number;
  stalled: Promise<Socket>;
}

/** A tiny SMTP receiver. `completed` counts messages whose terminating CRLF.CRLF got a 250. */
async function startSink(): Promise<Sink> {
  let onStall: (s: Socket) => void = () => undefined;
  const sink: Sink = {
    server: createServer(),
    port: 0,
    completed: 0,
    connections: 0,
    stalled: new Promise<Socket>((resolve) => { onStall = resolve; }),
  };
  sink.server.on('connection', (sock) => {
    const n = ++sink.connections;
    sock.on('error', () => { sock.destroy(); });
    sock.setEncoding('latin1');
    sock.write('220 sink.test ESMTP\r\n');
    let mode: 'cmd' | 'data' = 'cmd';
    let line = '';
    let tail = '';
    sock.on('data', (chunk: string) => {
      if (mode === 'data') {
        if (n === 1) {
          // Mid-DATA: stop reading. The sender blocks part-way through the body, never at the end.
          sock.pause();
          onStall(sock);
          return;
        }
        const seen = tail + chunk;
        if (seen.endsWith('\r\n.\r\n')) {
          sink.completed++;
          mode = 'cmd';
          sock.write('250 2.0.0 queued\r\n');
        }
        tail = seen.slice(-4);
        return;
      }
      line += chunk;
      let nl: number;
      while ((nl = line.indexOf('\r\n')) >= 0) {
        const cmd = line.slice(0, nl).toUpperCase();
        line = line.slice(nl + 2);
        if (cmd.startsWith('DATA')) { mode = 'data'; tail = ''; sock.write('354 go ahead\r\n'); }
        else if (cmd.startsWith('QUIT')) { sock.end('221 bye\r\n'); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => { sink.server.listen(0, '127.0.0.1', resolve); });
  const addr = sink.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  sink.port = addr.port;
  return sink;
}

function spawnWorker(env: Record<string, string>): { child: ChildProcess; output: string[]; ready: Promise<void> } {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'test/integration/fixtures/worker-child.ts'], {
    cwd: appDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      output.push(d.toString());
      if (d.toString().includes('"event":"ready"')) resolve();
    });
    child.stderr.on('data', (d: Buffer) => { output.push(d.toString()); });
    child.on('exit', (code, signal) => { reject(new Error(`worker exited early (${String(code)} ${String(signal)}): ${output.join('')}`)); });
  });
  return { child, output, ready };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function kill(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => { resolve(); }));
  child.kill(signal);
  await exited;
}

describe.skipIf(baseUrl === undefined)('kill -9 mid-attempt', () => {
  let t: TestDatabase;
  let blobRoot: string;
  let sink: Sink;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t15');
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t15-blobs-'));
    sink = await startSink();
  }, 120_000);
  afterAll(async () => {
    for (const c of children) await kill(c, 'SIGKILL');
    await new Promise<void>((resolve) => { sink.server.close(() => { resolve(); }); sink.server.unref(); });
    await t.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('delivers exactly once', async () => {
    const kek = generateKek();
    const blobs = createBlobStore({ root: blobRoot, db: t.db, kek });
    // 4 MiB: far more than the socket buffers hold, so the stalled sender is really mid-body.
    const line = `${'x'.repeat(76)}\r\n`;
    const body = Buffer.from(`From: me@d3cloud.io\r\nTo: you@sink.test\r\nSubject: once\r\n\r\n${line.repeat(Math.ceil((4 << 20) / line.length))}`);
    const blob = await blobs.put(body);
    const account = await t.db.account.create({ data: { displayName: 'Sender' } });
    const { message } = await t.db.$transaction((tx) => enqueueOutbound(tx, {
      accountId: account.id,
      envelopeFrom: 'me@d3cloud.io',
      headerFrom: 'me@d3cloud.io',
      blobSha256: blob.sha256,
      size: blob.size,
      submittedVia: 'test',
      recipients: [{ address: 'you@sink.test' }],
    }));

    const env = {
      DATABASE_URL: t.url,
      BLOB_ROOT: blobRoot,
      POSTROOM_KEK: exportKekBase64(kek),
      SINK_PORT: String(sink.port),
      LEASE_MS: String(LEASE_MS),
      ATTEMPT_TIMEOUT_MS: String(ATTEMPT_TIMEOUT_MS),
    };

    // First worker: gets as far as the middle of DATA, then dies without warning.
    const first = spawnWorker(env);
    children.push(first.child);
    first.ready.catch(() => undefined);
    const stalledSocket = await sink.stalled;
    await kill(first.child, 'SIGKILL');
    stalledSocket.destroy();

    const recipient = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: message.id } });
    expect(recipient.state).toBe('attempting');
    const open = await t.db.deliveryAttempt.findMany({ where: { recipientId: recipient.id } });
    expect(open).toHaveLength(1);
    expect(open[0]?.finishedAt).toBeNull();
    expect(sink.completed).toBe(0);

    // Second worker: recovers the attempt once the lease is gone, and re-runs the job.
    const second = spawnWorker(env);
    children.push(second.child);
    await second.ready;
    const delivered = await waitFor('delivery', async () => {
      const r = await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
      return r.state === 'delivered' ? r : undefined;
    });
    // Give a duplicate every chance to show up before counting.
    await new Promise((r) => setTimeout(r, LEASE_MS + 500));

    expect(sink.completed).toBe(1);
    expect(sink.connections).toBe(2);
    expect(delivered.attempts).toBe(2);
    const attempts = await t.db.deliveryAttempt.findMany({ where: { recipientId: recipient.id }, orderBy: { startedAt: 'asc' } });
    expect(attempts.map((a) => [a.outcome, a.error])).toEqual([['error', INTERRUPTED], ['delivered', null]]);
    expect(attempts[1]?.remoteCode).toBe(250);
    expect(attempts.every((a) => a.finishedAt !== null)).toBe(true);
    expect((await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).state).toBe('delivered');
    await kill(second.child, 'SIGTERM');
  }, 60_000);
});
