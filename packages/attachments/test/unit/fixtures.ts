// Synthetic byte fixtures for every attachment type PST-REQ-065 names. Nothing here is real
// malware: each fixture is a minimal, hand-built instance of the format's own magic bytes/structure.

import { deflateRawSync } from 'node:zlib';

export function mzExecutable(): Buffer {
  const buf = Buffer.alloc(64);
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  return buf;
}

export function elfExecutable(): Buffer {
  return Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
}

export function machoExecutable(): Buffer {
  return Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0, 0, 0, 0, 0]);
}

export function lnkShortcut(): Buffer {
  return Buffer.from([0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
}

export function isoImage(): Buffer {
  const buf = Buffer.alloc(0x8001 + 5 + 1, 0);
  buf.write('CD001', 0x8001, 'latin1');
  return buf;
}

export function shellScript(): Buffer {
  return Buffer.from('#!/bin/sh\necho hi\n', 'ascii');
}

export function pdfBenign(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'latin1');
}

export function pdfWithJavaScript(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n%%EOF', 'latin1');
}

export function pngBenign(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

export function rtfWithObjEmbed(): Buffer {
  return Buffer.from('{\\rtf1\\ansi {\\object\\objdata 0105000002000000}}', 'latin1');
}

export function rtfBenign(): Buffer {
  return Buffer.from('{\\rtf1\\ansi Hello world}', 'latin1');
}

export function rarSignature(): Buffer {
  return Buffer.from('Rar!\x1a\x07\x00extra bytes here', 'latin1');
}

export function sevenZipSignature(): Buffer {
  return Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0, 0, 0]);
}

export function rtlOverrideFilename(): string {
  return `resume‮gnp.exe`; // renders as "resumeexe.png"-looking but is really ...exe
}

export function doubleExtensionFilename(): string {
  return 'invoice.pdf.exe';
}

// --- ZIP construction -------------------------------------------------------------------------

export interface ZipEntrySpec {
  name: string;
  data: Buffer;
  stored?: boolean; // true => method 0 (stored), else deflate
  encrypted?: boolean;
}

export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const stored = entry.stored ?? false;
    const compressed = stored ? entry.data : deflateRawSync(entry.data);
    const method = stored ? 0 : 8;
    const flag = entry.encrypted === true ? 1 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flag, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flag, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

export function benignZip(): Buffer {
  return buildZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'b.txt', data: Buffer.from('world') },
  ]);
}

export function ooxmlWithMacro(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from('<document/>') },
    { name: 'word/vbaProject.bin', data: Buffer.from('fake-vba-bytes') },
  ]);
}

export function passwordProtectedZip(): Buffer {
  return buildZip([{ name: 'secret.txt', data: Buffer.from('shh'), encrypted: true }]);
}

export function zipWithNestedArchiveAndExecutable(): Buffer {
  const nested = buildZip([{ name: 'inner.txt', data: Buffer.from('inner') }]);
  return buildZip([
    { name: 'readme.txt', data: Buffer.from('read me') },
    { name: 'nested.zip', data: nested, stored: true },
    { name: 'payload.exe', data: mzExecutable(), stored: true },
  ]);
}

// --- OLE/CFB construction ----------------------------------------------------------------------

const OLE_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SECTOR_SIZE = 512;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const FREESECT = 0xffffffff;

/** A minimal, version-3 (512-byte sector) OLE compound file with one FAT sector, one directory
 * sector, and a storage entry named `storageName` (e.g. "Macros") to simulate a VBA project. */
export function buildOleWithStorage(storageName: string): Buffer {
  const header = Buffer.alloc(HEADER_TOTAL());
  OLE_SIG.copy(header, 0);
  header.writeUInt16LE(0x3e, 24); // minor version
  header.writeUInt16LE(0x03, 26); // major version (3 => 512-byte sectors)
  header.writeUInt16LE(0xfffe, 28); // byte order
  header.writeUInt16LE(9, 30); // sector shift -> 512
  header.writeUInt16LE(6, 32); // mini sector shift
  header.writeUInt32LE(0, 40); // number of directory sectors (unused, version 3)
  header.writeUInt32LE(1, 44); // number of FAT sectors
  header.writeUInt32LE(1, 48); // first directory sector location (sector 1)
  header.writeUInt32LE(0, 52);
  header.writeUInt32LE(4096, 56); // mini stream cutoff
  header.writeUInt32LE(ENDOFCHAIN, 60);
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68);
  header.writeUInt32LE(0, 72);
  // DIFAT: entry 0 = FAT sector index 0, rest FREESECT.
  header.writeUInt32LE(0, 76);
  for (let i = 1; i < 109; i++) header.writeUInt32LE(FREESECT, 76 + i * 4);

  const fatSector = Buffer.alloc(SECTOR_SIZE, 0xff); // 0xFFFFFFFF (FREESECT) per 4-byte word by default
  fatSector.writeUInt32LE(FATSECT, 0); // sector 0 (this FAT sector) is a FAT sector
  fatSector.writeUInt32LE(ENDOFCHAIN, 4); // sector 1 (directory) ends its chain

  const dirSector = Buffer.alloc(SECTOR_SIZE, 0);
  writeDirEntry(dirSector, 0, 'Root Entry', 5);
  writeDirEntry(dirSector, 1, storageName, 1);

  return Buffer.concat([header, fatSector, dirSector]);
}

function HEADER_TOTAL(): number {
  return 512;
}

function writeDirEntry(sector: Buffer, index: number, name: string, objectType: number): void {
  const off = index * 128;
  const nameBuf = Buffer.from(name, 'utf16le');
  nameBuf.copy(sector, off, 0, Math.min(nameBuf.length, 62));
  sector.writeUInt16LE(Math.min(nameBuf.length, 62) + 2, off + 64); // byte length incl. null terminator
  sector.writeUInt8(objectType, off + 66);
}
