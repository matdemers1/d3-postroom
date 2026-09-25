// A hand-rolled DNS response packet builder used only by tests, to construct fixtures as raw
// bytes independent of the production encoder in src/wire.ts (which only ever builds queries).
import { encodeName } from '../../../src/name.js';
import { RRType, DNS_CLASS_IN } from '../../../src/types.js';

export interface FixtureQuestion {
  name: string;
  type: number;
  class?: number;
}

export interface FixtureRR {
  name: string;
  type: number;
  class?: number;
  ttl?: number;
  rdata: Uint8Array;
}

export interface FixtureHeaderFlags {
  qr?: boolean;
  aa?: boolean;
  tc?: boolean;
  rd?: boolean;
  ra?: boolean;
  ad?: boolean;
  cd?: boolean;
  rcode?: number;
  opcode?: number;
}

export interface FixtureMessage {
  id: number;
  flags?: FixtureHeaderFlags;
  question?: FixtureQuestion;
  answers?: FixtureRR[];
  authority?: FixtureRR[];
  additional?: FixtureRR[];
}

function encodeRR(rr: FixtureRR): Buffer {
  const name = Buffer.from(encodeName(rr.name));
  const head = Buffer.alloc(10);
  head.writeUInt16BE(rr.type, 0);
  head.writeUInt16BE(rr.class ?? DNS_CLASS_IN, 2);
  head.writeUInt32BE(rr.ttl ?? 300, 4);
  head.writeUInt16BE(rr.rdata.length, 8);
  return Buffer.concat([name, head, Buffer.from(rr.rdata)]);
}

export function buildMessage(msg: FixtureMessage): Buffer {
  const flags = msg.flags ?? {};
  const header = Buffer.alloc(12);
  header.writeUInt16BE(msg.id, 0);
  let flagBits = 0;
  if (flags.qr ?? true) flagBits |= 1 << 15;
  flagBits |= (flags.opcode ?? 0) << 11;
  if (flags.aa ?? false) flagBits |= 1 << 10;
  if (flags.tc ?? false) flagBits |= 1 << 9;
  if (flags.rd ?? true) flagBits |= 1 << 8;
  if (flags.ra ?? true) flagBits |= 1 << 7;
  if (flags.ad ?? false) flagBits |= 1 << 5;
  if (flags.cd ?? false) flagBits |= 1 << 4;
  flagBits |= (flags.rcode ?? 0) & 0xf;
  header.writeUInt16BE(flagBits, 2);

  const question = msg.question;
  const answers = msg.answers ?? [];
  const authority = msg.authority ?? [];
  const additional = msg.additional ?? [];

  header.writeUInt16BE(question ? 1 : 0, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authority.length, 8);
  header.writeUInt16BE(additional.length, 10);

  const parts: Buffer[] = [header];
  if (question) {
    const qname = Buffer.from(encodeName(question.name));
    const qtail = Buffer.alloc(4);
    qtail.writeUInt16BE(question.type, 0);
    qtail.writeUInt16BE(question.class ?? DNS_CLASS_IN, 2);
    parts.push(qname, qtail);
  }
  for (const rr of answers) parts.push(encodeRR(rr));
  for (const rr of authority) parts.push(encodeRR(rr));
  for (const rr of additional) parts.push(encodeRR(rr));

  return Buffer.concat(parts);
}

export function rdataA(ip: string): Buffer {
  const octets = ip.split('.').map(Number);
  return Buffer.from(octets);
}

export function rdataAAAA(groups: number[]): Buffer {
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(groups[i] ?? 0, i * 2);
  }
  return buf;
}

export function rdataMx(preference: number, exchange: string): Buffer {
  const pref = Buffer.alloc(2);
  pref.writeUInt16BE(preference, 0);
  return Buffer.concat([pref, Buffer.from(encodeName(exchange))]);
}

export function rdataName(name: string): Buffer {
  return Buffer.from(encodeName(name));
}

export function rdataTxt(strings: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const s of strings) {
    const bytes = Buffer.from(s, 'utf8');
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  return Buffer.concat(chunks);
}

export function rdataTlsa(usage: number, selector: number, matchingType: number, certData: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([usage, selector, matchingType]), Buffer.from(certData)]);
}

export { RRType };
