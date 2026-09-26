// A hand-rolled streaming ZIP writer for the full-data export (PST-T-10.1, PST-REQ-151). No
// archiver dependency: `node:zlib` supplies CRC-32 (`zlib.crc32`, Node >= 21) and every entry is
// STORED (uncompressed) — mbox and manifest content is already small relative to the message
// bytes it wraps, and STORED keeps the writer simple and fast. Deflate is not implemented; adding
// a method is a small, isolated change (see `addEntry`'s `method` byte, always 0 today).
//
// Streaming shape: an entry's size is not known until its source has been fully read (a mailbox's
// mbox is composed as it streams), so every entry uses a data descriptor (general-purpose bit 3):
// the local header's sizes are placeholders and the true CRC-32 and sizes follow the entry's bytes.
// Every entry's local header also carries a Zip64 extended-information extra field (id 0x0001) with
// 8-byte size placeholders and a version-needed-to-extract of 45, so a reader knows to read the
// data descriptor's sizes as 8-byte fields regardless of how large the entry turns out to be —
// this is what lets one mbox exceed 4 GiB without special-casing the write path (APPNOTE 4.3.9.2).
// The central directory always records the real sizes in a matching Zip64 extra field too, so an
// entry over 4 GiB is unambiguous there as well. The end-of-central-directory record is the
// classic 32-bit one for the common case, or ZIP64 EOCD + locator + a sentinel classic EOCD once
// more than 65535 entries were written or the central directory itself would overflow 32 bits.
import type { Readable, Writable } from 'node:stream';
import { crc32 as zlibCrc32 } from 'node:zlib';

export type ZipMethod = 'store';

export interface ZipEntryResult {
  crc32: number;
  size: bigint;
}

interface CentralRecord {
  name: Buffer;
  crc32: number;
  size: bigint;
  localHeaderOffset: bigint;
  time: number;
  dateVal: number;
}

const LOCAL_SIG = 0x04034b50;
const DATA_DESC_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const VERSION_ZIP64 = 45;
const MAX_U32 = 0xffff_ffff;
const MAX_U16 = 0xffff;

/** MS-DOS date/time, the only timestamp classic ZIP understands (2-second resolution). */
function dosDateTime(date: Date): { time: number; dateVal: number } {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dateVal = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dateVal };
}

/** Runs zlib's CRC-32 over one chunk, continuing from `prev`. */
export function crc32(chunk: Uint8Array, prev = 0): number {
  return zlibCrc32(chunk, prev) >>> 0;
}

/** Every entry's local header carries this: a Zip64 hint so an 8-byte data descriptor is expected. */
function zip64LocalExtra(): Buffer {
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(0n, 4); // uncompressed size placeholder
  extra.writeBigUInt64LE(0n, 12); // compressed size placeholder
  return extra;
}

async function writeAll(sink: Writable, buf: Uint8Array): Promise<void> {
  if (buf.length === 0) return;
  if (!sink.write(buf)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        sink.removeListener('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        sink.removeListener('drain', onDrain);
        reject(error);
      };
      sink.once('drain', onDrain);
      sink.once('error', onError);
    });
  }
}

/** Streams entries one at a time into `sink`; call `finish()` once every entry has been added. */
export class ZipWriter {
  private offset = 0n;
  private readonly central: CentralRecord[] = [];
  private finished = false;

  constructor(private readonly sink: Writable) {}

  /** Adds one STORED entry, reading `source` to the end. Never buffers more than one chunk. */
  async addEntry(name: string, source: Readable | AsyncIterable<Uint8Array> | Iterable<Uint8Array>, opts: { date?: Date } = {}): Promise<ZipEntryResult> {
    if (this.finished) throw new Error('ZipWriter already finished');
    const date = opts.date ?? new Date();
    const nameBuf = Buffer.from(name, 'utf8');
    const localOffset = this.offset;
    const { time, dateVal } = dosDateTime(date);
    const extra = zip64LocalExtra();

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(VERSION_ZIP64, 4);
    header.writeUInt16LE(0x0808, 6); // bit3: data descriptor follows; bit11: UTF-8 name
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(dateVal, 12);
    header.writeUInt32LE(0, 14); // crc32: in the data descriptor
    header.writeUInt32LE(MAX_U32, 18); // compressed size: zip64 sentinel
    header.writeUInt32LE(MAX_U32, 22); // uncompressed size: zip64 sentinel
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);

    await writeAll(this.sink, header);
    await writeAll(this.sink, nameBuf);
    await writeAll(this.sink, extra);
    this.offset += BigInt(header.length + nameBuf.length + extra.length);

