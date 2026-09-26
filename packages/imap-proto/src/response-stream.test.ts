// StreamingResponseReader (PST-T-10.2): the same responses as ResponseReader at any chunking, with
// every literal at or over the threshold streamed out byte-exact and never held.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ResponseReader, StreamingResponseReader, parseResponse, type ParsedResponse, type ResponseStreamEvent } from './index.js';

/** One response on the wire, as segments: literal bytes follow the line that announces them. */
interface WireResponse {
  readonly lines: readonly string[];
  readonly literals: readonly Buffer[];
}

function wireOf(r: WireResponse): Buffer {
  const out: Buffer[] = [];
  r.lines.forEach((line, i) => {
    out.push(Buffer.from(line, 'latin1'));
    const lit = r.literals[i];
    if (lit !== undefined) out.push(Buffer.from(`{${lit.length}}\r\n`, 'latin1'), lit);
  });
  out.push(Buffer.from('\r\n'));
  return Buffer.concat(out);
}

/** The same response with every literal of `threshold` octets or more standing as `{0}`. */
function standInOf(r: WireResponse, threshold: number): Buffer {
  const out: Buffer[] = [];
  r.lines.forEach((line, i) => {
    out.push(Buffer.from(line, 'latin1'));
    const lit = r.literals[i];
    if (lit === undefined) return;
    if (lit.length >= threshold && lit.length > 0) out.push(Buffer.from('{0}\r\n', 'latin1'));
    else out.push(Buffer.from(`{${lit.length}}\r\n`, 'latin1'), lit);
  });
  return Buffer.concat(out);
}

function chunked(bytes: Buffer, cuts: readonly number[]): Buffer[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const out: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    if (p > prev) out.push(bytes.subarray(prev, p));
    prev = Math.max(prev, p);
  }
  if (prev < bytes.length) out.push(bytes.subarray(prev));
  return out;
}

function drain(chunks: readonly Buffer[], threshold: number): ResponseStreamEvent[] {
  const reader = new StreamingResponseReader({ streamLiteralsFrom: threshold });
  const out: ResponseStreamEvent[] = [];
  for (const c of chunks) {
    reader.push(c);
    for (let ev = reader.next(); ev; ev = reader.next()) {
      // literal-data is a view into the chunk: copy it, as a real consumer must before pushing more.
      out.push(ev.type === 'literal-data' ? { type: 'literal-data', data: Buffer.from(ev.data) } : ev);
    }
  }
  return out;
}

const bytes = fc.uint8Array({ maxLength: 300 }).map((a) => Buffer.from(a));
const fetchResponse = fc
  .record({ n: fc.integer({ min: 1, max: 9999 }), uid: fc.integer({ min: 1, max: 99999 }), body: bytes, uidFirst: fc.boolean() })
  .map(({ n, uid, body, uidFirst }): WireResponse =>
    uidFirst
      ? { lines: [`* ${n} FETCH (UID ${uid} FLAGS (\\Seen) BODY[] `, ')'], literals: [body] }
      : { lines: [`* ${n} FETCH (BODY[] `, ` UID ${uid} FLAGS (\\Seen $Forwarded))`], literals: [body] },
  );
const listResponse = fc
  .string({ unit: fc.constantFrom('a', 'b', '/', ' ', 'Ü', '"'), minLength: 1, maxLength: 12 })
  .map((name): WireResponse => ({ lines: ['* LIST (\\HasNoChildren) "/" ', ''], literals: [Buffer.from(name, 'utf8')] }));
const statusResponse = fc
  .constantFrom('A1 OK done', '* OK [UIDVALIDITY 3857529045] UIDs valid', '* 4 EXISTS', 'A2 NO [AUTHENTICATIONFAILED] nope', '+ go ahead')
  .map((line): WireResponse => ({ lines: [line], literals: [] }));
const twoLiterals = fc
  .tuple(bytes, bytes)
  .map(([a, b]): WireResponse => ({ lines: ['* 1 FETCH (BODY[HEADER] ', ' BODY[] ', ')'], literals: [a, b] }));
const responses = fc.array(fc.oneof(fetchResponse, listResponse, statusResponse, twoLiterals), { minLength: 1, maxLength: 6 });

