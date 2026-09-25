// Hand-rolled OLE2/CFB (Compound File Binary, MS-CFB) directory walker: just enough to read the
// stream and storage names inside a legacy .doc/.xls/.ppt/.msi container, so we can spot a VBA
// project without unpacking anything. Never a general-purpose OLE reader.

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEADER_SIZE = 512;
const DIFAT_ENTRIES_IN_HEADER = 109;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const MAX_SECTORS_WALKED = 100_000; // guards against a corrupt/adversarial FAT chain looping forever

export function isOleMagic(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return OLE_SIGNATURE.every((b, i) => buf[i] === b);
}

function sectorOffset(sectorSize: number, sectorIndex: number): number {
  return HEADER_SIZE + sectorIndex * sectorSize;
}

/** Names of every stream/storage entry in the compound file's directory. Never throws; returns
 * whatever it managed to read, empty on any structural surprise. */
export function readOleEntryNames(buf: Buffer): string[] {
  try {
    if (!isOleMagic(buf)) return [];
    const sectorShift = buf.readUInt16LE(30);
    const sectorSize = 1 << sectorShift;
    if (sectorSize < 128 || sectorSize > 1 << 20) return [];
    const numFatSectors = buf.readUInt32LE(44);
    const firstDirSector = buf.readUInt32LE(48);

    const fatSectorIndices: number[] = [];
    for (let i = 0; i < DIFAT_ENTRIES_IN_HEADER && fatSectorIndices.length < numFatSectors; i++) {
      const off = 76 + i * 4;
      if (off + 4 > buf.length) break;
      const v = buf.readUInt32LE(off);
      if (v === FREESECT) continue;
      fatSectorIndices.push(v);
    }

    const entriesPerSector = sectorSize / 4;
    const fat = new Map<number, number>();
    for (let order = 0; order < fatSectorIndices.length; order++) {
      const sectorIndex = fatSectorIndices[order];
      if (sectorIndex === undefined) continue;
      const off = sectorOffset(sectorSize, sectorIndex);
      if (off + sectorSize > buf.length) continue;
      for (let e = 0; e < entriesPerSector; e++) {
        const value = buf.readUInt32LE(off + e * 4);
        fat.set(order * entriesPerSector + e, value);
      }
    }

    const dirSectors: number[] = [];
    let cur = firstDirSector;
    let walked = 0;
    while (cur !== ENDOFCHAIN && cur !== FREESECT && cur !== FATSECT && cur !== DIFSECT && walked < MAX_SECTORS_WALKED) {
      dirSectors.push(cur);
      const next = fat.get(cur);
      if (next === undefined) break;
      cur = next;
      walked++;
    }

    const names: string[] = [];
    const entriesPerDirSector = sectorSize / 128;
    for (const sectorIndex of dirSectors) {
      const off = sectorOffset(sectorSize, sectorIndex);
      if (off + sectorSize > buf.length) continue;
      for (let e = 0; e < entriesPerDirSector; e++) {
        const entryOff = off + e * 128;
        const nameLenBytes = buf.readUInt16LE(entryOff + 64);
        const objectType = buf.readUInt8(entryOff + 66);
        if (objectType === 0) continue; // unused entry
        const charCount = nameLenBytes >= 2 ? nameLenBytes / 2 - 1 : 0;
        if (charCount <= 0) continue;
        const name = buf.toString('utf16le', entryOff, entryOff + charCount * 2);
        names.push(name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

const MACRO_STORAGE_NAMES = ['vba', '_vba_project', 'macros'];

export function findOleMacroStorage(buf: Buffer): string | null {
  const names = readOleEntryNames(buf);
  for (const name of names) {
    const lower = name.toLowerCase();
    if (MACRO_STORAGE_NAMES.some((m) => lower.includes(m))) return name;
  }
  return null;
}