    let crcAcc = 0;
    let size = 0n;
    for await (const piece of source) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      if (chunk.length === 0) continue;
      crcAcc = crc32(chunk, crcAcc);
      size += BigInt(chunk.length);
      await writeAll(this.sink, chunk);
      this.offset += BigInt(chunk.length);
    }

    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(DATA_DESC_SIG, 0);
    descriptor.writeUInt32LE(crcAcc, 4);
    descriptor.writeBigUInt64LE(size, 8);
    descriptor.writeBigUInt64LE(size, 16);
    await writeAll(this.sink, descriptor);
    this.offset += BigInt(descriptor.length);

    this.central.push({ name: nameBuf, crc32: crcAcc, size, localHeaderOffset: localOffset, time, dateVal });
    return { crc32: crcAcc, size };
  }

  /** Writes the central directory and end record, and ends the sink. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const centralStart = this.offset;
    for (const entry of this.central) await this.writeCentralRecord(entry);
    const centralEnd = this.offset;
    const centralSize = centralEnd - centralStart;
    const count = this.central.length;

    const needsZip64 = count > MAX_U16 || centralStart > MAX_U32 || centralSize > MAX_U32;
    if (needsZip64) await this.writeZip64End(centralStart, centralSize, count);
    await this.writeEocd(centralStart, centralSize, count, needsZip64);
    await new Promise<void>((resolve, reject) => {
      this.sink.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async writeCentralRecord(entry: CentralRecord): Promise<void> {
    // Always carries a Zip64 extra field with the real sizes and offset, so every entry is
    // unambiguous regardless of size — the matching central 4-byte fields are the sentinel.
    const zip64 = Buffer.alloc(28);
    zip64.writeUInt16LE(ZIP64_EXTRA_ID, 0);
    zip64.writeUInt16LE(24, 2);
    zip64.writeBigUInt64LE(entry.size, 4); // uncompressed
    zip64.writeBigUInt64LE(entry.size, 12); // compressed
    zip64.writeBigUInt64LE(entry.localHeaderOffset, 20);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIG, 0);
    header.writeUInt16LE(VERSION_ZIP64, 4); // version made by
    header.writeUInt16LE(VERSION_ZIP64, 6); // version needed
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(0, 10); // method: stored
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.dateVal, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(MAX_U32, 20); // compressed size sentinel
    header.writeUInt32LE(MAX_U32, 24); // uncompressed size sentinel
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(zip64.length, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number start
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(MAX_U32, 42); // local header offset sentinel

    await writeAll(this.sink, header);
    await writeAll(this.sink, entry.name);
    await writeAll(this.sink, zip64);
    this.offset += BigInt(header.length + entry.name.length + zip64.length);
  }

  private async writeZip64End(centralStart: bigint, centralSize: bigint, count: number): Promise<void> {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(ZIP64_EOCD_SIG, 0);
    record.writeBigUInt64LE(44n, 4); // size of this record, excluding the first 12 bytes
    record.writeUInt16LE(VERSION_ZIP64, 12);
    record.writeUInt16LE(VERSION_ZIP64, 14);
    record.writeUInt32LE(0, 16); // this disk
    record.writeUInt32LE(0, 20); // disk with central directory start
    record.writeBigUInt64LE(BigInt(count), 24); // entries on this disk
    record.writeBigUInt64LE(BigInt(count), 32); // entries total
    record.writeBigUInt64LE(centralSize, 40);
    record.writeBigUInt64LE(centralStart, 48);
    await writeAll(this.sink, record);
    this.offset += BigInt(record.length);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
    locator.writeUInt32LE(0, 4); // disk with the zip64 end record
    locator.writeBigUInt64LE(centralStart + centralSize, 8);
    locator.writeUInt32LE(1, 16); // total disks
    await writeAll(this.sink, locator);
    this.offset += BigInt(locator.length);
  }

  private async writeEocd(centralStart: bigint, centralSize: bigint, count: number, zip64: boolean): Promise<void> {
    const record = Buffer.alloc(22);
    record.writeUInt32LE(EOCD_SIG, 0);
    record.writeUInt16LE(0, 4);
    record.writeUInt16LE(0, 6);
    record.writeUInt16LE(zip64 ? MAX_U16 : count, 8);
    record.writeUInt16LE(zip64 ? MAX_U16 : count, 10);
    record.writeUInt32LE(zip64 ? MAX_U32 : Number(centralSize), 12);
    record.writeUInt32LE(zip64 ? MAX_U32 : Number(centralStart), 16);
    record.writeUInt16LE(0, 20); // comment length
    await writeAll(this.sink, record);
    this.offset += BigInt(record.length);
  }
}
