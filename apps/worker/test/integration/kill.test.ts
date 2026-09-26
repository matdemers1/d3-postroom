// PST-REQ-060 / PST-REQ-061 across a real process boundary: the worker is SIGKILLed mid-pipeline —
// once inside the file stage's open transaction, once after the copies committed but before
// notify — and a fresh worker, after the dead one's lease runs out, files the message exactly once.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { exportKekBase64, generateKek, type Kek } from '@postroom/crypto';
import { InboundState, seed } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { readPipeline } from '../../src/stages/state.js';
import { STAGES } from '../../src/stages/types.js';
import { spool } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const LEASE_MS = 1_500;
const appDir = join(import.meta.dirname, '..', '..');

function spawnWorker(env: Record<string, string>): { child: ChildProcess; output: string[]; paused: Promise<void>; ready: Promise<void> } {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'test/integration/fixtures/worker-child.ts'], {
    cwd: appDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  let onPaused: () => void = () => undefined;
  let onReady: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => { onPaused = resolve; });
  const ready = new Promise<void>((resolve) => { onReady = resolve; });
  child.stdout.on('data', (d: Buffer) => {
    const s = d.toString();
    output.push(s);
    if (s.includes('"event":"paused"')) onPaused();
    if (s.includes('"event":"ready"')) onReady();
  });
  child.stderr.on('data', (d: Buffer) => { output.push(d.toString()); });
  return { child, output, paused, ready };
}

async function kill(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => { resolve(); }));
  child.kill(signal);
  await exited;
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

describe.skipIf(baseUrl === undefined)('kill -9 mid-pipeline', () => {
  let t: TestDatabase;
  let blobRoot = '';
  let blobs: BlobStore;
  let kek: Kek;
  let youId = '';
  let otherId = '';
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t27');
    await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    youId = (await t.db.account.create({ data: { displayName: 'You' } })).id;
    otherId = (await t.db.account.create({ data: { displayName: 'Other' } })).id;
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t27-kill-'));
    kek = generateKek();
    blobs = createBlobStore({ root: blobRoot, db: t.db, kek });
  }, 120_000);

  afterAll(async () => {
    for (const c of children) await kill(c, 'SIGKILL');
    await t.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  for (const pauseAt of ['file-tx', 'notify'] as const) {
    it(`killed at ${pauseAt}: filed exactly once after restart`, async () => {
      const { id, sha256, jobId } = await spool(t.db, blobs, {
        recipients: [{ rcpt: 'team@d3cloud.io', address: 'team@d3cloud.io', accountIds: [youId, otherId], kind: 'alias' }],
      });
      const env = { DATABASE_URL: t.url, BLOB_ROOT: blobRoot, POSTROOM_KEK: exportKekBase64(kek), LEASE_MS: String(LEASE_MS) };

      const first = spawnWorker({ ...env, PAUSE_AT: pauseAt });
      children.push(first.child);
      await first.paused;
      await kill(first.child, 'SIGKILL');

      const mid = await t.db.inboundMessage.findUniqueOrThrow({ where: { id } });
      expect(mid.state).toBe(InboundState.processing);
      expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('running');
      const copiesAtKill = await t.db.message.count({ where: { inboundMessageId: id } });
      // Inside the transaction: rolled back with the connection. After it: committed with its marker.
      expect(copiesAtKill).toBe(pauseAt === 'file-tx' ? 0 : 2);
      expect(Object.keys(readPipeline(mid.verdicts).stages)).toEqual(pauseAt === 'file-tx' ? ['verify', 'parse', 'classify', 'sieve'] : ['verify', 'parse', 'classify', 'sieve', 'file']);

      const second = spawnWorker(env);
      children.push(second.child);
      await second.ready;
      await waitFor('filed', async () => {
        const r = await t.db.inboundMessage.findUniqueOrThrow({ where: { id } });
        return r.state === InboundState.filed ? r : undefined;
      });
      // Give a duplicate every chance to appear before counting.
      await new Promise((r) => setTimeout(r, LEASE_MS + 500));

      const copies = await t.db.message.findMany({ where: { inboundMessageId: id }, include: { mailbox: true } });
      expect(copies.map((c) => c.mailbox.accountId).sort()).toEqual([youId, otherId].sort());
      expect((await t.db.blob.findUniqueOrThrow({ where: { sha256 } })).refcount).toBe(3);
      const done = await t.db.inboundMessage.findUniqueOrThrow({ where: { id } });
      expect(Object.keys(readPipeline(done.verdicts).stages)).toEqual([...STAGES]);
      const job = await t.db.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe('done');
      expect(job.attempts).toBe(2);
      await kill(second.child, 'SIGTERM');
    }, 60_000);
  }
});
