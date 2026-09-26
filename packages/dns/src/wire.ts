// RFC 1035 message encode/decode plus the RFC 6891 EDNS0 OPT pseudo-RR (payload size + DO bit).
// decodeMessage never throws on arbitrary bytes: every failure path returns a typed error result.
import { randomInt } from 'node:crypto';
import { decodeName, encodeName } from './name.js';
import { DNS_CLASS_IN, RRType } from './types.js';
import type { DecodeResult, DnsAnswer, DnsMessage, DnsQuestion } from './types.js';

const HEADER_LENGTH = 12;
const DEFAULT_UDP_PAYLOAD_SIZE = 1232;

export interface EncodeQueryOptions {
  id?: number;
  recursionDesired?: boolean;
  requestAd?: boolean;
  dnssecOk?: boolean;
  udpPayloadSize?: number;
}

export interface EncodedQuery {
  id: number;
  packet: Uint8Array;
}

function readU16(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  if (b0 === undefined || b1 === undefined) {
    throw new RangeError('readU16 out of bounds');
  }
  return (b0 << 8) | b1;
}

function readU32(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new RangeError('readU32 out of bounds');
  }
  return b0 * 0x1000000 + ((b1 << 16) | (b2 << 8) | b3);
}

/** RFC 6840 §5.7: a validating-aware stub sets both RD and AD in the query to ask the resolver
 * to report whether it validated the answer. RFC 6891 EDNS0 OPT carries a 1232-byte UDP payload
 * size and the DO bit so the resolver knows this client can receive (and wants) DNSSEC data. */
export function encodeQuery(name: string, type: number, opts: EncodeQueryOptions = {}): EncodedQuery {
  const id = opts.id ?? randomInt(0, 0x10000);
  const rd = opts.recursionDesired ?? true;
  const ad = opts.requestAd ?? true;
  const dnssecOk = opts.dnssecOk ?? true;
  const udpPayloadSize = opts.udpPayloadSize ?? DEFAULT_UDP_PAYLOAD_SIZE;

  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt16BE(id, 0);
  let flags = 0;
  if (rd) flags |= 1 << 8;
  if (ad) flags |= 1 << 5;
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(1, 10); // ARCOUNT: the EDNS0 OPT record below

  const qname = Buffer.from(encodeName(name));
  const question = Buffer.alloc(qname.length + 4);
  qname.copy(question, 0);
  question.writeUInt16BE(type, qname.length);
  question.writeUInt16BE(DNS_CLASS_IN, qname.length + 2);

  const opt = Buffer.alloc(11);
  opt.writeUInt8(0, 0); // root name
  opt.writeUInt16BE(RRType.OPT, 1);
  opt.writeUInt16BE(udpPayloadSize, 3); // CLASS carries the requestor's UDP payload size
  const extendedRcode = 0;
  const version = 0;
  const doFlag = dnssecOk ? 1 << 15 : 0;
  const optTtl = ((extendedRcode << 24) | (version << 16) | doFlag) >>> 0;
  opt.writeUInt32BE(optTtl, 5);
  opt.writeUInt16BE(0, 9); // RDLENGTH: no options

  return { id, packet: Buffer.concat([header, question, opt]) };
}

interface RawRR {
  name: string;
  type: number;
  class: number;
  ttl: number;
  rdataStart: number;
  rdataEnd: number;
}

type RawRRResult = { ok: true; end: number; rr: RawRR } | { ok: false; error: string };

function decodeRawRR(buf: Uint8Array, offset: number): RawRRResult {
  const nameResult = decodeName(buf, offset);
  if (!nameResult.ok) {
    return nameResult;
  }
  const headerStart = nameResult.end;
  if (headerStart + 10 > buf.length) {
    return { ok: false, error: 'truncated resource record header' };
  }
  const type = readU16(buf, headerStart);
  const klass = readU16(buf, headerStart + 2);
  const ttl = readU32(buf, headerStart + 4);
  const rdlength = readU16(buf, headerStart + 8);
  const rdataStart = headerStart + 10;
  const rdataEnd = rdataStart + rdlength;
  if (rdataEnd > buf.length) {
    return { ok: false, error: 'truncated rdata' };
  }
  return {
    ok: true,
    end: rdataEnd,
    rr: { name: nameResult.name, type, class: klass, ttl, rdataStart, rdataEnd },
  };
}

