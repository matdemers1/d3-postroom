// Hand-rolled ZIP central-directory walker: PKZIP APPNOTE.TXT sections 4.3.6/4.3.12. We only need
// entry names, the encryption flag and enough of each entry's bytes to sniff its content — never a
// general-purpose unzip. Used for OOXML macro detection, password-protected and nested archives,
// and archives that smuggle an executable.

import { inflateRawSync } from 'node:zlib';
import { isArchiveMagic, isZipMagic, extensionsOf } from './magic.js';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MIN_EOCD = 22;
const MAX_COMMENT = 65535;

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
}

function findEocd(buf: Buffer): number | null {
  if (buf.length < MIN_EOCD) return null;
  const start = Math.max(0, buf.length - MIN_EOCD - MAX_COMMENT);
  for (let i = buf.length - MIN_EOCD; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return null;
}

/** Parses the central directory. Returns null (never throws) when the buffer is not a well-formed ZIP. */
export function readZipEntries(buf: Buffer): ZipListing | null {
  if (!isZipMagic(buf)) return null;
  const eocd = findEocd(buf);
  if (eocd === null) return null;
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset > buf.length) return null;

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
    const name = buf.toString('utf8', nameStart, Math.min(buf.length, nameStart + nameLen));
    entries.push({ name, encrypted: (flag & 0x1) !== 0, method, compressedSize, uncompressedSize, localHeaderOffset });
    pos = nameStart + nameLen + extraLen + commentLen;
  }
  return { entries };
}

/** Best-effort decoded first bytes of a ZIP entry, for content sniffing rather than name trust. Never throws. */
export function readEntryBytes(buf: Buffer, entry: ZipEntry, cap = 32): Buffer | null {
  try {
    const off = entry.localHeaderOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIG) return null;
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const dataStart = off + 30 + nameLen + extraLen;
    const dataEnd = Math.min(buf.length, dataStart + entry.compressedSize);
    if (dataStart >= dataEnd) return Buffer.alloc(0);
    const compressed = buf.subarray(dataStart, dataEnd);
    if (entry.method === 0) return compressed.subarray(0, Math.min(cap, compressed.length));
    if (entry.method === 8) {
      const inflated = inflateRawSync(compressed);
      return inflated.subarray(0, Math.min(cap, inflated.length));
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
}

const NESTED_ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'iso', 'cab']);
const ENTRY_EXECUTABLE_EXTENSIONS = new Set(['exe', 'dll', 'scr', 'com', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'wsf', 'hta', 'jar', 'lnk']);

/** Inspects entry names and, where cheap, entry content, for macros, nesting and embedded executables. */
export function inspectZip(buf: Buffer): ZipInspection | null {
  const listing = readZipEntries(buf);
  if (listing === null) return null;

  let encrypted = false;
  let macroEntry: string | null = null;
  let nestedArchiveEntry: string | null = null;
  let executableEntry: string | null = null;

  for (const entry of listing.entries) {
    if (entry.encrypted) encrypted = true;
    const lowerName = entry.name.toLowerCase();
    if (macroEntry === null && lowerName.endsWith('vbaproject.bin')) macroEntry = entry.name;

    const exts = extensionsOf(entry.name);
    const last = exts.length > 0 ? (exts[exts.length - 1] ?? null) : null;

    if (nestedArchiveEntry === null && last !== null && NESTED_ARCHIVE_EXTENSIONS.has(last)) {
      nestedArchiveEntry = entry.name;
    }
    if (executableEntry === null && last !== null && ENTRY_EXECUTABLE_EXTENSIONS.has(last)) {
      executableEntry = entry.name;
    }

    // Renamed nested archives/executables: sniff the entry's own bytes, not just its name.
    if (nestedArchiveEntry === null || executableEntry === null) {
      const content = readEntryBytes(buf, entry);
      if (content !== null) {
        if (nestedArchiveEntry === null && isArchiveMagic(content)) nestedArchiveEntry = entry.name;
        if (executableEntry === null && (content[0] === 0x4d && content[1] === 0x5a)) executableEntry = entry.name;
      }
    }
  }

  return { encrypted, macroEntry, nestedArchiveEntry, executableEntry };
}
