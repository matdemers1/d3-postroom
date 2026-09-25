import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportKekBase64, generateKek, KekLoadError, KEK_ENV_VAR, loadKek } from '../../src/index.js';

describe('loadKek', () => {
  const raw = randomBytes(32);
  const b64 = raw.toString('base64');

  it('loads from the environment and from a file, with the same id', () => {
    const fromEnv = loadKek({ env: { [KEK_ENV_VAR]: b64 } });
    const dir = mkdtempSync(join(tmpdir(), 'postroom-kek-'));
    const path = join(dir, 'kek');
    writeFileSync(path, `${b64}\n`);
    const fromFile = loadKek({ path });
    expect(fromFile.id).toBe(fromEnv.id);
    expect(fromEnv.id).toBe(createHash('sha256').update(raw).digest().subarray(0, 8).toString('hex'));
    expect(exportKekBase64(fromEnv)).toBe(b64);
  });

  it.each([31, 33, 0, 16, 64])('rejects a %d-byte key', (n) => {
    const bad = randomBytes(n).toString('base64');
    expect(() => loadKek({ base64: bad })).toThrow(KekLoadError);
  });

  it('rejects garbage and a missing variable, without echoing the input', () => {
    const garbage = 'not-a-key-at-all!!not-a-key-at-all!!12345678';
    let message = '';
    try {
      loadKek({ env: { [KEK_ENV_VAR]: garbage } });
    } catch (err) {
      expect(err).toBeInstanceOf(KekLoadError);
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(garbage);
    expect(() => loadKek({ env: {} })).toThrow(/POSTROOM_KEK is not set/);
    expect(() => loadKek({ path: '/nonexistent/postroom/kek' })).toThrow(KekLoadError);
  });

  it('never leaks the key through JSON, inspect or string conversion', () => {
    const kek = loadKek({ base64: b64 });
    const hex = raw.toString('hex');
    const outputs = [
      JSON.stringify(kek),
      JSON.stringify({ kek }),
      inspect(kek, { showHidden: true, depth: 10 }),
      inspect({ kek }, { showHidden: true, depth: 10 }),
      String(kek),
      kek.toString(),
      JSON.stringify(Object.entries(kek)),
    ];
    for (const out of outputs) {
      expect(out).not.toContain(b64);
      expect(out).not.toContain(hex);
    }
    expect(JSON.stringify(kek)).toBe('"[Kek]"');
    expect(inspect(kek)).toBe('[Kek]');
  });

  it('generates distinct keys', () => {
    expect(generateKek().id).not.toBe(generateKek().id);
  });
});