function formatIPv4(buf: Uint8Array, offset: number): string {
  return `${String(buf[offset])}.${String(buf[offset + 1])}.${String(buf[offset + 2])}.${String(buf[offset + 3])}`;
}

function formatIPv6(buf: Uint8Array, offset: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(readU16(buf, offset + i * 2).toString(16));
  }
  // Compress the longest run of consecutive zero groups per RFC 5952 §4.2.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen > 1) {
    const head = groups.slice(0, bestStart);
    const tail = groups.slice(bestStart + bestLen);
    return `${head.join(':')}::${tail.join(':')}`;
  }
  return groups.join(':');
}

function decodeCharacterStrings(buf: Uint8Array, start: number, end: number): { ok: true; strings: string[] } | { ok: false; error: string } {
  const strings: string[] = [];
  let pos = start;
  while (pos < end) {
    const len = buf[pos];
    if (len === undefined) {
      return { ok: false, error: 'truncated character-string' };
    }
    pos += 1;
    if (pos + len > end) {
      return { ok: false, error: 'character-string exceeds rdata length' };
    }
    strings.push(Buffer.from(buf.subarray(pos, pos + len)).toString('utf8'));
    pos += len;
  }
  return { ok: true, strings };
}

type InterpretResult = { ok: true; answer: DnsAnswer } | { ok: false; error: string };

function interpretRR(buf: Uint8Array, raw: RawRR): InterpretResult {
  const base = { name: raw.name, ttl: raw.ttl, type: raw.type, class: raw.class };
  const rdataLength = raw.rdataEnd - raw.rdataStart;
  switch (raw.type) {
    case RRType.A: {
      if (rdataLength !== 4) return { ok: false, error: 'A record rdata must be 4 octets' };
      return { ok: true, answer: { ...base, kind: 'A', address: formatIPv4(buf, raw.rdataStart) } };
    }
    case RRType.AAAA: {
      if (rdataLength !== 16) return { ok: false, error: 'AAAA record rdata must be 16 octets' };
      return { ok: true, answer: { ...base, kind: 'AAAA', address: formatIPv6(buf, raw.rdataStart) } };
    }
    case RRType.MX: {
      if (rdataLength < 3) return { ok: false, error: 'MX record rdata too short' };
      const preference = readU16(buf, raw.rdataStart);
      const exchangeResult = decodeName(buf, raw.rdataStart + 2);
      if (!exchangeResult.ok) return exchangeResult;
      return { ok: true, answer: { ...base, kind: 'MX', preference, exchange: exchangeResult.name } };
    }
    case RRType.TXT: {
      const stringsResult = decodeCharacterStrings(buf, raw.rdataStart, raw.rdataEnd);
      if (!stringsResult.ok) return stringsResult;
      // RFC 7208 §3.3: multiple character-strings are concatenated (not space-joined) for SPF.
      return {
        ok: true,
        answer: { ...base, kind: 'TXT', strings: stringsResult.strings, text: stringsResult.strings.join('') },
      };
    }
    case RRType.CNAME: {
      const targetResult = decodeName(buf, raw.rdataStart);
      if (!targetResult.ok) return targetResult;
      return { ok: true, answer: { ...base, kind: 'CNAME', target: targetResult.name } };
    }
    case RRType.PTR: {
      const targetResult = decodeName(buf, raw.rdataStart);
      if (!targetResult.ok) return targetResult;
      return { ok: true, answer: { ...base, kind: 'PTR', target: targetResult.name } };
    }
    case RRType.TLSA: {
      if (rdataLength < 3) return { ok: false, error: 'TLSA record rdata too short' };
      const usage = buf[raw.rdataStart];
      const selector = buf[raw.rdataStart + 1];
      const matchingType = buf[raw.rdataStart + 2];
      if (usage === undefined || selector === undefined || matchingType === undefined) {
        return { ok: false, error: 'TLSA record rdata too short' };
      }
      return {
        ok: true,
        answer: {
          ...base,
          kind: 'TLSA',
          usage,
          selector,
          matchingType,
          certData: buf.subarray(raw.rdataStart + 3, raw.rdataEnd),
        },
      };
    }
    default:
      return { ok: true, answer: { ...base, kind: 'UNKNOWN', raw: buf.subarray(raw.rdataStart, raw.rdataEnd) } };
  }
}

