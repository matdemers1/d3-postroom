// Hand-rolled ZIP central-directory walker: PKZIP APPNOTE.TXT sections 4.3.6/4.3.12. We only need
// entry names, the encryption flag and enough of each entry's bytes to sniff its content — never a
// general-purpose unzip. Used for OOXML macro detection, password-protected and nested archives,
// and archives that smuggle an executable.
//
// Three adversarial cases this file exists to defeat, found in review of PST-T-2.10:
//  1. a ZIP containing a ZIP containing an executable (or deeper) — `inspectZip` recurses into any
//     entry that looks like an archive, bounded by MAX_DEPTH and a shared byte budget;
//  2. a central directory whose offset is corrupt or out of range — `readZipEntries` never returns
//     "no entries" silently for a file that sniffed as a ZIP; it falls back to scanning local file
//     headers directly and marks the listing `malformed`, which the policy always quarantines;
//  3. a zip-bomb entry (a small compressed stream that inflates to hundreds of megabytes) —
//     `readEntryBytes` decompresses through a persistent stream in small slices and stops the
//     moment the requested cap is reached, so it never allocates more than the cap regardless of
//     what the entry claims or actually contains.

import { constants, createInflateRaw } from 'node:zlib';
import { extensionsOf, isArchiveMagic, isZipMagic } from './magic.js';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const LOCAL_SIG_BUF = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MIN_EOCD = 22;
const MAX_COMMENT = 65535;
const ZIP64_SENTINEL = 0xffffffff;
const MAX_FALLBACK_ENTRIES = 5000;

export interface ZipEntry {
  readonly name: string;
  readonly encrypted: boolean;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export interface ZipListing {
  readonly entries: readonly ZipEntry[];
  /** True when the official central directory could not be trusted (missing, corrupt, or naming
   * fewer entries than it claims) and we fell back to scanning local file headers instead. A
   * malformed container is itself a finding — it is never treated as "zero entries, benign". */
  readonly malformed: boolean;
}

function findEocd(buf: Buffer): number | null {
  if (buf.length < MIN_EOCD) return null;
  const start = Math.max(0, buf.length - MIN_EOCD - MAX_COMMENT);
  for (let i = buf.length - MIN_EOCD; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return null;
}

interface CentralDirectoryParse {
  readonly entries: ZipEntry[];
  /** False when we parsed fewer entries than the EOCD declared, i.e. the directory is inconsistent. */
  readonly complete: boolean;
}

function parseCentralDirectory(buf: Buffer): CentralDirectoryParse | null {
  const eocd = findEocd(buf);
  if (eocd === null) return null;
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_SENTINEL || cdOffset > buf.length) return null;

  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length) break;
    if (buf.readUInt32LE(pos) !== CD_SIG) break;
    const flag = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const nameStart = pos + 46;
    if (nameStart + nameLen > buf.length) break;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    entries.push({ name, encrypted: (flag & 0x1) !== 0, method, compressedSize, uncompressedSize, localHeaderOffset });
    pos = nameStart + nameLen + extraLen + commentLen;
  }
  return { entries, complete: entries.length === totalEntries };
}

/** Recovers what it can when the central directory is unusable: scans for local file header
 * signatures directly. Bounded so an adversarial buffer full of near-miss signatures cannot cause
 * unbounded work. */
function scanLocalHeaders(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let i = 0; i < MAX_FALLBACK_ENTRIES; i++) {
    const found = buf.indexOf(LOCAL_SIG_BUF, pos);
    if (found === -1) break;
    if (found + 30 > buf.length) break;
    const flag = buf.readUInt16LE(found + 6);
    const method = buf.readUInt16LE(found + 8);
    const compressedSize = buf.readUInt32LE(found + 18);
    const uncompressedSize = buf.readUInt32LE(found + 22);
    const nameLen = buf.readUInt16LE(found + 26);
    const nameStart = found + 30;
    if (nameStart + nameLen <= buf.length) {
      const name = buf.toString('utf8', nameStart, nameStart + nameLen);
      entries.push({ name, encrypted: (flag & 0x1) !== 0, method, compressedSize, uncompressedSize, localHeaderOffset: found });
    }
    pos = found + 4;
  }
  return entries;
}

/** Parses (or, failing that, recovers) the entry list. Returns null only when the buffer does not
 * sniff as a ZIP at all — never for a ZIP whose directory is merely broken. */
