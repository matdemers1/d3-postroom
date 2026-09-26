// /api/admin/smtp — data access for the transcript browser and the live viewer (PST-T-6.3,
// PST-REQ-117, PST-REQ-118). Mounted by app.ts behind requireAdmin; nothing here mutates.
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { Db } from '@postroom/db';
import { openListener, type ListenClient } from '../mail/pg-listen.js';

// `@postroom/db`'s curated export list does not (yet) include the generated `SmtpTranscript` type,
// so it is inferred from the client itself rather than adding one (packages/db is not owned here).
type TranscriptRow = NonNullable<Awaited<ReturnType<Db['smtpTranscript']['findUnique']>>>;

export const SMTP_LIVE_CHANNEL = 'smtp_live';

export interface TranscriptSummaryJson {
  id: string;
  daemon: string;
  sessionId: string;
  clientIp: string;
  startedAt: string;
  endedAt: string | null;
  lineCount: number;
  rawBytes: number;
  compressedBytes: number;
  createdAt: string;
}

export interface TranscriptLineJson {
  at: string;
  dir: 'C' | 'S';
  line: string;
}

export interface TranscriptDetailJson extends TranscriptSummaryJson {
  lines: TranscriptLineJson[];
}

export function summarize(row: TranscriptRow): TranscriptSummaryJson {
  return {
    id: row.id,
    daemon: row.daemon,
    sessionId: row.sessionId,
    clientIp: row.clientIp,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    lineCount: row.lineCount,
    rawBytes: row.rawBytes,
    compressedBytes: row.compressedBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Decompresses a stored transcript back to its exact text — the daemons' own encoder. */
function decompress(row: Pick<TranscriptRow, 'body' | 'compression'>): string {
  const buf = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body);
  const raw = row.compression === 'br' ? brotliDecompressSync(buf) : gunzipSync(buf);
  return raw.toString('utf8');
}

/** Parses `"{iso}\t{C|S}: {line}"` per line — the daemons' own encoding (apps/smtp-in/src/transcript.ts). */
function parseLines(text: string): TranscriptLineJson[] {
  const out: TranscriptLineJson[] = [];
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const tab = raw.indexOf('\t');
    const at = tab === -1 ? '' : raw.slice(0, tab);
    const rest = tab === -1 ? raw : raw.slice(tab + 1);
    const dir: 'C' | 'S' = rest.startsWith('C: ') ? 'C' : 'S';
    const line = rest.startsWith('C: ') || rest.startsWith('S: ') ? rest.slice(3) : rest;
    out.push({ at, dir, line });
  }
  return out;
}

export interface ListTranscriptsQuery {
  daemon?: string | undefined;
  clientIp?: string | undefined;
  limit: number;
  before?: string | undefined;
}

export async function listTranscripts(db: Db, q: ListTranscriptsQuery): Promise<TranscriptSummaryJson[]> {
  const rows = await db.smtpTranscript.findMany({
    where: {
      ...(q.daemon === undefined ? {} : { daemon: q.daemon }),
      ...(q.clientIp === undefined ? {} : { clientIp: q.clientIp }),
      ...(q.before === undefined ? {} : { startedAt: { lt: new Date(q.before) } }),
    },
    orderBy: { startedAt: 'desc' },
    take: q.limit,
  });
  return rows.map(summarize);
}

export async function getTranscript(db: Db, id: string): Promise<TranscriptDetailJson | null> {
  const row = await db.smtpTranscript.findUnique({ where: { id } });
  if (row === null) return null;
  return { ...summarize(row), lines: parseLines(decompress(row)) };
}

export interface TranscriptTotals {
  count: number;
  rawBytes: number;
  compressedBytes: number;
}

export async function transcriptTotals(db: Db): Promise<TranscriptTotals> {
  const agg = await db.smtpTranscript.aggregate({ _count: { _all: true }, _sum: { rawBytes: true, compressedBytes: true } });
  return { count: agg._count._all, rawBytes: agg._sum.rawBytes ?? 0, compressedBytes: agg._sum.compressedBytes ?? 0 };
}

// --- Live view (PST-REQ-117) ---------------------------------------------------------------------

export interface LiveLine {
  daemon: string;
  sessionId: string;
  dir: 'C' | 'S';
  line: string;
  at: string;
}

function isLiveLine(value: unknown): value is LiveLine {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['daemon'] === 'string' && typeof v['sessionId'] === 'string' && (v['dir'] === 'C' || v['dir'] === 'S') && typeof v['line'] === 'string' && typeof v['at'] === 'string';
}

/** One LISTEN connection per API process, fanned out to every connected admin viewer. */
export class SmtpLiveHub {
  private listener: ListenClient | null = null;
  private starting: Promise<void> | null = null;
  private readonly subs = new Set<(line: LiveLine) => void>();

  constructor(
    private readonly databaseUrl: string,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void,
  ) {}

  get subscriberCount(): number {
    return this.subs.size;
  }

  private async ensureListening(): Promise<void> {
    if (this.listener !== null) return;
    this.starting ??= (async () => {
      try {
        const client = await openListener(this.databaseUrl, SMTP_LIVE_CHANNEL, {
          notify: (payload) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(payload);
            } catch (err) {
              this.log('smtp-live-bad-payload', { error: err instanceof Error ? err.message : String(err) });
              return;
            }
            if (!isLiveLine(parsed)) return;
            for (const sub of this.subs) sub(parsed);
          },
          lost: (error) => {
            this.listener = null;
            if (error !== null) this.log('smtp-live-listener-lost', { error: error.message });
          },
        });
        this.listener = client;
      } finally {
        this.starting = null;
      }
    })();
    await this.starting;
  }

  /** Registers a subscriber (after the LISTEN is up) and returns its unsubscribe. */
  async subscribe(fn: (line: LiveLine) => void): Promise<() => void> {
    await this.ensureListening();
    this.subs.add(fn);
    return (): void => {
      this.subs.delete(fn);
      if (this.subs.size === 0) this.stop();
    };
  }

  private stop(): void {
    const client = this.listener;
    this.listener = null;
    if (client !== null) {
      client.end().catch((err: unknown) => {
        this.log('smtp-live-listener-end-failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }
}

const hubs = new WeakMap<object, SmtpLiveHub>();

export function smtpLiveHubFor(deps: { env: NodeJS.ProcessEnv }): SmtpLiveHub | null {
  const existing = hubs.get(deps);
  if (existing !== undefined) return existing;
  const url = deps.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') return null;
  const hub = new SmtpLiveHub(url, (event, fields) => {
    process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
  });
  hubs.set(deps, hub);
  return hub;
}
