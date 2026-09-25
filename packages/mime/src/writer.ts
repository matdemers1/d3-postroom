// Writers: header encoding and folding, and a modest message builder with generated boundaries,
// base64 (76 columns) and quoted-printable bodies. Used by the round-trip properties now and by the
// composer and DSN generator later. Correct rather than clever.

import { randomBytes } from 'node:crypto';
import type { Mailbox } from './address.js';
import { encodeWords } from './encoded-word.js';
import { formatParamValue } from './params.js';
import { encodeBase64, encodeQuotedPrintable } from './transfer.js';

const LINE = 78;

/** A value that can be written as-is: printable ASCII and inner whitespace, nothing that decodes. */
function isPlainSafe(value: string): boolean {
  if (!/^[!-~]([ \t!-~]*[!-~])?$/.test(value)) return false;
  if (value.includes('=?')) return false;
  return value.split(/[ \t]/).every((w) => w.length <= 900);
}

export interface EncodeHeaderOptions {
  /** Length of `Name` so the first line accounts for `Name: ` (default 0). */
  nameLength?: number;
}

/**
 * Encode an unstructured header value: as-is when it is plain ASCII, as RFC 2047 UTF-8
 * encoded-words otherwise, folded at whitespace so lines stay within 78 characters where possible.
 * Unfolding and decoding the result gives back exactly `value`.
 */
export function encodeHeaderValue(value: string, options: EncodeHeaderOptions = {}): string {
  const first = (options.nameLength ?? 0) + 2;
  const plain = isPlainSafe(value);
  const words = plain ? value.split(' ') : encodeWords(value);
  let out = words[0] ?? '';
  let lineLen = first + out.length;
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    if (lineLen + 1 + w.length > LINE && lineLen > first) {
      out += '\r\n ' + w;
      lineLen = 1 + w.length;
    } else {
      out += ' ' + w;
      lineLen += 1 + w.length;
    }
  }
  return out;
}

/** `Name: value`, encoded and folded (no trailing CRLF). */
export function formatHeader(name: string, value: string): string {
  return `${name}: ${encodeHeaderValue(value, { nameLength: name.length })}`;
}

/** A mailbox for an address header: the display name is quoted or encoded, the address is not. */
export function formatMailbox(mailbox: Mailbox): string {
  if (mailbox.name === '') return mailbox.address;
  const name = /^[\x20-\x7e]*$/.test(mailbox.name) ? `"${mailbox.name.replace(/(["\\])/g, '\\$1')}"` : encodeWords(mailbox.name).join(' ');
  return `${name} <${mailbox.address}>`;
}

export type HeaderInput = readonly (readonly [string, string])[];

export type BodyEncoding = 'base64' | 'quoted-printable' | '7bit' | '8bit' | 'binary';

export interface LeafSpec {
  readonly kind?: 'leaf';
  readonly contentType: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly encoding?: BodyEncoding;
  readonly body: Uint8Array | string;
  readonly filename?: string;
  readonly disposition?: 'inline' | 'attachment';
  readonly contentId?: string;
  readonly headers?: HeaderInput;
}

export interface MultipartSpec {
  readonly kind: 'multipart';
  /** `mixed`, `alternative`, `related`, `digest`… */
  readonly subtype: string;
  readonly parts: readonly PartSpec[];
  readonly boundary?: string;
  readonly headers?: HeaderInput;
}

export interface MessagePartSpec {
  readonly kind: 'message';
  readonly message: MessageSpec;
  readonly headers?: HeaderInput;
}

export type PartSpec = LeafSpec | MultipartSpec | MessagePartSpec;

export type MessageSpec =
  | { readonly headers?: HeaderInput; readonly body: PartSpec }
  | { readonly headers?: HeaderInput; readonly parts: readonly PartSpec[]; readonly subtype?: string };

/** A fresh boundary that cannot occur in base64 or quoted-printable output (`=_` is neither). */
export function generateBoundary(): string {
  return `=_pr_${randomBytes(15).toString('base64url')}`;
}

function filenameParam(name: string, filename: string): string {
  if (/^[\x20-\x7e]*$/.test(filename)) return `${name}=${formatParamValue(filename)}`;
  const pct = [...Buffer.from(filename, 'utf8')]
    .map((c) => (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(String.fromCharCode(c)) ? String.fromCharCode(c) : '%' + c.toString(16).toUpperCase().padStart(2, '0')))
    .join('');
  return `${name}*=utf-8''${pct}`;
}

function headerLines(headers: HeaderInput | undefined): string[] {
  return (headers ?? []).map(([n, v]) => formatHeader(n, v));
}

function writePart(spec: PartSpec, out: Buffer[]): void {
  if (spec.kind === 'multipart') {
    const boundary = spec.boundary ?? generateBoundary();
    const lines = [...headerLines(spec.headers), `Content-Type: multipart/${spec.subtype};\r\n boundary="${boundary}"`];
    out.push(Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8'));
    for (const child of spec.parts) {
      out.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
      writePart(child, out);
      out.push(Buffer.from('\r\n', 'utf8'));
    }
    out.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return;
  }
  if (spec.kind === 'message') {
    const lines = [...headerLines(spec.headers), 'Content-Type: message/rfc822'];
    out.push(Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8'));
    writeMessage(spec.message, out, false);
    return;
  }
  const encoding = spec.encoding ?? 'base64';
  const params = Object.entries(spec.params ?? {}).map(([k, v]) => `;\r\n ${k}=${formatParamValue(v)}`);
  if (spec.filename !== undefined && spec.disposition === undefined) params.push(`;\r\n ${filenameParam('name', spec.filename)}`);
  const lines = [...headerLines(spec.headers), `Content-Type: ${spec.contentType}${params.join('')}`, `Content-Transfer-Encoding: ${encoding}`];
  if (spec.disposition !== undefined) {
    lines.push(`Content-Disposition: ${spec.disposition}${spec.filename === undefined ? '' : `;\r\n ${filenameParam('filename', spec.filename)}`}`);
  }
  if (spec.contentId !== undefined) lines.push(`Content-ID: <${spec.contentId}>`);
  out.push(Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8'));
  const body = typeof spec.body === 'string' ? Buffer.from(spec.body, 'utf8') : spec.body;
  if (encoding === 'base64') out.push(Buffer.from(encodeBase64(body), 'latin1'));
  else if (encoding === 'quoted-printable') out.push(Buffer.from(encodeQuotedPrintable(body), 'latin1'));
  else out.push(Buffer.from(body.buffer, body.byteOffset, body.length));
}

function writeMessage(spec: MessageSpec, out: Buffer[], top: boolean): void {
  const headers = spec.headers ?? [];
  const lines = headerLines(headers);
  if (top && !headers.some(([n]) => n.toLowerCase() === 'mime-version')) lines.push('MIME-Version: 1.0');
  if (lines.length > 0) out.push(Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'));
  const body: PartSpec = 'body' in spec ? spec.body : { kind: 'multipart', subtype: spec.subtype ?? 'mixed', parts: spec.parts };
  writePart(body, out);
}

/** Serialise a message. Header values are encoded with `encodeHeaderValue`. */
export function buildMessage(spec: MessageSpec): Buffer {
  const out: Buffer[] = [];
  writeMessage(spec, out, true);
  return Buffer.concat(out);
}
