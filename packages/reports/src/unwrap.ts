// Report attachments as receivers actually send them (PST-T-7.1, PST-REQ-122): a bare .xml, an
// .xml.gz (Microsoft, Yahoo), a .zip holding one .xml (Google), and for TLS-RPT a .json or
// .json.gz (RFC 8460 §5.3: application/tlsrpt+gzip). Containers are recognized by their magic
// bytes, not by what the filename claims.
//
// Decompression-bomb limits: every inflate runs with zlib's `maxOutputLength`, so a stream that
// expands past `maxOutput` stops at that many bytes and is refused (`too-large`) — it never gets
// to allocate what it claims. The ZIP reader is hand-rolled and deliberately minimal (PKZIP
// APPNOTE 4.3.7/4.3.12/4.3.16): the end-of-central-directory record, at most `MAX_ZIP_ENTRIES`
// central entries, exactly one report entry, STORED or DEFLATE only, no encryption, no ZIP64, and
// the CRC-32 checked. (packages/attachments has a ZIP walker, but it is internal to that package's
// quarantine policy and not exported; its job — sniffing, never trusting — is a different one.)
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';
import { ReportError } from './errors.js';

export type ReportKind = 'dmarc' | 'tlsrpt';
export type ReportContainer = 'plain' | 'gzip' | 'zip';

export interface ReportAttachment {
  readonly filename: string | null;
  /** `type/subtype`, lowercased. */
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface UnwrappedReport {
  readonly kind: ReportKind;
  readonly container: ReportContainer;
  /** The decompressed report document. */
  readonly bytes: Buffer;
  /** The filename inside a ZIP, else the attachment's own. */
  readonly name: string | null;
}

export interface UnwrapOptions {
  /** Decompressed bytes accepted (default 32 MiB). */
  maxOutput?: number;
  /** Attachment (compressed) bytes accepted (default 16 MiB). */
  maxInput?: number;
}

export const DEFAULT_MAX_OUTPUT = 32 * 1024 * 1024;
export const DEFAULT_MAX_INPUT = 16 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 16;

const REPORT_TYPES = new Set([
  'text/xml',
  'application/xml',
  'application/gzip',
  'application/x-gzip',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'application/octet-stream',
  'application/json',
  'application/tlsrpt+json',
  'application/tlsrpt+gzip',
]);

const zipErr = (message: string): never => {
  throw new ReportError('zip', message);
};

function isGzip(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function isRangeError(error: unknown): boolean {
  return error instanceof RangeError || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE');
}

/** gunzip with a hard output cap. */
export function gunzipBounded(bytes: Uint8Array, maxOutput = DEFAULT_MAX_OUTPUT): Buffer {
  try {
    return gunzipSync(bytes, { maxOutputLength: maxOutput });
  } catch (error) {
    if (isRangeError(error)) throw new ReportError('too-large', `gzip expands past ${String(maxOutput)} bytes`);
    throw new ReportError('gzip', 'gzip stream does not inflate');
  }
}

function inflateBounded(bytes: Uint8Array, maxOutput: number): Buffer {
  try {
    return inflateRawSync(bytes, { maxOutputLength: maxOutput });
  } catch (error) {
    if (isRangeError(error)) throw new ReportError('too-large', `ZIP entry expands past ${String(maxOutput)} bytes`);
    throw new ReportError('zip', 'ZIP entry does not inflate');
  }
}

interface CentralEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/** The single report entry of a ZIP archive, decompressed. */
export function readZipReport(input: Uint8Array, maxOutput = DEFAULT_MAX_OUTPUT): { name: string; bytes: Buffer } {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  // End of central directory: 22 bytes plus a comment of at most 65 535.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) zipErr('no end-of-central-directory record');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) zipErr('ZIP64 archives are refused');
  if (total > MAX_ZIP_ENTRIES) zipErr(`more than ${String(MAX_ZIP_ENTRIES)} entries`);
  if (cdOffset + cdSize > eocd) zipErr('central directory out of range');

  const entries: CentralEntry[] = [];
  let pos = cdOffset;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== 0x02014b50) zipErr('corrupt central directory');
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    if (pos + 46 + nameLen > eocd) zipErr('corrupt central directory');
    entries.push({
      name: buf.toString('utf8', pos + 46, pos + 46 + nameLen),
      flags: buf.readUInt16LE(pos + 8),
      method: buf.readUInt16LE(pos + 10),
      crc: buf.readUInt32LE(pos + 16),
      compressedSize: buf.readUInt32LE(pos + 20),
      uncompressedSize: buf.readUInt32LE(pos + 24),
      localOffset: buf.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const files = entries.filter((e) => !e.name.endsWith('/'));
  if (files.length !== 1) zipErr(`expected one report in the archive, found ${String(files.length)}`);
  const entry = files[0] as CentralEntry;
  if ((entry.flags & 0x1) !== 0) zipErr('encrypted entries are refused');
  if (entry.method !== 0 && entry.method !== 8) zipErr(`compression method ${String(entry.method)} is not supported`);
  if (entry.uncompressedSize > maxOutput) throw new ReportError('too-large', `ZIP entry declares ${String(entry.uncompressedSize)} bytes`);

  const lh = entry.localOffset;
  if (lh + 30 > cdOffset || buf.readUInt32LE(lh) !== 0x04034b50) zipErr('local header out of range');
  const dataStart = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > cdOffset) zipErr('entry data out of range');
  const data = buf.subarray(dataStart, dataEnd);

  let out: Buffer;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) zipErr('stored entry sizes disagree');
    out = Buffer.from(data);
  } else {
    out = inflateBounded(data, maxOutput);
  }
  if (out.length !== entry.uncompressedSize) zipErr('entry size does not match the central directory');
  if (crc32(out) >>> 0 !== entry.crc) zipErr('entry CRC-32 does not match');
  return { name: entry.name, bytes: out };
}

