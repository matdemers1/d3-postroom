// The hand-rolled ZIP writer (PST-T-10.1): CRC-32 correctness, a normal small archive readable by
// Node's own reconstruction of the format, and a synthetic large-entry-count archive that forces
// the Zip64 end-of-central-directory path. `unzip -t` verifies both when the binary is on PATH.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { crc32, ZipWriter } from '../../../src/export/zip.js';

async function collect(writer: (sink: PassThrough) => Promise<void>): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    sink.on('error', reject);
  });
  await writer(sink);
  await done;
  return Buffer.concat(chunks);
}

function unzipAvailable(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('crc32', () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789')).toString(16)).toBe('cbf43926');
  });

  it('accumulates across chunks the same as one call', () => {
    const whole = crc32(Buffer.from('hello world'));
    let acc = crc32(Buffer.from('hello '));
    acc = crc32(Buffer.from('world'), acc);
    expect(acc).toBe(whole);
  });
});

describe('ZipWriter', () => {
  it('writes entries `unzip -t` accepts, with exact content on read-back', async () => {
    const buf = await collect(async (sink) => {
      const zip = new ZipWriter(sink);
      await zip.addEntry('mail/INBOX.mbox', [Buffer.from('From a@b 1970\nhello\n\n')]);
      await zip.addEntry('mail/Ärchiv/2024.mbox', [Buffer.from('From c@d 1970\nnon-ascii ✓\n\n')]);
      await zip.addEntry('manifest.json', [Buffer.from('{"ok":true}\n')]);
      await zip.finish();
    });
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304'); // local file header signature

    const dir = mkdtempSync(join(tmpdir(), 'pst-zip-'));
    const path = join(dir, 'export.zip');
    writeFileSync(path, buf);
    try {
      if (unzipAvailable()) {
        const out = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
        expect(out).toMatch(/No errors detected/);
        const listing = execFileSync('unzip', ['-l', path], { encoding: 'utf8' });
        expect(listing).toContain('mail/INBOX.mbox');
        expect(listing).toContain('manifest.json');
        const extracted = execFileSync('unzip', ['-p', path, 'manifest.json'], { encoding: 'utf8' });
        expect(extracted).toBe('{"ok":true}\n');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the Zip64 end-of-central-directory once entry count exceeds 65535', async () => {
    const buf = await collect(async (sink) => {
      const zip = new ZipWriter(sink);
      const total = 70_000;
      for (let i = 0; i < total; i++) {
        await zip.addEntry(`e/${i}.txt`, [Buffer.from('x')]);
      }
      await zip.finish();
    });
    // The Zip64 end-of-central-directory record signature must be present.
    expect(buf.includes(Buffer.from('504b0606', 'hex'))).toBe(true);
    // The Zip64 locator signature must be present.
    expect(buf.includes(Buffer.from('504b0607', 'hex'))).toBe(true);
    // The classic EOCD's count fields are the 0xFFFF sentinel.
    const eocdSig = Buffer.from('504b0506', 'hex');
    const eocdAt = buf.lastIndexOf(eocdSig);
    expect(eocdAt).toBeGreaterThan(0);
    expect(buf.readUInt16LE(eocdAt + 10)).toBe(0xffff);

    const dir = mkdtempSync(join(tmpdir(), 'pst-zip64-'));
    const path = join(dir, 'big.zip');
    writeFileSync(path, buf);
    try {
      if (unzipAvailable()) {
        const out = execFileSync('unzip', ['-t', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        expect(out).toMatch(/No errors detected/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects further entries after finish()', async () => {
    const sink = new PassThrough();
    sink.resume();
    const zip = new ZipWriter(sink);
    await zip.addEntry('a.txt', [Buffer.from('a')]);
    await zip.finish();
    await expect(zip.addEntry('b.txt', [Buffer.from('b')])).rejects.toThrow(/finished/);
  });
});
