import { Readable } from 'node:stream';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { attachmentPolicy, type OpenPart } from '../../src/policy.js';
import { inspectAttachment } from '../../src/inspect.js';
import { PACKAGE } from '../../src/index.js';
import { readEntryBytes, readZipEntries } from '../../src/zip.js';
import {
  benignZip,
  buildOleWithStorage,
  corruptZipCentralDirectoryOffset,
  doubleExtensionFilename,
  elfExecutable,
  isoImage,
  lnkShortcut,
  machoExecutable,
  mzExecutable,
  ooxmlWithMacro,
  passwordProtectedZip,
  pdfBenign,
  pdfWithJavaScript,
  pngBenign,
  rarSignature,
  rtfBenign,
  rtfWithObjEmbed,
  rtlOverrideFilename,
  sevenZipSignature,
  shellScript,
  zipBomb,
  zipNestedBeyondDepthLimit,
  zipWithExecutableTwoLevelsDeep,
  zipWithNestedArchiveAndExecutable,
} from './fixtures.js';

describe('@postroom/attachments', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE).toBe('@postroom/attachments');
  });
});

function inspect(filename: string, contentType: string, bytes: Buffer) {
  return inspectAttachment({ filename, contentType, bytes, size: bytes.length });
}

describe('inspectAttachment: quarantines each dangerous fixture with a stated reason', () => {
  it('MZ/PE executable', () => {
    const result = inspect('update.exe', 'application/octet-stream', mzExecutable());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('pe-executable');
    expect(result.reasons.some((r) => r.includes('MZ/PE'))).toBe(true);
  });

  it('ELF executable', () => {
    const result = inspect('tool.bin', 'application/octet-stream', elfExecutable());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('elf-executable');
    expect(result.reasons.some((r) => r.includes('ELF'))).toBe(true);
  });

  it('Mach-O executable', () => {
    const result = inspect('tool', 'application/octet-stream', machoExecutable());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('macho-executable');
    expect(result.reasons.some((r) => r.includes('Mach-O'))).toBe(true);
  });

  it('shell script (by extension and shebang)', () => {
    const result = inspect('install.sh', 'text/plain', shellScript());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('script');
    expect(result.reasons.some((r) => r.includes('script'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('shebang'))).toBe(true);
  });

  it('VBScript by extension alone', () => {
    const result = inspect('run.vbs', 'text/plain', Buffer.from('MsgBox "hi"'));
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('script');
  });

  it('Windows shortcut (.lnk)', () => {
    const result = inspect('shortcut.lnk', 'application/octet-stream', lnkShortcut());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('lnk');
    expect(result.reasons.some((r) => r.includes('shortcut'))).toBe(true);
  });

  it('ISO/disc image by content (CD001 volume descriptor)', () => {
    const result = inspect('files.dat', 'application/octet-stream', isoImage());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('iso-image');
    expect(result.reasons.some((r) => r.includes('CD001'))).toBe(true);
  });

  it('OLE compound document with a VBA macro storage', () => {
    const result = inspect('report.doc', 'application/msword', buildOleWithStorage('Macros'));
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('ole-macro');
    expect(result.reasons.some((r) => r.toLowerCase().includes('vba macro storage'))).toBe(true);
  });

  it('OOXML document containing vbaProject.bin', () => {
    const result = inspect('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ooxmlWithMacro());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('ooxml-macro');
    expect(result.reasons.some((r) => r.includes('vbaProject.bin'))).toBe(true);
  });

  it('password-protected ZIP', () => {
    const result = inspect('secret.zip', 'application/zip', passwordProtectedZip());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('password-protected-archive');
    expect(result.reasons.some((r) => r.includes('password-protected'))).toBe(true);
  });

  it('ZIP containing a nested archive and an executable', () => {
    const result = inspect('bundle.zip', 'application/zip', zipWithNestedArchiveAndExecutable());
    expect(result.verdict).toBe('quarantine');
    expect(result.reasons.some((r) => r.includes('nested archive'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('executable') && r.includes('payload.exe'))).toBe(true);
  });

  it('RAR signature (opaque, uninspectable archive)', () => {
    const result = inspect('data.rar', 'application/x-rar-compressed', rarSignature());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('uninspectable-archive');
    expect(result.reasons.some((r) => r.includes('RAR'))).toBe(true);
  });

  it('7z signature (opaque, uninspectable archive)', () => {
    const result = inspect('data.7z', 'application/x-7z-compressed', sevenZipSignature());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('uninspectable-archive');
    expect(result.reasons.some((r) => r.includes('7z'))).toBe(true);
  });

  it('PDF with /JavaScript', () => {
    const result = inspect('invoice.pdf', 'application/pdf', pdfWithJavaScript());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('pdf-active-content');
    expect(result.reasons.some((r) => r.includes('JavaScript'))).toBe(true);
  });

  it('RTF with \\objdata OLE embedding', () => {
    const result = inspect('letter.rtf', 'application/rtf', rtfWithObjEmbed());
    expect(result.verdict).toBe('quarantine');
    expect(result.kind).toBe('rtf-ole-embed');
    expect(result.reasons.some((r) => r.includes('objdata'))).toBe(true);
  });

  it('double extension disguise: invoice.pdf.exe', () => {
    const result = inspect(doubleExtensionFilename(), 'application/octet-stream', mzExecutable());
    expect(result.verdict).toBe('quarantine');
    expect(result.reasons.some((r) => r.includes('double extension'))).toBe(true);
  });

  it('right-to-left override in the filename', () => {
    const result = inspect(rtlOverrideFilename(), 'application/octet-stream', mzExecutable());
    expect(result.verdict).toBe('quarantine');
    expect(result.reasons.some((r) => r.includes('right-to-left override'))).toBe(true);
  });

  it('name/content mismatch: a .png that is really an executable', () => {
    const result = inspect('photo.png', 'image/png', mzExecutable());
    expect(result.verdict).toBe('quarantine');
    expect(result.reasons.some((r) => r.includes('does not match the declared'))).toBe(true);
  });
});

describe('inspectAttachment: benign fixtures are not quarantined', () => {
  it.each([
    ['benign PDF', 'doc.pdf', 'application/pdf', pdfBenign()],
    ['benign PNG', 'photo.png', 'image/png', pngBenign()],
    ['plain ZIP of text files', 'archive.zip', 'application/zip', benignZip()],
    ['plain RTF', 'note.rtf', 'application/rtf', rtfBenign()],
  ] as const)('%s', (_label, filename, contentType, bytes) => {
    const result = inspect(filename, contentType, bytes);
    expect(result.verdict).toBe('ok');
    expect(result.reasons).toEqual([]);
  });
});

describe('sender-history relaxation', () => {
  function openPartFor(bytes: Buffer): OpenPart {
    return () => Readable.from([bytes]);
  }

  it('always quarantines executables and scripts even for a sender with history', async () => {
    const collected = {
      attachments: [
        { partId: '1.1', contentType: 'application/octet-stream', filename: 'update.exe', disposition: 'attachment', contentId: null, encoding: 'base64', charset: null, size: 64, sha256: 'x', firstBytes: mzExecutable(), inMessage: null },
      ],
    };
    const result = await attachmentPolicy(collected, { senderHasHistory: true, openPart: openPartFor(mzExecutable()) });
    expect(result.quarantine).toBe(true);
    expect(result.findings[0]?.verdict).toBe('quarantine');
  });

  it('relaxes a macro document to ok for a sender with history, but still reports the finding', async () => {
    const bytes = ooxmlWithMacro();
    const collected = {
      attachments: [
        { partId: '1.1', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'report.docx', disposition: 'attachment', contentId: null, encoding: 'base64', charset: null, size: bytes.length, sha256: 'x', firstBytes: bytes.subarray(0, 512), inMessage: null },
      ],
    };
    const result = await attachmentPolicy(collected, { senderHasHistory: true, openPart: openPartFor(bytes) });
    expect(result.quarantine).toBe(false);
    expect(result.findings[0]?.verdict).toBe('ok');
    expect(result.findings[0]?.reasons.some((r) => r.includes('vbaProject.bin'))).toBe(true);
  });

  it('quarantines a macro document for a sender without history', async () => {
    const bytes = ooxmlWithMacro();
    const collected = {
      attachments: [
        { partId: '1.1', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'report.docx', disposition: 'attachment', contentId: null, encoding: 'base64', charset: null, size: bytes.length, sha256: 'x', firstBytes: bytes.subarray(0, 512), inMessage: null },
      ],
    };
    const result = await attachmentPolicy(collected, { senderHasHistory: false, openPart: openPartFor(bytes) });
    expect(result.quarantine).toBe(true);
    expect(result.findings[0]?.verdict).toBe('quarantine');
  });

  it('a 30 MB archive is uninspectable without buffering it beyond the cap', async () => {
    const size = 30 * 1024 * 1024;
    const firstBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(508)]);
    const cap = 1024 * 1024; // small cap for the test so we don't allocate 30 MB
    const collected = {
      attachments: [
        { partId: '1.1', contentType: 'application/zip', filename: 'huge.zip', disposition: 'attachment', contentId: null, encoding: 'base64', charset: null, size, sha256: 'x', firstBytes, inMessage: null },
      ],
    };
    const openPart: OpenPart = () => {
      throw new Error('openPart should never be called for an attachment already known to exceed the cap');
    };
    const result = await attachmentPolicy(collected, { senderHasHistory: false, openPart, maxInspectBytes: cap });
    expect(result.findings[0]?.kind).toBe('uninspectable-archive');
    expect(result.quarantine).toBe(true);
  });

  it('relaxes an uninspectable oversized archive to ok for a sender with history', async () => {
    const size = 30 * 1024 * 1024;
    const firstBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(508)]);
    const collected = {
      attachments: [
        { partId: '1.1', contentType: 'application/zip', filename: 'huge.zip', disposition: 'attachment', contentId: null, encoding: 'base64', charset: null, size, sha256: 'x', firstBytes, inMessage: null },
      ],
    };
    const openPart: OpenPart = () => {
      throw new Error('should not be called');
    };
    const result = await attachmentPolicy(collected, { senderHasHistory: true, openPart, maxInspectBytes: 1024 * 1024 });
    expect(result.quarantine).toBe(false);
  });
});