/** Decode a DNS message. This never throws: every malformed-input path returns `{ ok: false }`. */
export function decodeMessage(buf: Uint8Array): DecodeResult {
  try {
    if (buf.length < HEADER_LENGTH) {
      return { ok: false, error: 'message shorter than the 12-byte header' };
    }
    const id = readU16(buf, 0);
    const flags = readU16(buf, 2);
    const qdcount = readU16(buf, 4);
    const ancount = readU16(buf, 6);
    const nscount = readU16(buf, 8);
    const arcount = readU16(buf, 10);

    const qr = ((flags >> 15) & 1) === 1;
    const opcode = (flags >> 11) & 0xf;
    const aa = ((flags >> 10) & 1) === 1;
    const tc = ((flags >> 9) & 1) === 1;
    const rd = ((flags >> 8) & 1) === 1;
    const ra = ((flags >> 7) & 1) === 1;
    const ad = ((flags >> 5) & 1) === 1;
    const cd = ((flags >> 4) & 1) === 1;
    const baseRcode = flags & 0xf;

    let offset = HEADER_LENGTH;
    const questions: DnsQuestion[] = [];
    for (let i = 0; i < qdcount; i++) {
      const nameResult = decodeName(buf, offset);
      if (!nameResult.ok) return { ok: false, error: `question ${String(i)}: ${nameResult.error}` };
      offset = nameResult.end;
      if (offset + 4 > buf.length) return { ok: false, error: 'truncated question' };
      const qtype = readU16(buf, offset);
      const qclass = readU16(buf, offset + 2);
      offset += 4;
      questions.push({ name: nameResult.name, type: qtype, class: qclass });
    }

    const answers: DnsAnswer[] = [];
    const authority: DnsAnswer[] = [];
    const additional: DnsAnswer[] = [];
    let extendedRcodeHigh = 0;

    const readSection = (count: number, out: DnsAnswer[]): { ok: true } | { ok: false; error: string } => {
      for (let i = 0; i < count; i++) {
        const rawResult = decodeRawRR(buf, offset);
        if (!rawResult.ok) return rawResult;
        offset = rawResult.end;
        if (rawResult.rr.type === RRType.OPT) {
          // The EDNS0 OPT TTL field packs extended-rcode(8) | version(8) | flags(16); we only
          // need the extended-rcode high bits to combine with the base rcode.
          const b0 = buf[rawResult.rr.rdataStart - 6];
          extendedRcodeHigh = b0 ?? 0;
          continue;
        }
        const interpreted = interpretRR(buf, rawResult.rr);
        if (!interpreted.ok) return interpreted;
        out.push(interpreted.answer);
      }
      return { ok: true };
    };

    const answersResult = readSection(ancount, answers);
    if (!answersResult.ok) return { ok: false, error: `answer section: ${answersResult.error}` };
    const authorityResult = readSection(nscount, authority);
    if (!authorityResult.ok) return { ok: false, error: `authority section: ${authorityResult.error}` };
    const additionalResult = readSection(arcount, additional);
    if (!additionalResult.ok) return { ok: false, error: `additional section: ${additionalResult.error}` };

    const rcode = (extendedRcodeHigh << 4) | baseRcode;

    const message: DnsMessage = {
      id,
      qr,
      opcode,
      aa,
      tc,
      rd,
      ra,
      ad,
      cd,
      rcode,
      questions,
      answers,
      authority,
      additional,
    };
    return { ok: true, message };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown decode error' };
  }
}
