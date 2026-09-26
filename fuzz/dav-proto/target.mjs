// Jazzer.js coverage-guided target for @postroom/dav-proto (PST-T-8.2 / PST-REQ-088).
//
// The bytes are a request body: parse them as XML (the only thing that may be thrown is XmlError),
// check the serializer round-trips (parse(serialize(tree)) equals tree), then hand the tree to every
// request parser — PROPFIND, PROPPATCH, MKCALENDAR/MKCOL and REPORT — which may throw only DavError.
// The same bytes, as a string, also go through the path, Depth and entity-tag parsers. A crasher
// here becomes a fixture under fuzz/dav-proto/fixtures before dav-proto is fixed — see
// docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'dav-proto');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('dav-proto fuzz target: build failed');
}
const { DavError, XmlError, parseXml, serializeXml, parsePropfind, parseProppatch, parseMkcol, parseReport, decodePath, parseDepth, parseEtagList, evaluatePreconditions, hrefPath } =
  await import(pathToFileURL(entry).href);

function allowed(fn, cls = DavError) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof cls) return undefined;
    throw err;
  }
}

/** @param {Buffer} data */
export function fuzz(data) {
  const tree = allowed(() => parseXml(data, { maxBytes: 1 << 20, maxDepth: 64 }), XmlError);
  if (tree !== undefined) {
    const text = serializeXml(tree);
    const again = parseXml(text, { maxBytes: 1 << 22, maxDepth: 64 });
    if (JSON.stringify(again) !== JSON.stringify(tree)) throw new Error('round-trip changed the tree');
    allowed(() => parsePropfind(tree));
    allowed(() => parseProppatch(tree));
    allowed(() => parseMkcol(tree, 'MKCALENDAR'));
    allowed(() => parseMkcol(tree, 'MKCOL'));
    allowed(() => parseReport(tree));
  }

  const s = data.toString('latin1');
  allowed(() => decodePath(s.startsWith('/') ? s : `/${s}`));
  allowed(() => parseDepth(s, 0));
  allowed(() => parseEtagList(s));
  allowed(() => evaluatePreconditions({ ifMatch: s, ifNoneMatch: s }, 'abc', 'PUT'));
  hrefPath(s);
}