describe('robustness', () => {
  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.option(fc.string()), fc.string(), fc.uint8Array({ maxLength: 4096 }), (filename, contentType, arr) => {
        expect(() => inspectAttachment({ filename, contentType, bytes: Buffer.from(arr), size: arr.length })).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('never throws on empty bytes or a null filename', () => {
    expect(() => inspectAttachment({ filename: null, contentType: 'application/octet-stream', bytes: Buffer.alloc(0), size: 0 })).not.toThrow();
  });
});

// Regressions for the three defects the verifier found in the first pass of PST-T-2.10: recursion
// into nested ZIP entries, a malformed/corrupted central directory never falling through to
// "benign", and an unbounded decompression (zip-bomb) allocation.
describe('regression: nested-ZIP evasion, malformed central directory, zip bombs', () => {
  it('finds an executable two levels deep inside nested ZIPs, and always quarantines it even for a sender with history', async () => {
    const bytes = zipWithExecutableTwoLevelsDeep();
    const direct = inspectAttachment({ filename: 'bundle.zip', contentType: 'application/zip', bytes, size: bytes.length });
    expect(direct.verdict).toBe('quarantine');
    expect(direct.reasons.some((r) => r.includes('executable') && r.includes('payload.exe'))).toBe(true);

    const collected = {
      attachments: [
        { partId: '1.1', contentType: 'application/zip', filename: 'bundle.zip', disposition: 'attachment', contentId: null, encoding: 'base64', charset: null, size: bytes.length, sha256: 'x', firstBytes: bytes.subarray(0, 512), inMessage: null },
      ],
    };
    const openPart: OpenPart = () => Readable.from([bytes]);
    const result = await attachmentPolicy(collected, { senderHasHistory: true, openPart });
    expect(result.quarantine).toBe(true);
    expect(result.findings[0]?.verdict).toBe('quarantine');
    expect(result.findings[0]?.kind).toBe('archive-executable');
  });

  it('reports a nested archive past the recursion depth limit as uninspectable rather than silently passing it', () => {
    const bytes = zipNestedBeyondDepthLimit(4); // outer + 4 levels: deeper than MAX_DEPTH (3)
    const result = inspectAttachment({ filename: 'deep.zip', contentType: 'application/zip', bytes, size: bytes.length });
    expect(result.verdict).toBe('quarantine');
    expect(result.reasons.some((r) => r.includes('maximum inspection depth'))).toBe(true);
  });

  it('quarantines an archive nested past the depth limit even for a sender with history', async () => {
    const bytes = zipNestedBeyondDepthLimit(4);
    const policy = await attachmentPolicy(
      { attachments: [{ partId: '2', contentType: 'application/zip', filename: 'deep.zip', disposition: 'attachment', contentId: null, encoding: 'base64', charset: null, size: bytes.length, sha256: '', firstBytes: bytes.subarray(0, 512), inMessage: false }] } as unknown as Parameters<typeof attachmentPolicy>[0],
      { senderHasHistory: true, openPart: () => Readable.from([bytes]) },
    );
    expect(policy.quarantine).toBe(true);
  });

  it('never returns benign for a ZIP with a corrupted/out-of-range central directory offset, even when it truly contains a macro', () => {
    const good = ooxmlWithMacro();
    const corrupted = corruptZipCentralDirectoryOffset(good);
    const result = inspectAttachment({ filename: 'report.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: corrupted, size: corrupted.length });
    expect(result.kind).not.toBe('benign');
    expect(result.verdict).toBe('quarantine');
    expect(result.reasons.some((r) => r.includes('central directory') && (r.includes('corrupt') || r.includes('missing')))).toBe(true);
    // The fallback local-header scan should still have recovered the real macro entry.
    expect(result.reasons.some((r) => r.includes('vbaProject.bin'))).toBe(true);
  });

  it('quarantines a malformed archive even for a sender with history (a broken container is itself suspicious)', async () => {
    const corrupted = corruptZipCentralDirectoryOffset(benignZip());
    const collected = {
      attachments: [
        { partId: '1.1', contentType: 'application/zip', filename: 'weird.zip', disposition: 'attachment', contentId: null, encoding: 'base64', charset: null, size: corrupted.length, sha256: 'x', firstBytes: corrupted.subarray(0, 512), inMessage: null },
      ],
    };
    const openPart: OpenPart = () => Readable.from([corrupted]);
    const result = await attachmentPolicy(collected, { senderHasHistory: true, openPart });
    expect(result.quarantine).toBe(true);
    expect(result.findings[0]?.kind).toBe('malformed-archive');
  });

  it('a corrupted EOCD offset is recognised even when a fresh, well-formed ZIP has zero entries recoverable by the fallback scan', () => {
    // A trivial ZIP skeleton with its EOCD offset corrupted: still "malformed", never "benign".
    const empty = corruptZipCentralDirectoryOffset(emptyZip());
    const result = inspectAttachment({ filename: 'empty.zip', contentType: 'application/zip', bytes: empty, size: empty.length });
    expect(result.kind).toBe('malformed-archive');
    expect(result.verdict).toBe('quarantine');
  });

  it('readZipEntries recovers the real entries via local-header fallback when the central directory is corrupted', () => {
    const good = ooxmlWithMacro();
    const corrupted = corruptZipCentralDirectoryOffset(good);
    const listing = readZipEntries(corrupted);
    expect(listing).not.toBeNull();
    expect(listing?.malformed).toBe(true);
    expect(listing?.entries.some((e) => e.name.endsWith('vbaProject.bin'))).toBe(true);
  });

  it('readEntryBytes never allocates far beyond the cap for a deflate stream that expands to 500 MB', () => {
    const zip = zipBomb(500 * 1024 * 1024);
    const listing = readZipEntries(zip);
    expect(listing).not.toBeNull();
    const entry = listing?.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('unreachable');

    const cap = 64 * 1024;
    const before = process.memoryUsage().rss;
    const result = readEntryBytes(zip, entry, cap);
    const after = process.memoryUsage().rss;

    expect(result).not.toBeNull();
    expect(result?.bytes.length).toBeLessThanOrEqual(cap);
    expect(result?.truncated).toBe(true);
    // The bug this regresses: inflateRawSync(compressed) with no limit raised RSS by ~1 GB to
    // return 32 bytes. Bounded streaming inflate should stay well under that.
    expect(after - before).toBeLessThan(64 * 1024 * 1024);
  });

  it('inspectAttachment flags a genuinely bomb-like declared compression ratio without hanging or ballooning memory', () => {
    const zip = zipBomb(64 * 1024 * 1024); // still a huge, real expansion ratio, kept smaller so the full pipeline test stays fast
    const before = process.memoryUsage().rss;
    const result = inspectAttachment({ filename: 'bomb.zip', contentType: 'application/zip', bytes: zip, size: zip.length });
    const after = process.memoryUsage().rss;
    expect(result.verdict).toBe('quarantine');
    expect(result.reasons.some((r) => r.includes('compression ratio') || r.includes('decompression bomb'))).toBe(true);
    expect(after - before).toBeLessThan(64 * 1024 * 1024);
  });
});

function emptyZip(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), eocd]);
}