export function readZipEntries(buf: Buffer): ZipListing | null {
  if (!isZipMagic(buf)) return null;
  const parsed = parseCentralDirectory(buf);
  if (parsed !== null && parsed.complete) {
    return { entries: parsed.entries, malformed: false };
  }
  return { entries: scanLocalHeaders(buf), malformed: true };
}

interface SyncInflater {
  _processChunk(chunk: Buffer, flushFlag: number): Buffer;
}

const INFLATE_CHUNK = 4096; // small on purpose: bounds worst-case per-call expansion for a hostile deflate stream

/** Decompresses at most `cap` output bytes of a raw-deflate stream, fed in small input slices
 * through a persistent inflater so a stream that claims (or truly tries) to expand far past `cap`
 * never causes more than a `cap`-ish allocation — the zip-bomb guard. Never throws. */
function inflateBounded(compressed: Buffer, cap: number): { bytes: Buffer; truncated: boolean } {
  if (cap <= 0) return { bytes: Buffer.alloc(0), truncated: compressed.length > 0 };
  const inflater = createInflateRaw() as unknown as SyncInflater;
  const out: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (let pos = 0; pos < compressed.length; pos += INFLATE_CHUNK) {
      const slice = compressed.subarray(pos, Math.min(compressed.length, pos + INFLATE_CHUNK));
      const produced = inflater._processChunk(slice, constants.Z_NO_FLUSH);
      if (produced.length > 0) {
        const room = cap - total;
        if (room <= 0) {
          truncated = true;
          break;
        }
        const piece = produced.length > room ? produced.subarray(0, room) : produced;
        out.push(piece);
        total += piece.length;
        if (piece.length < produced.length) {
          truncated = true;
          break;
        }
      }
    }
    if (!truncated) {
      const flushed = inflater._processChunk(Buffer.alloc(0), constants.Z_FINISH);
      if (flushed.length > 0) {
        const room = cap - total;
        const piece = room > 0 ? flushed.subarray(0, room) : Buffer.alloc(0);
        out.push(piece);
        total += piece.length;
        if (piece.length < flushed.length) truncated = true;
      }
    }
  } catch {
    // Malformed compressed data (or a stream that errors after we already stopped reading it):
    // return whatever bytes were already recovered rather than throwing.
  }
  return { bytes: Buffer.concat(out), truncated };
}

/** The entry's decoded content, capped at `cap` decompressed bytes. Never throws, and never
 * allocates more than `cap`-ish bytes regardless of what the entry claims or contains. */
export function readEntryBytes(buf: Buffer, entry: ZipEntry, cap: number): { bytes: Buffer; truncated: boolean } | null {
  try {
    const off = entry.localHeaderOffset;
    if (off < 0 || off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIG) return null;
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const dataStart = off + 30 + nameLen + extraLen;
    if (dataStart > buf.length) return null;
    const declaredEnd = entry.compressedSize > 0 ? dataStart + entry.compressedSize : buf.length;
    const dataEnd = Math.min(buf.length, declaredEnd);
    if (dataStart >= dataEnd) return { bytes: Buffer.alloc(0), truncated: false };
    const compressed = buf.subarray(dataStart, dataEnd);

    if (entry.method === 0) {
      const stored = compressed.subarray(0, Math.min(cap, compressed.length));
      return { bytes: stored, truncated: stored.length < compressed.length };
    }
    if (entry.method === 8) {
      return inflateBounded(compressed, cap);
    }
    return null;
  } catch {
    return null;
  }
}

export interface ZipInspection {
  readonly encrypted: boolean;
  readonly macroEntry: string | null;
  readonly nestedArchiveEntry: string | null;
  readonly executableEntry: string | null;
  readonly malformed: boolean;
  readonly suspiciousRatioEntry: string | null;
  readonly depthExceededEntry: string | null;
  readonly truncatedEntry: string | null;
}

const NESTED_ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'iso', 'cab']);
const ENTRY_EXECUTABLE_EXTENSIONS = new Set(['exe', 'dll', 'scr', 'com', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'wsf', 'hta', 'jar', 'lnk']);

const MAX_DEPTH = 3;
const DEFAULT_BUDGET = 25 * 1024 * 1024; // shared across the whole recursion, matches the outer per-attachment cap
const SNIFF_CAP = 512;
const RATIO_LIMIT = 100;
const MAX_DECLARED_UNCOMPRESSED = 100 * 1024 * 1024;

