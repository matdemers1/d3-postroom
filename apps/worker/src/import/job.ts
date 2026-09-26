// The IMAP import (PST-T-10.2, PST-REQ-152): folders from another IMAP server into one account,
// with progress, and resume after interruption that never files a message twice.
//
// Queue 'import', payload `{ accountId }`; the job id is the import id. The API wrote the import's
// parameters (state.ts: `import-state.<id>`) and its sealed password (`import-secret.<id>`) in the
// transaction that enqueued the job. This handler:
//
//   1. connects over verified TLS (client.ts), authenticates (AUTHENTICATE PLAIN, else LOGIN),
//      and LISTs the source's folders — every selectable one, or those the owner named;
//   2. maps each onto our mailbox of the same name, or our special-use mailbox for \Sent,
//      \Drafts, \Trash, \Junk and \Archive (names.ts);
//   3. per folder: EXAMINE (read-only; UIDVALIDITY and EXISTS), `UID FETCH lastUid+1:* (UID)`
//      for the UIDs still to do, then `UID FETCH <batch> (UID FLAGS INTERNALDATE BODY.PEEK[])`;
//   4. streams each BODY[] literal, as it arrives, into BOTH the blob store and the MIME
//      summariser — one pass, nothing held whole — inside one transaction per message that also
//      dedupes, files it (fileLocalMessage) with its flags and INTERNALDATE, indexes it for
//      search, and rewrites the folder's progress. Mail and progress commit together or not at
//      all, so a crash at any instant resumes at exactly the next UID.
//
// Exactly once:
//   · resume: each folder continues after its recorded lastUid;
//   · UIDVALIDITY changed: the folder restarts from UID 1, and every message is deduped by
//     (Message-ID, INTERNALDATE, size) — by (content sha256, INTERNALDATE, size) when it has no
//     Message-ID — against what the target mailbox already holds; a duplicate is counted, never
//     filed. The same check runs on every message, so even a re-import is idempotent;
//   · within a run, a source UID already handled is skipped (servers answer `N:*` with the
//     highest message even when its UID is below N);
//   · a lease fence: every commit first re-asserts this worker still holds the job's lease, so a
//     worker that stalled past its lease and lost the job to another can never file anything more.
//     A heartbeat keeps the lease fresh through a long import.
//
// The password is opened from the KEK-sealed row only for the connection, zeroed after use, and
// the row is deleted when the import ends (done, failed or cancelled). It is never logged, never in
// an error message, never in the audit record.
import { once } from 'node:events';
import type { ConnectionOptions } from 'node:tls';
import { PassThrough } from 'node:stream';
import { recordAudit, type Actor } from '@postroom/audit';
import type { BlobStore, PutResult } from '@postroom/blobstore';
import type { Kek } from '@postroom/crypto';
import { SpecialUse, type Db, type Job, type Prisma } from '@postroom/db';
import { fileLocalMessage } from '@postroom/dsn';
import { respNumber, respText, type ParsedResponse, type RespValue } from '@postroom/imap-proto';
import { collectMessage, type MessageSummary } from '@postroom/mime';
import { indexMessage } from '@postroom/search';
import { assignThread } from '@postroom/threading';
import { summarise } from '../stages/parse.js';
import type { ParseResult } from '../stages/types.js';
import { capabilitiesOf, ImapImportClient, ImportError } from './client.js';
import {
  astring,
  DEFAULT_NAME_BY_SPECIAL_USE,
  displayName,
  isSelectable,
  isVirtual,
  normalizeFingerprint,
  parseInternalDate,
  targetFor,
  uidSet,
  type SourceFolder,
} from './names.js';
import {
  cancelRequested,
  importTotals,
  openImportSecret,
  readImportState,
  wipeImportSecret,
  writeImportState,
  type ImportFolderProgress,
  type ImportState,
  type ImportStatus,
} from './state.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

const ACTOR: Actor = { kind: 'system', label: 'import' };
const MAILBOX_CHANNEL = 'postroom_mailbox';
/** One message's transaction spans its download: long enough for 100 MB over a slow link. */
const MESSAGE_TX = { maxWait: 60_000, timeout: 30 * 60_000 } as const;
const SMALL_TX = { maxWait: 30_000, timeout: 60_000 } as const;