describe('StreamingResponseReader', () => {
  it('parses the same responses as ResponseReader, at any chunking and threshold, with streamed literals byte-exact', () => {
    fc.assert(
      fc.property(responses, fc.array(fc.nat(), { maxLength: 12 }), fc.integer({ min: 1, max: 400 }), (rs, cuts, threshold) => {
        const wire = Buffer.concat(rs.map(wireOf));
        const events = drain(chunked(wire, cuts), threshold);

        const got: { response: ParsedResponse; streamed: number; literals: Buffer[] }[] = [];
        let open: Buffer[] | null = null;
        let current: Buffer[] = [];
        for (const ev of events) {
          if (ev.type === 'literal-start') {
            expect(open).toBeNull();
            open = [];
          } else if (ev.type === 'literal-data') {
            expect(open).not.toBeNull();
            open?.push(ev.data);
          } else if (ev.type === 'literal-end') {
            expect(open).not.toBeNull();
            current.push(Buffer.concat(open ?? []));
            open = null;
          } else {
            got.push({ response: ev.response, streamed: ev.streamed, literals: current });
            current = [];
          }
        }
        expect(open).toBeNull();
        expect(got).toHaveLength(rs.length);
        rs.forEach((r, i) => {
          const g = got[i];
          const streamedLits = r.literals.filter((l) => l.length >= threshold && l.length > 0);
          expect(g?.streamed).toBe(streamedLits.length);
          expect(g?.literals).toEqual(streamedLits);
          expect(g?.response).toEqual(parseResponse(standInOf(r, threshold)));
        });

        // Nothing streamed (a threshold no literal reaches): exactly what ResponseReader says.
        const plain = new ResponseReader();
        const whole: ParsedResponse[] = [];
        plain.push(wire);
        for (let r = plain.next(); r; r = plain.next()) whole.push(r);
        const unstreamed = drain([wire], 1_000_000).flatMap((e) => (e.type === 'response' ? [e.response] : []));
        expect(unstreamed).toEqual(whole);
      }),
      { numRuns: 400 },
    );
  });

  it('never holds a streamed literal: buffered bytes stay far below its size', () => {
    const body = Buffer.alloc(5 * 1024 * 1024, 0x61);
    const reader = new StreamingResponseReader({ streamLiteralsFrom: 1024 });
    const wire = Buffer.concat([Buffer.from(`* 1 FETCH (UID 9 BODY[] {${body.length}}\r\n`), body, Buffer.from(')\r\nA1 OK done\r\n')]);
    let total = 0;
    let peak = 0;
    const kinds: string[] = [];
    for (let at = 0; at < wire.length; at += 16 * 1024) {
      reader.push(wire.subarray(at, at + 16 * 1024));
      for (let ev = reader.next(); ev; ev = reader.next()) {
        if (ev.type === 'literal-data') total += ev.data.length;
        else kinds.push(ev.type === 'response' ? `${ev.type}:${ev.response.kind}` : ev.type);
        peak = Math.max(peak, reader.bufferedBytes);
      }
    }
    expect(total).toBe(body.length);
    expect(kinds).toEqual(['literal-start', 'literal-end', 'response:data', 'response:status']);
    expect(peak).toBeLessThan(64 * 1024);
  });

  it('hands the prefix before the marker to literal-start, so a caller can see what the literal is', () => {
    const events = drain([Buffer.from('* 2 FETCH (UID 5 BODY[] {3}\r\nabc)\r\n')], 1);
    expect(events[0]).toEqual({ type: 'literal-start', size: 3, prefix: Buffer.from('* 2 FETCH (UID 5 BODY[] '), binary: false });
    const last = events[events.length - 1];
    expect(last?.type === 'response' ? last.response : null).toEqual(parseResponse('* 2 FETCH (UID 5 BODY[] {0}\r\n)'));
  });

  it('never throws on arbitrary bytes, and a fatal error ends the stream', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 200 }), { maxLength: 8 }), fc.integer({ min: 1, max: 64 }), (chunks, threshold) => {
        const reader = new StreamingResponseReader({ streamLiteralsFrom: threshold, maxLineLength: 100, maxLiteralSize: 50, maxResponseSize: 400, maxStreamedLiteralSize: 1000 });
        let fatal = false;
        for (const c of chunks) {
          reader.push(c);
          for (let ev = reader.next(); ev; ev = reader.next()) {
            expect(fatal).toBe(false);
            if (ev.type === 'response' && ev.response.kind === 'error' && ev.response.fatal) fatal = true;
          }
          expect(reader.bufferedBytes).toBeLessThanOrEqual(400 + 200 * 8 + 102);
        }
      }),
      { numRuns: 300 },
    );
  });
});
