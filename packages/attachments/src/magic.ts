// Content sniffing by magic bytes and filename, entirely hand-rolled (PST-T-2.10). No file-type
// or archive libraries: every signature below is a documented format magic number, checked by
// comparing bytes directly.

export type AttachmentKind =
  | 'pe-executable'
  | 'elf-executable'
  | 'macho-executable'
  | 'msi-installer'
  | 'script'
  | 'lnk'
  | 'iso-image'
  | 'ole-macro'
  | 'ooxml-macro'
  | 'password-protected-archive'
  | 'nested-archive'
  | 'archive-executable'
  | 'uninspectable-archive'
  | 'pdf-active-content'
  | 'rtf-ole-embed'
  | 'suspicious-filename'
  | 'benign';

/** Every reason carries the severity that decides whether a history-having sender still gets it quarantined. */
export type Severity = 'always' | 'no-history';

export interface Finding {
  readonly kind: AttachmentKind;
  readonly reason: string;
  readonly severity: Severity;
}

const SCRIPT_EXTENSIONS = new Set(['sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta']);
const EXECUTABLE_EXTENSIONS = new Set(['exe', 'dll', 'scr', 'com', 'msi', 'cpl', 'pif']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'iso', 'img', 'cab']);
const BENIGN_DOC_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'gif', 'txt', 'csv', 'mp3', 'mp4', 'zip']);

export function extensionsOf(filename: string): string[] {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const parts = base.split('.');
  if (parts.length <= 1) return [];
  return parts.slice(1).map((p) => p.toLowerCase());
}

function lastExtension(filename: string): string | null {
  const exts = extensionsOf(filename);
  return exts.length > 0 ? (exts[exts.length - 1] ?? null) : null;
}

/** RFC-defined magic numbers for binaries, installers, containers and documents we care about. */
export function sniffMagic(bytes: Buffer): { kind: AttachmentKind; reason: string } | null {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return { kind: 'pe-executable', reason: 'starts with the MZ/PE executable header' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return { kind: 'elf-executable', reason: 'starts with the ELF executable header' };
  }
  if (bytes.length >= 4 && isMachOMagic(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0)) {
    return { kind: 'macho-executable', reason: 'starts with a Mach-O executable header' };
  }
  if (bytes.length >= 8 && bytes[0] === 0x4c && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00 && bytes[4] === 0x01 && bytes[5] === 0x14 && bytes[6] === 0x02 && bytes[7] === 0x00) {
    return { kind: 'lnk', reason: 'starts with the Windows shortcut (.lnk) header' };
  }
  if (bytes.length > 0x8005 && bytes.toString('latin1', 0x8001, 0x8006) === 'CD001') {
    return { kind: 'iso-image', reason: 'contains the ISO 9660 CD001 volume descriptor at offset 0x8001' };
  }
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) {
    return { kind: 'ole-macro', reason: 'is an OLE compound document (.doc/.xls/.ppt/.msi container)' };
  }
  return null;
}

function isMachOMagic(b0: number, b1: number, b2: number, b3: number): boolean {
  const magics: [number, number, number, number][] = [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
  ];
  return magics.some(([a, b, c, d]) => a === b0 && b === b1 && c === b2 && d === b3);
}

export function isZipMagic(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const sig = bytes.readUInt32LE(0);
  return sig === 0x04034b50 || sig === 0x06054b50;
}

export function isRarMagic(bytes: Buffer): boolean {
  return bytes.length >= 6 && bytes.toString('latin1', 0, 6) === 'Rar!\x1a\x07';
}

export function isSevenZipMagic(bytes: Buffer): boolean {
  return bytes.length >= 6 && bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf && bytes[4] === 0x27 && bytes[5] === 0x1c;
}