interface MutableInspection {
  encrypted: boolean;
  macroEntry: string | null;
  nestedArchiveEntry: string | null;
  executableEntry: string | null;
  malformed: boolean;
  suspiciousRatioEntry: string | null;
  depthExceededEntry: string | null;
  truncatedEntry: string | null;
}

function isExecutableMagic(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
}

function walkZip(buf: Buffer, depth: number, budget: { remaining: number }, result: MutableInspection): void {
  const listing = readZipEntries(buf);
  if (listing === null) return;
  if (listing.malformed) result.malformed = true;

  for (const entry of listing.entries) {
    if (entry.encrypted) result.encrypted = true;
    if (result.macroEntry === null && entry.name.toLowerCase().endsWith('vbaproject.bin')) {
      result.macroEntry = entry.name;
    }

    if (entry.method === 8 && entry.compressedSize > 0) {
      const ratio = entry.uncompressedSize / entry.compressedSize;
      if (ratio > RATIO_LIMIT || entry.uncompressedSize > MAX_DECLARED_UNCOMPRESSED) {
        if (result.suspiciousRatioEntry === null) result.suspiciousRatioEntry = entry.name;
        continue; // declared as a bomb; do not spend the budget decompressing it further
      }
    }

    const exts = extensionsOf(entry.name);
    const last = exts.length > 0 ? (exts[exts.length - 1] ?? null) : null;
    const nameSaysArchive = last !== null && NESTED_ARCHIVE_EXTENSIONS.has(last);
    const nameSaysExecutable = last !== null && ENTRY_EXECUTABLE_EXTENSIONS.has(last);

    const sniffCap = Math.min(SNIFF_CAP, budget.remaining);
    const sniff = sniffCap > 0 ? readEntryBytes(buf, entry, sniffCap) : null;
    if (sniff !== null) budget.remaining -= sniff.bytes.length;

    const contentIsArchive = sniff !== null && isArchiveMagic(sniff.bytes);
    const contentIsExecutable = sniff !== null && isExecutableMagic(sniff.bytes);

    if ((nameSaysExecutable || contentIsExecutable) && result.executableEntry === null) {
      result.executableEntry = entry.name;
    }

    const looksNested = nameSaysArchive || contentIsArchive;
    if (!looksNested) continue;
    if (result.nestedArchiveEntry === null) result.nestedArchiveEntry = entry.name;

    if (depth + 1 > MAX_DEPTH) {
      if (result.depthExceededEntry === null) result.depthExceededEntry = entry.name;
      continue;
    }
    if (budget.remaining <= 0) {
      if (result.truncatedEntry === null) result.truncatedEntry = entry.name;
      continue;
    }
    if (entry.method !== 0 && entry.method !== 8) continue;

    const full = readEntryBytes(buf, entry, budget.remaining);
    if (full === null) continue;
    budget.remaining -= full.bytes.length;
    if (full.truncated) {
      if (result.truncatedEntry === null) result.truncatedEntry = entry.name;
      continue;
    }
    if (isZipMagic(full.bytes)) {
      walkZip(full.bytes, depth + 1, budget, result);
    }
    // A nested RAR/7z/etc. is already recorded via `nestedArchiveEntry`/`isArchiveMagic` above; we
    // have no parser to recurse into it further, which is fine — it is reported, not silently passed.
  }
}

/** Recursively inspects a ZIP (and any ZIP nested inside it, up to MAX_DEPTH) for macros,
 * encryption, nesting and embedded executables, bounded by a shared decompression budget so a
 * hostile archive cannot force unbounded work or memory. Returns null only when `buf` does not
 * sniff as a ZIP at all. */
export function inspectZip(buf: Buffer, budgetBytes = DEFAULT_BUDGET): ZipInspection | null {
  if (!isZipMagic(buf)) return null;
  const result: MutableInspection = {
    encrypted: false,
    macroEntry: null,
    nestedArchiveEntry: null,
    executableEntry: null,
    malformed: false,
    suspiciousRatioEntry: null,
    depthExceededEntry: null,
    truncatedEntry: null,
  };
  walkZip(buf, 0, { remaining: budgetBytes }, result);
  return result;
}