function lowerName(name: string | null): string {
  return (name ?? '').toLowerCase();
}

function kindOf(contentType: string, names: readonly string[], body: Buffer): ReportKind | null {
  if (contentType.startsWith('application/tlsrpt')) return 'tlsrpt';
  if (names.some((n) => /\.json(\.gz)?$/.test(n))) return 'tlsrpt';
  if (names.some((n) => /\.xml(\.gz)?$/.test(n))) return 'dmarc';
  // Sniff the first non-whitespace character of the document itself.
  let i = 0;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) i = 3;
  while (i < body.length && (body[i] === 0x20 || body[i] === 0x09 || body[i] === 0x0a || body[i] === 0x0d)) i++;
  if (body[i] === 0x3c) return 'dmarc';
  if (body[i] === 0x7b) return 'tlsrpt';
  return null;
}

/** Could this attachment be a report at all? Cheap: type, name, or container magic. */
export function looksLikeReport(attachment: Pick<ReportAttachment, 'filename' | 'contentType'>, firstBytes?: Uint8Array): boolean {
  const name = lowerName(attachment.filename);
  if (/\.(xml|json)(\.gz)?$|\.zip$|\.gz$/.test(name)) return true;
  if (attachment.contentType.startsWith('application/tlsrpt')) return true;
  if (firstBytes !== undefined && (isGzip(firstBytes) || isZip(firstBytes))) return REPORT_TYPES.has(attachment.contentType);
  return attachment.contentType === 'text/xml' || attachment.contentType === 'application/xml' || attachment.contentType.includes('zip');
}

/**
 * Unwraps one attachment to its report document. Returns null when the attachment is not a report
 * (not a candidate type, or a document that is neither XML nor JSON). Throws ReportError for a
 * candidate whose container is broken or too big.
 */
export function unwrapReport(attachment: ReportAttachment, options: UnwrapOptions = {}): UnwrappedReport | null {
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const maxInput = options.maxInput ?? DEFAULT_MAX_INPUT;
  if (!looksLikeReport(attachment, attachment.bytes.subarray(0, 4))) return null;
  if (attachment.bytes.byteLength > maxInput) throw new ReportError('too-large', `attachment is over ${String(maxInput)} bytes`);
  const outer = lowerName(attachment.filename);
  let container: ReportContainer;
  let bytes: Buffer;
  let name = attachment.filename;
  if (isZip(attachment.bytes)) {
    container = 'zip';
    const entry = readZipReport(attachment.bytes, maxOutput);
    bytes = entry.bytes;
    name = entry.name;
  } else if (isGzip(attachment.bytes)) {
    container = 'gzip';
    bytes = gunzipBounded(attachment.bytes, maxOutput);
  } else {
    container = 'plain';
    if (attachment.bytes.byteLength > maxOutput) throw new ReportError('too-large', `report is over ${String(maxOutput)} bytes`);
    bytes = Buffer.from(attachment.bytes);
  }
  const kind = kindOf(attachment.contentType, [outer, lowerName(name)], bytes);
  return kind === null ? null : { kind, container, bytes, name };
}