export interface ImportFaults {
  /** After a message's transaction commits. Throwing simulates a crash between two messages. */
  afterMessage?: (info: { folder: string; uid: number; filed: number }) => void | Promise<void>;
}

export interface ImportDeps {
  db: Db;
  blobs: BlobStore;
  /** Opens the password; called once per attempt. */
  kek: () => Kek;
  now?: () => Date;
  log?: Log;
  /** The queue's lease for this job; the heartbeat refreshes it every third of this. */
  leaseMs?: number;
  /** Messages per UID FETCH. */
  batchSize?: number;
  /** Extra TLS trust anchors (tests); production trusts the system store or a pinned fingerprint. */
  tlsCa?: ConnectionOptions['ca'];
  faults?: ImportFaults;
}

class Cancelled extends Error {}
class LeaseLost extends Error {}
class Duplicate extends Error {}
class Skip extends Error {}

interface MessageMeta {
  uid: number;
  flags: string[];
  internalDate: Date;
}

/** A FETCH response's items. `body` is the inline BODY[] (a streamed one stands as an empty string). */
interface FetchItems {
  uid: number | null;
  flags: string[] | null;
  internalDate: Date | null;
  body: Buffer | null;
}

export function fetchItems(r: ParsedResponse): FetchItems {
  const out: FetchItems = { uid: null, flags: null, internalDate: null, body: null };
  if (r.kind !== 'data' || r.name !== 'FETCH') return out;
  const list = r.values[0];
  if (list?.kind !== 'list') return out;
  const items = list.items;
  for (let i = 0; i + 1 < items.length; i += 2) {
    const name = respText(items[i])?.toUpperCase() ?? '';
    const value = items[i + 1];
    if (name === 'UID') out.uid = respNumber(value);
    else if (name === 'FLAGS' && value?.kind === 'list') out.flags = value.items.map((v) => respText(v)).filter((v): v is string => v !== null);
    else if (name === 'INTERNALDATE') {
      const text = respText(value);
      out.internalDate = text === null ? null : parseInternalDate(text);
    } else if ((name === 'BODY[]' || name === 'RFC822') && value?.kind === 'string') out.body = value.value;
  }
  return out;
}

/** A LIST response as a source folder, or null. */
export function listEntry(r: ParsedResponse): SourceFolder | null {
  if (r.kind !== 'data' || r.name !== 'LIST') return null;
  const [attrs, delim, name] = r.values;
  if (attrs?.kind !== 'list' || name === undefined) return null;
  const wire = name.kind === 'string' ? name.value.toString('utf8') : respText(name);
  if (wire === null || wire === '') return null;
  return {
    wire,
    display: displayName(wire),
    delimiter: delim === undefined || delim.kind === 'nil' ? null : respText(delim),
    attributes: attrs.items.map((v: RespValue) => respText(v)).filter((v): v is string => v !== null),
  };
}

/** Flags worth keeping: everything but the session-only \Recent. */
function keptFlags(flags: readonly string[]): string[] {
  return [...new Set(flags.filter((f) => f.toUpperCase() !== '\\RECENT'))];
}

function messageOf(err: unknown): string {
  if (err instanceof ImportError) return err.message;
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 500);
}

interface Sink {
  write(data: Buffer): Promise<void>;
  end(): void;
  /** Files it (or finds it a duplicate); resolves once its transaction has settled. */
  finish(meta: MessageMeta): Promise<'imported' | 'duplicate'>;
  /** Rolls it back and waits for that. */
  abort(): Promise<void>;
}

const DISCARD: Sink = {
  write: () => Promise.resolve(),
  end: () => undefined,
  finish: () => Promise.reject(new Error('a discarded literal cannot be filed')),
  abort: () => Promise.resolve(),
};

interface Filed {
  messageId: string;
  parsed: ParseResult;
  date: Date;
}

/** One attempt at one import job. */
class ImportRun {
  state: ImportState;
  lost = false;
  client: ImapImportClient | null = null;
  private readonly now: () => Date;
  private readonly log: Log;

