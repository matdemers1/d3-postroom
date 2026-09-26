import { parseMessage, type MimeEvent, type MimeWarning, type ParseOptions, type ParseStats, type PartInfo } from '../../src/index.js';

/** Split `buf` at the given cut points (any order, out-of-range ignored). */
export function split(buf: Uint8Array, cuts: readonly number[] = []): Buffer[] {
  const points = [...new Set(cuts.filter((c) => c > 0 && c < buf.length))].sort((a, b) => a - b);
  const out: Buffer[] = [];
  let last = 0;
  for (const p of points) {
    out.push(Buffer.from(buf.subarray(last, p)));
    last = p;
  }
  out.push(Buffer.from(buf.subarray(last)));
  return out;
}

export interface ParsedPart {
  part: PartInfo;
  body: Buffer;
  ended: boolean;
  size: number;
}

export interface Parsed {
  parts: ParsedPart[];
  byId: Map<string, ParsedPart>;
  warnings: MimeWarning[];
  stats: ParseStats | null;
  events: MimeEvent[];
}

/** Parse `input` (fed in the given chunks) and gather every part with its concatenated body. */
export async function parse(input: string | Uint8Array | readonly Uint8Array[], options: ParseOptions & { cuts?: readonly number[] } = {}): Promise<Parsed> {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'latin1') : input;
  const chunks = Array.isArray(bytes) ? (bytes as readonly Uint8Array[]) : split(bytes as Uint8Array, options.cuts ?? []);
  const parts: ParsedPart[] = [];
  const byId = new Map<string, ParsedPart>();
  const warnings: MimeWarning[] = [];
  const events: MimeEvent[] = [];
  let stats: ParseStats | null = null;
  const bodies = new Map<string, Buffer[]>();
  for await (const e of parseMessage(chunks, options)) {
    events.push(e);
    if (e.type === 'headers') {
      const p: ParsedPart = { part: e.part, body: Buffer.alloc(0), ended: false, size: 0 };
      parts.push(p);
      byId.set(e.part.id, p);
      bodies.set(e.part.id, []);
    } else if (e.type === 'body') {
      bodies.get(e.part.id)?.push(Buffer.from(e.chunk));
    } else if (e.type === 'end-part') {
      const p = byId.get(e.part.id);
      if (p !== undefined) {
        p.ended = true;
        p.size = e.size;
        p.body = Buffer.concat(bodies.get(e.part.id) ?? []);
      }
    } else if (e.type === 'warning') {
      warnings.push(e.warning);
    } else {
      stats = e.stats;
    }
  }
  return { parts, byId, warnings, stats, events };
}

export function part(parsed: Parsed, id: string): ParsedPart {
  const p = parsed.byId.get(id);
  if (p === undefined) throw new Error(`no part ${id}; have ${[...parsed.byId.keys()].join(', ')}`);
  return p;
}
