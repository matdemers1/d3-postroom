import { describe, expect, it } from 'vitest';
import {
  BundleUnsealError,
  exportKekBase64,
  generateKek,
  sealKekBundle,
  serializeKekBundle,
  unsealKekBundle,
  type KekBundle,
} from '../../src/index.js';

// Cheap Argon2id parameters so the suite stays fast; production defaults are m=64 MiB, t=3, p=1.
const cheap = { kdf: { memoryCost: 1024, timeCost: 1, parallelism: 1 } };
const passphrase = 'correct horse battery staple';

describe('KEK recovery bundle', () => {
  const kek = generateKek();
  const sealed = sealKekBundle(kek, passphrase, cheap);

  it('unseals with the right passphrase, from the object or the serialized JSON', async () => {
    const bundle = await sealed;
    expect(bundle).toMatchObject({ v: 1, kdf: 'argon2id', m: 1024, t: 1, p: 1, kekId: kek.id });
    const text = serializeKekBundle(bundle);
    expect(text).not.toContain(exportKekBase64(kek));
    const fromObject = await unsealKekBundle(bundle, passphrase);
    const fromText = await unsealKekBundle(text, passphrase);
    expect(fromObject.id).toBe(kek.id);
    expect(exportKekBase64(fromText)).toBe(exportKekBase64(kek));
  });

  it('uses the production defaults when not overridden', async () => {
    const bundle = await sealKekBundle(kek, passphrase);
    expect(bundle).toMatchObject({ m: 65536, t: 3, p: 1 });
    expect((await unsealKekBundle(bundle, passphrase)).id).toBe(kek.id);
  });

  it('fails with a typed error on the wrong passphrase', async () => {
    const bundle = await sealed;
    await expect(unsealKekBundle(bundle, 'Correct horse battery staple')).rejects.toBeInstanceOf(BundleUnsealError);
    await expect(unsealKekBundle(bundle, '')).rejects.toBeInstanceOf(BundleUnsealError);
  });

  it('fails if any field is tampered with', async () => {
    const bundle = await sealed;
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] = (buf[0] ?? 0) ^ 1;
      return buf.toString('base64');
    };
    const tampered: Array<Record<string, unknown>> = [
      { ...bundle, ct: flip(bundle.ct) },
      { ...bundle, nonce: flip(bundle.nonce) },
      { ...bundle, salt: flip(bundle.salt) },
      { ...bundle, kekId: generateKek().id },
      { ...bundle, createdAt: new Date(0).toISOString() },
      { ...bundle, t: 2 },
      { ...bundle, m: 2048 },
      { ...bundle, m: 1024 * 1024 * 1024 },
      { ...bundle, p: 0 },
      { ...bundle, v: 2 },
      { ...bundle, kdf: 'argon2i' },
      { ...bundle, ct: undefined },
    ];
    for (const bad of tampered) {
      await expect(unsealKekBundle(bad as unknown as KekBundle, passphrase)).rejects.toBeInstanceOf(BundleUnsealError);
    }
    await expect(unsealKekBundle('{not json', passphrase)).rejects.toBeInstanceOf(BundleUnsealError);
  });

  it('different seals of the same KEK differ (fresh salt and nonce)', async () => {
    const a = await sealed;
    const b = await sealKekBundle(kek, passphrase, cheap);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ct).not.toBe(b.ct);
  });
});
