// Jazzer.js coverage-guided target for @postroom/vcard (PST-T-8.1 / PST-REQ-088).
//
// Parses the fuzzer bytes as a .vcf stream, checks the serializer round-trips
// (parse(serialize(parse(x))) equals parse(x)), and runs every contact helper on every card:
// displayName is a string, emailsOf returns distinct addresses containing `@` in PREF order, and
// telsOf/addressesOf/nameOf/photoOf return without throwing. The same bytes also go through the
// data: URI parser. The only thing any of these may throw is VCardError. A crasher here becomes a
// fixture under fuzz/vcard/fixtures before vcard is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'vcard');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('vcard fuzz target: build failed');
}
const { VCardError, parseVCards, serializeVCard, displayName, emailsOf, telsOf, addressesOf, nameOf, photoOf, parseDataUri } =
  await import(pathToFileURL(entry).href);

function allowed(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof VCardError) return undefined;
    throw err;
  }
}

/** @param {Buffer} data */
export function fuzz(data) {
  const cards = allowed(() => parseVCards(data, { maxBytes: 1 << 20 }));
  if (cards !== undefined) {
    const text = allowed(() => serializeVCard(cards));
    if (text === undefined) throw new Error('serializeVCard rejected cards parseVCards produced');
    if (JSON.stringify(parseVCards(text)) !== JSON.stringify(cards)) throw new Error('round-trip changed the cards');
    for (const card of cards) {
      if (typeof displayName(card) !== 'string') throw new Error('displayName did not return a string');
      const emails = emailsOf(card);
      const seen = new Set();
      let prevPref = 0;
      for (const e of emails) {
        if (!e.address.includes('@')) throw new Error(`emailsOf returned "${e.address}"`);
        const k = e.address.toLowerCase();
        if (seen.has(k)) throw new Error(`emailsOf returned ${e.address} twice`);
        seen.add(k);
        if (e.pref < prevPref) throw new Error('emailsOf not in PREF order');
        prevPref = e.pref;
      }
      telsOf(card);
      addressesOf(card);
      nameOf(card);
      photoOf(card);
    }
  }
  allowed(() => parseDataUri(data.toString('latin1')));
}