export function isGzipMagic(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function isTarMagic(bytes: Buffer): boolean {
  return bytes.length >= 262 && bytes.toString('ascii', 257, 262) === 'ustar';
}

export function isCabMagic(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'MSCF';
}

export function isPdfMagic(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.toString('latin1', 0, 4) === '%PDF';
}

export function isArchiveMagic(bytes: Buffer): boolean {
  return isZipMagic(bytes) || isRarMagic(bytes) || isSevenZipMagic(bytes) || isGzipMagic(bytes) || isTarMagic(bytes) || isCabMagic(bytes);
}

/** Archive formats we recognise by magic but never unpack (no archive library is used here, by
 * design): they are reported as uninspectable rather than silently allowed through. */
export function sniffOpaqueArchive(bytes: Buffer): { format: string } | null {
  if (isRarMagic(bytes)) return { format: 'RAR' };
  if (isSevenZipMagic(bytes)) return { format: '7z' };
  if (isCabMagic(bytes)) return { format: 'CAB' };
  if (isTarMagic(bytes)) return { format: 'tar' };
  if (isGzipMagic(bytes)) return { format: 'gzip' };
  return null;
}

/** Filename-only findings: extension, double extension and a right-to-left override. */
export function nameFindings(filename: string | null): Finding[] {
  if (filename === null) return [];
  const findings: Finding[] = [];

  if (filename.includes('‮')) {
    findings.push({
      kind: 'suspicious-filename',
      reason: 'filename contains a right-to-left override character (U+202E), used to disguise a dangerous extension',
      severity: 'always',
    });
  }

  const exts = extensionsOf(filename);
  const last = exts.length > 0 ? (exts[exts.length - 1] ?? null) : null;
  if (last !== null && SCRIPT_EXTENSIONS.has(last)) {
    findings.push({ kind: 'script', reason: `filename extension .${last} identifies a script`, severity: 'always' });
  }
  if (last !== null && EXECUTABLE_EXTENSIONS.has(last)) {
    findings.push({ kind: last === 'msi' ? 'msi-installer' : 'pe-executable', reason: `filename extension .${last} identifies an executable`, severity: 'always' });
  }
  if (last !== null && (last === 'iso' || last === 'img')) {
    findings.push({ kind: 'iso-image', reason: `filename extension .${last} identifies a disc image`, severity: 'always' });
  }

  if (exts.length >= 2 && last !== null && (SCRIPT_EXTENSIONS.has(last) || EXECUTABLE_EXTENSIONS.has(last) || last === 'iso' || last === 'img')) {
    const disguise = exts[exts.length - 2] ?? null;
    if (disguise !== null && BENIGN_DOC_EXTENSIONS.has(disguise)) {
      findings.push({
        kind: 'suspicious-filename',
        reason: `double extension disguises a .${last} file as a .${disguise} document`,
        severity: 'always',
      });
    }
  }

  return findings;
}

/** A shebang line identifies a script even without a recognised extension. */
export function shebangFinding(bytes: Buffer): Finding | null {
  if (bytes.length < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return null;
  return { kind: 'script', reason: 'starts with a #! shebang line', severity: 'always' };
}

export function nameContentMismatchFinding(filename: string | null, kind: AttachmentKind): Finding | null {
  if (filename === null) return null;
  const last = lastExtension(filename);
  if (last === null) return null;
  const dangerous = kind === 'pe-executable' || kind === 'elf-executable' || kind === 'macho-executable' || kind === 'msi-installer' || kind === 'lnk' || kind === 'iso-image';
  if (!dangerous) return null;
  if (SCRIPT_EXTENSIONS.has(last) || EXECUTABLE_EXTENSIONS.has(last) || last === 'iso' || last === 'img') return null;
  return {
    kind: 'suspicious-filename',
    reason: `content does not match the declared .${last} extension`,
    severity: 'always',
  };
}

export function looksLikeArchiveOrOle(bytes: Buffer, filename: string | null): boolean {
  if (isZipMagic(bytes) || isArchiveMagic(bytes)) return true;
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return true;
  if (filename !== null) {
    const last = lastExtension(filename);
    if (last !== null && (ARCHIVE_EXTENSIONS.has(last) || ['doc', 'xls', 'ppt', 'msi', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm'].includes(last))) return true;
  }
  return false;
}

export function needsFullScan(bytes: Buffer, filename: string | null, contentType: string): boolean {
  if (looksLikeArchiveOrOle(bytes, filename)) return true;
  if (isPdfMagic(bytes) || contentType === 'application/pdf') return true;
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '{\\rtf') return true;
  if (contentType === 'application/rtf' || contentType === 'text/rtf') return true;
  const last = filename === null ? null : lastExtension(filename);
  if (last === 'iso' || last === 'img') return true;
  return false;
}
