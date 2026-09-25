import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertBlobName, blobPath, InvalidBlobNameError, isBlobName, PACKAGE, tmpDir } from '../../src/index.js';

const hexChar = fc.constantFrom(...'0123456789abcdef'.split(''));
const sha = fc.array(hexChar, { minLength: 64, maxLength: 64 }).map((c) => c.join(''));

describe('@postroom/blobstore', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE).toBe('@postroom/blobstore');
  });
});

describe('blobPath', () => {
  it('shards two levels by the first four hex characters', () => {
    fc.assert(
      fc.property(sha, (name) => {
        expect(blobPath('/srv/blobs', name)).toBe(`/srv/blobs/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`);
      }),
    );
  });

  it('refuses a relative root', () => {
    expect(() => blobPath('blobs', 'a'.repeat(64))).toThrow(TypeError);
    expect(() => tmpDir('./x')).toThrow(TypeError);
  });

  it('never builds a path for a name that is not 64 lowercase hex', () => {
    for (const bad of ['../etc', '../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(62)}/.`, '']) {
      expect(() => blobPath('/srv/blobs', bad)).toThrow(InvalidBlobNameError);
    }
  });
});

describe('blob name validation', () => {
  it('accepts every 64-char lowercase hex string', () => {
    fc.assert(fc.property(sha, (name) => isBlobName(name)));
  });

  it('rejects any string that is not exactly 64 lowercase hex', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const valid = /^[0-9a-f]{64}$/.test(s);
        expect(isBlobName(s)).toBe(valid);
        if (!valid) expect(() => { assertBlobName(s); }).toThrow(InvalidBlobNameError);
      }),
    );
  });

  it('rejects a valid name with one character changed to a non-hex or uppercase', () => {
    fc.assert(
      fc.property(sha, fc.nat(63), fc.constantFrom('g', 'G', 'A', '/', '.', ' ', '\0'), (name, i, c) => {
        const bad = name.slice(0, i) + c + name.slice(i + 1);
        expect(isBlobName(bad)).toBe(false);
      }),
    );
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}, Buffer.from('a'.repeat(64))]) expect(isBlobName(v)).toBe(false);
  });
});