  constructor(
    private readonly deps: ImportDeps,
    private readonly job: Job,
    state: ImportState,
  ) {
    this.state = state;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  get id(): string {
    return this.job.id;
  }

  /** Re-asserts this worker's lease (and refreshes it); throws LeaseLost if another worker has the job. */
  async fence(tx: Prisma.TransactionClient | Db): Promise<void> {
    const r = await tx.job.updateMany({ where: { id: this.job.id, lockedBy: this.job.lockedBy, status: 'running' }, data: { lockedAt: this.now() } });
    if (r.count !== 1) throw new LeaseLost('another worker holds this import');
  }

  private stamp(next: ImportState): ImportState {
    return { ...next, updatedAt: this.now().toISOString() };
  }

  async save(next: ImportState): Promise<void> {
    const stamped = this.stamp(next);
    await this.deps.db.$transaction(async (tx) => {
      await this.fence(tx);
      await writeImportState(tx, this.id, stamped);
    }, SMALL_TX);
    this.state = stamped;
  }

  /** The end: final status, the secret wiped, one audit record — all in one transaction. */
  async finish(status: Extract<ImportStatus, 'done' | 'failed' | 'cancelled'>, error: string | null): Promise<void> {
    const at = this.now().toISOString();
    const final: ImportState = { ...this.state, status, error, finishedAt: at, updatedAt: at };
    await this.deps.db.$transaction(async (tx) => {
      await this.fence(tx);
      await writeImportState(tx, this.id, final);
      await wipeImportSecret(tx, this.id);
      const totals = importTotals(final);
      await recordAudit(tx, {
        actor: ACTOR,
        action: `import.${status}`,
        entityType: 'job',
        entityId: this.id,
        after: { accountId: final.accountId, host: final.host, port: final.port, ...totals, error },
      });
    }, SMALL_TX);
    this.state = final;
    this.log('import-finished', { importId: this.id, status, ...importTotals(final) });
  }

  async run(password: Buffer): Promise<void> {
    const pinned = this.state.trustFingerprint === null ? null : normalizeFingerprint(this.state.trustFingerprint);
    if (this.state.trustFingerprint !== null && pinned === null) throw new ImportError('config', 'The pinned fingerprint is not a SHA-256 fingerprint.', true);
    const client = await ImapImportClient.connect({
      host: this.state.host,
      port: this.state.port,
      pinnedFingerprint: pinned,
      ...(this.deps.tlsCa === undefined ? {} : { ca: this.deps.tlsCa }),
    });
    this.client = client;
    try {
      await this.authenticate(client, password);
      password.fill(0);
      const folders = await this.listFolders(client);
      await this.plan(folders);
      for (const entry of this.state.progress) {
        if (entry.done) continue;
        await this.importFolder(client, entry.source);
      }
      await client.logout();
    } finally {
      client.close();
      this.client = null;
    }
  }

  private async capabilities(client: ImapImportClient): Promise<void> {
    const got: { caps: Set<string> | null } = { caps: null };
    const done = await client.command(['CAPABILITY'], (r) => {
      if (r.kind === 'data' && r.name === 'CAPABILITY') got.caps = capabilitiesOf(r.values);
    });
    if (done.status !== 'OK' || got.caps === null) throw new ImportError('protocol', 'The source server did not list its capabilities.', false);
    client.capabilities = got.caps;
  }

  private async authenticate(client: ImapImportClient, password: Buffer): Promise<void> {
    if (client.capabilities.size === 0) await this.capabilities(client);
    const caps = client.capabilities;
    const username = Buffer.from(this.state.username, 'utf8');
    let result;
    if (caps.has('AUTH=PLAIN')) {
      const ir = Buffer.concat([Buffer.of(0), username, Buffer.of(0), password]);
      const encoded = Buffer.from(`${ir.toString('base64')}\r\n`, 'latin1');
      ir.fill(0);
      if (caps.has('SASL-IR')) {
        const tag = client.sendWithSecret('AUTHENTICATE PLAIN ', encoded);
        encoded.fill(0);
        result = await client.untilTagged(tag);
      } else {
        const tag = await client.send(['AUTHENTICATE PLAIN']);
        const cont = await client.nextResponse();
        if (cont.kind !== 'continuation') {
          encoded.fill(0);
          throw new ImportError('auth', 'The source server refused to start a PLAIN login.', true);
        }
        client.write(encoded);
        encoded.fill(0);
        result = await client.untilTagged(tag);
      }
    } else if (!caps.has('LOGINDISABLED')) {
      result = await client.command(['LOGIN ', astring(username), ' ', astring(password)]);
    } else {
      throw new ImportError('config', 'The source server does not accept a password login on this connection.', true);
    }
    username.fill(0);
    if (result.status !== 'OK') {
      const code = result.code === null ? '' : ` (${result.code.name})`;
      throw new ImportError('auth', `The source server refused the username or password${code}.`, true);
    }
    await this.capabilities(client);
  }

  private async listFolders(client: ImapImportClient): Promise<SourceFolder[]> {
    const folders: SourceFolder[] = [];
    const done = await client.command(['LIST "" "*"'], (r) => {
      const f = listEntry(r);
      if (f !== null) folders.push(f);
    });
    if (done.status !== 'OK') throw new ImportError('protocol', `The source server refused LIST: ${done.text}`, false);
    return folders;
  }

  /** Adds a progress entry for every folder to import that has none yet (a resume keeps its own). */
  private async plan(folders: readonly SourceFolder[]): Promise<void> {
    const wanted = this.state.folders;
    const chosen = folders.filter((f) => {
      if (!isSelectable(f)) return false;
      if (wanted === null) return !isVirtual(f);
      return wanted.some((w) => w === f.wire || w === f.display || (w.toUpperCase() === 'INBOX' && f.display.toUpperCase() === 'INBOX'));
    });
    const progress = [...this.state.progress];
    for (const f of chosen) {
      if (progress.some((p) => p.source === f.wire)) continue;
      const target = targetFor(f);
      let name = target.name;
      if (target.specialUse !== null && target.specialUse !== 'inbox') {
        const ours = await this.deps.db.mailbox.findFirst({
          where: { accountId: this.state.accountId, specialUse: SpecialUse[target.specialUse] },
          orderBy: { createdAt: 'asc' },
          select: { name: true },
        });
        name = ours?.name ?? DEFAULT_NAME_BY_SPECIAL_USE[target.specialUse];
      }
      progress.push({ source: f.wire, display: f.display, target: name, specialUse: target.specialUse, uidvalidity: null, lastUid: 0, total: 0, imported: 0, duplicates: 0, done: false });
    }
    await this.save({ ...this.state, progress });
  }

  private entry(source: string): ImportFolderProgress {
    const e = this.state.progress.find((p) => p.source === source);
    if (e === undefined) throw new Error('folder progress vanished');
    return e;
  }

  private withEntry(source: string, change: (e: ImportFolderProgress) => ImportFolderProgress): ImportState {
    return { ...this.state, progress: this.state.progress.map((p) => (p.source === source ? change(p) : p)) };
  }

  private async importFolder(client: ImapImportClient, source: string): Promise<void> {
    const sel: { uidvalidity: number | null; exists: number } = { uidvalidity: null, exists: 0 };
    const examined = await client.command(['EXAMINE ', astring(source)], (r) => {
      if (r.kind === 'status' && r.code?.name === 'UIDVALIDITY') sel.uidvalidity = respNumber(r.code.args[0]);
      if (r.kind === 'data' && r.name === 'EXISTS' && r.number !== null) sel.exists = r.number;
    });
    const exists = sel.exists;
    if (examined.status !== 'OK') {
      // Gone since LIST, or refused: nothing to import from it.
      this.log('import-folder-skipped', { importId: this.id, folder: this.entry(source).display, reason: examined.text });
      await this.save(this.withEntry(source, (e) => ({ ...e, done: true })));
      return;
    }
    if (sel.uidvalidity === null) throw new ImportError('protocol', 'The source server did not say the folder\'s UIDVALIDITY.', false);
    const valid = sel.uidvalidity;
    const before = this.entry(source);
    const restarted = before.uidvalidity !== null && before.uidvalidity !== valid;
    if (restarted) this.log('import-uidvalidity-changed', { importId: this.id, folder: before.display, was: before.uidvalidity, now: valid });
    await this.save(
      this.withEntry(source, (e) => ({
        ...e,
        ...(restarted ? { lastUid: 0, imported: 0, duplicates: 0 } : {}),
        uidvalidity: valid,
        total: exists,
      })),
    );

    const from = this.entry(source).lastUid + 1;
    const uids: number[] = [];
    if (exists > 0) {
      const listed = await client.command([`UID FETCH ${String(from)}:* (UID)`], (r) => {
        const uid = fetchItems(r).uid;
        if (uid !== null && uid >= from) uids.push(uid);
      });
      if (listed.status !== 'OK') throw new ImportError('protocol', `The source server refused UID FETCH: ${listed.text}`, false);
    }
    const todo = [...new Set(uids)].sort((a, b) => a - b);
    const seen = new Set<number>();
    const batchSize = Math.max(1, this.deps.batchSize ?? 50);
    for (let i = 0; i < todo.length; i += batchSize) {
      if (await cancelRequested(this.deps.db, this.id)) throw new Cancelled();
      await this.fetchBatch(client, source, todo.slice(i, i + batchSize), seen);
    }
    await this.save(this.withEntry(source, (e) => ({ ...e, done: true })));
    const e = this.entry(source);
    this.log('import-folder-done', { importId: this.id, folder: e.display, target: e.target, imported: e.imported, duplicates: e.duplicates, total: e.total });
  }

  /** The folder's progress after `uid` is handled: lastUid advances over the leading run of handled UIDs. */
  private progressAfter(source: string, batch: readonly number[], seen: ReadonlySet<number>, uid: number, outcome: 'imported' | 'duplicate' | 'gone'): ImportState {
    return this.withEntry(source, (e) => {
      let lastUid = e.lastUid;
      for (const u of batch) {
        if (u <= lastUid) continue;
        if (u === uid || seen.has(u)) lastUid = u;
        else break;
      }
      return {
        ...e,
        lastUid,
        imported: e.imported + (outcome === 'imported' ? 1 : 0),
        duplicates: e.duplicates + (outcome === 'duplicate' ? 1 : 0),
      };
    });
  }

  private async fetchBatch(client: ImapImportClient, source: string, batch: readonly number[], seen: Set<number>): Promise<void> {
    const inBatch = new Set(batch);
    const skip = (uid: number): boolean => !inBatch.has(uid) || seen.has(uid) || uid <= this.entry(source).lastUid;
    const tag = await client.send([`UID FETCH ${uidSet(batch)} (UID FLAGS INTERNALDATE BODY.PEEK[])`]);
    let sink: Sink | null = null;
    try {
      for (;;) {
        const ev = await client.nextEvent();
        if (ev.type === 'literal-start') {
          const prefix = ev.prefix.toString('latin1');
          const hint = /\(.*\bUID (\d+)/i.exec(prefix);
          // We asked for BODY.PEEK[] only, so a big literal is a message body: file it unless its
          // UID (when the server sent that first) says it is already handled.
          sink = hint !== null && skip(Number(hint[1])) ? DISCARD : this.openSink(source, batch, seen);
          continue;
        }
        if (ev.type === 'literal-data') {
          await (sink ?? DISCARD).write(ev.data);
          continue;
        }
        if (ev.type === 'literal-end') {
          sink?.end();
          continue;
        }
        const r = ev.response;
        if (r.kind === 'status' && r.tag === tag) {
          if (r.status !== 'OK') throw new ImportError('protocol', `The source server refused FETCH: ${r.text}`, false);
          break;
        }
        if (r.kind === 'status' && r.status === 'BYE') throw new ImportError('connect', `The source server said goodbye: ${r.text}`, false);
        const current = sink;
        sink = null;
        const items = fetchItems(r);
        const uid = items.uid;
        if (uid === null || skip(uid) || items.internalDate === null) {
          await current?.abort();
          continue;
        }
        let body: Sink | null = ev.streamed > 0 ? current : null;
        if (body === null && items.body !== null) {
          body = this.openSink(source, batch, seen);
          await body.write(items.body);
          body.end();
        }
        if (body === null || body === DISCARD) {
          await current?.abort();
          continue;
        }
        const outcome = await body.finish({ uid, flags: keptFlags(items.flags ?? []), internalDate: items.internalDate });
        seen.add(uid);
        if (outcome === 'duplicate') {
          await this.save(this.progressAfter(source, batch, seen, uid, 'duplicate'));
        }
        await this.deps.faults?.afterMessage?.({ folder: source, uid, filed: this.entry(source).imported });
      }
    } finally {
      if (sink !== null) await sink.abort();
    }
    // Every UID of the batch is handled now: filed, a duplicate, or not returned at all (expunged
    // at the source since the UID list was taken).
    for (const u of batch) seen.add(u);
    const last = batch[batch.length - 1] ?? 0;
    if (last > this.entry(source).lastUid) await this.save(this.withEntry(source, (e) => ({ ...e, lastUid: Math.max(e.lastUid, last) })));
  }

  /**
   * A message on its way in: its bytes go, as they arrive, to the blob store and the MIME
   * summariser at once, inside a transaction that files it once `finish` supplies the FETCH
   * response's UID, FLAGS and INTERNALDATE.
   */
  private openSink(source: string, batch: readonly number[], seen: ReadonlySet<number>): Sink {
    const { db, blobs } = this.deps;
    const toBlob = new PassThrough();
    const toParse = new PassThrough();
    let ended = false;
    let supply: (meta: MessageMeta | null) => void = () => undefined;
    const meta = new Promise<MessageMeta | null>((resolve) => {
      supply = resolve;
    });
    let committed: ImportState | null = null;

    const work = db.$transaction(async (tx) => {
      const summary = collectMessage(toParse).catch((): MessageSummary | null => {
        // A summariser that gave up must not stall the stream the blob store is reading beside it.
        toParse.resume();
        return null;
      });
      const [put, collected] = await Promise.all([blobs.put(toBlob, { tx }), summary]);
      const m = await meta;
      if (m === null) throw new Skip();
      const parsed = collected === null ? null : summarise(collected);
      const filed = await this.fileOne(tx, source, put, parsed, m);
      const next = this.stamp(this.progressAfter(source, batch, seen, m.uid, 'imported'));
      await writeImportState(tx, this.id, next);
      committed = next;
      return filed;
    }, MESSAGE_TX);
    // Observed by finish/abort; never an unhandled rejection in between.
    work.catch(() => undefined);

    const drained = async (stream: PassThrough): Promise<void> => {
      if (!stream.writableNeedDrain) return;
      await Promise.race([
        once(stream, 'drain'),
        work.then(
          () => {
            throw new Error('the message transaction ended before its body did');
          },
          (err: unknown) => {
            throw err;
          },
        ),
      ]);
    };

    return {
      write: async (data) => {
        toBlob.write(data);
        toParse.write(data);
        // Both listeners attach before either can drain: a 'drain' is never missed.
        await Promise.all([drained(toBlob), drained(toParse)]);
      },
      end: () => {
        ended = true;
        toBlob.end();
        toParse.end();
      },
      finish: async (m) => {
        supply(m);
        try {
          const filed = await work;
          if (committed !== null) this.state = committed;
          await this.afterCommit(filed);
          return 'imported';
        } catch (err) {
          if (err instanceof Duplicate) return 'duplicate';
          throw err;
        }
      },
      abort: async () => {
        supply(null);
        if (!ended) {
          toBlob.destroy(new Error('aborted'));
          toParse.destroy(new Error('aborted'));
        }
        await work.catch(() => undefined);
      },
    };
  }

  /** Inside the message's transaction: fence, cancel check, dedupe, file, index. */
  private async fileOne(tx: Prisma.TransactionClient, source: string, put: PutResult, parsed: ParseResult | null, m: MessageMeta): Promise<Filed> {
    await this.fence(tx);
    if (await cancelRequested(tx, this.id)) throw new Cancelled();
    const accountId = this.state.accountId;
    const target = this.entry(source).target;
    const messageIdHeader = parsed?.messageId ?? null;
    const mailbox = await tx.mailbox.findUnique({ where: { accountId_name: { accountId, name: target } }, select: { id: true } });
    if (mailbox !== null) {
      const dup = await tx.message.findFirst({
        where: {
          mailboxId: mailbox.id,
          internalDate: m.internalDate,
          size: put.size,
          ...(messageIdHeader === null ? { blobSha256: put.sha256 } : { messageIdHeader }),
        },
        select: { id: true },
      });
      if (dup !== null) throw new Duplicate();
    }
    const filed = await fileLocalMessage(tx, { accountId, mailbox: target, blobSha256: put.sha256, size: put.size, internalDate: m.internalDate, flags: m.flags });
    if (parsed !== null) {
      await tx.message.update({
        where: { id: filed.id },
        data: {
          messageIdHeader: parsed.messageId,
          subject: parsed.subject,
          fromAddress: parsed.fromAddress,
          sentAt: parsed.sentAt === null ? null : new Date(parsed.sentAt),
        },
      });
      await indexMessage(tx, {
        messageId: filed.id,
        accountId,
        ...(parsed.subject === null ? {} : { subject: parsed.subject }),
        ...(parsed.fromAddress === null ? {} : { from: parsed.fromAddress }),
        ...(parsed.toAddress === null ? {} : { to: parsed.toAddress }),
        bodyText: parsed.bodyText,
        attachmentNames: parsed.attachments.map((a) => a.filename).filter((f): f is string => f !== null),
        hasAttachment: parsed.attachments.length > 0,
      });
    }
    await tx.$executeRaw`SELECT pg_notify(${MAILBOX_CHANNEL}, ${filed.mailboxId})`;
    return { messageId: filed.id, parsed: parsed ?? emptyParse(), date: parsed === null || parsed.sentAt === null ? m.internalDate : new Date(parsed.sentAt) };
  }

  /** Threads it, after its commit — the file stage's order; the thread sweeper repairs a crash in between. */
  private async afterCommit(filed: Filed): Promise<void> {
    const p = filed.parsed;
    try {
      await assignThread(this.deps.db, {
        accountId: this.state.accountId,
        messageId: filed.messageId,
        ...(p.messageId === null ? {} : { messageIdHeader: p.messageId }),
        ...(p.inReplyTo[0] === undefined ? {} : { inReplyTo: p.inReplyTo[0] }),
        references: p.references,
        subject: p.subject ?? '',
        from: p.fromAddress ?? '',
        to: p.toAddress ?? '',
        date: filed.date,
      });
    } catch (err) {
      this.log('import-thread-error', { importId: this.id, error: messageOf(err) });
    }
  }
}

function emptyParse(): ParseResult {
  return {
    messageId: null,
    subject: null,
    fromAddress: null,
    toAddress: null,
    sentAt: null,
    inReplyTo: [],
    references: [],
    hasText: false,
    hasHtml: false,
    bodyText: '',
    attachments: [],
    warnings: 0,
  };
}

/**
 * One attempt at one import. Returns normally when the import reached an end (done, failed with a
 * reason the owner must fix, cancelled) or when another worker took the job over; throws a
 * transient failure so the queue retries it with backoff — and the retry resumes.
 */
export async function runImportJob(deps: ImportDeps, job: Job): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const initial = await readImportState(deps.db, job.id);
  if (initial === null) {
    log('import-missing-state', { importId: job.id });
    return;
  }
  if (initial.status === 'done' || initial.status === 'failed' || initial.status === 'cancelled') return;
  const run = new ImportRun(deps, job, initial);

  try {
    if (await cancelRequested(deps.db, job.id)) {
      await run.finish('cancelled', null);
      return;
    }
    let password: Buffer | null;
    try {
      password = await openImportSecret(deps.db, deps.kek(), job.id);
    } catch {
      await run.finish('failed', 'The stored source credentials could not be opened. Start the import again.');
      return;
    }
    if (password === null) {
      await run.finish('failed', 'The source credentials are gone. Start the import again.');
      return;
    }

    const leaseMs = deps.leaseMs ?? 600_000;
    const heartbeat = setInterval(() => {
      run.fence(deps.db).catch(() => {
        run.lost = true;
        run.client?.close();
      });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    try {
      await run.save({ ...run.state, status: 'running', startedAt: run.state.startedAt ?? (deps.now ?? (() => new Date()))().toISOString(), error: null });
      await run.run(password);
      await run.finish('done', null);
    } finally {
      clearInterval(heartbeat);
      password.fill(0);
    }
  } catch (err) {
    if (run.lost || err instanceof LeaseLost) {
      log('import-lease-lost', { importId: job.id });
      return;
    }
    if (err instanceof Cancelled) {
      await run.finish('cancelled', null);
      return;
    }
    const message = messageOf(err);
    if ((err instanceof ImportError && err.permanent) || job.attempts >= job.maxAttempts) {
      log('import-failed', { importId: job.id, error: message });
      await run.finish('failed', message);
      return;
    }
    log('import-retry', { importId: job.id, attempt: job.attempts, error: message });
    await run.save({ ...run.state, error: `Interrupted, will resume: ${message}` }).catch(() => undefined);
    throw err;
  }
}

/** The 'import' queue handler: payload `{ accountId }`, job id = import id. */
export function importHandler(deps: ImportDeps): (job: Job) => Promise<void> {
  return async (job) => {
    const payload = job.payload as { accountId?: unknown } | null;
    if (typeof payload?.accountId !== 'string') throw new Error('import job payload missing accountId');
    await runImportJob(deps, job);
  };
}
