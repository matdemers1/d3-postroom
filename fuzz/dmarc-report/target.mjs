// Jazzer.js coverage-guided target for @postroom/reports (PST-T-7.1 / PST-REQ-088).
//
// The bytes are a report attachment: the first byte picks a filename/content-type guise, the rest
// goes through unwrapReport (ZIP / gzip / plain, with the decompression-bomb caps) and the DMARC
// aggregate or TLS-RPT parser. The only thing that may be thrown is ReportError. When a report
// parses, its serializer must round-trip it (parse(serialize(r)) equals r). The same bytes also go
// straight into the strict XML reader and the TLS-RPT JSON reader. A crasher here becomes a fixture
// under fuzz/dmarc-report/fixtures before reports is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'reports');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('reports fuzz target: build failed');
}
const { ReportError, parseReportAttachment, parseXml, parseDmarcAggregate, parseTlsRpt, serializeDmarcAggregate, serializeTlsRpt } = await import(pathToFileURL(entry).href);

const GUISES = [
  { filename: 'google.com!d3cloud.io!1!2.zip', contentType: 'application/zip' },
  { filename: 'enterprise.protection.outlook.com!d3cloud.io!1!2.xml.gz', contentType: 'application/gzip' },
  { filename: 'google.com!d3cloud.io!1!2!001.json.gz', contentType: 'application/tlsrpt+gzip' },
  { filename: 'report.xml', contentType: 'text/xml' },
  { filename: 'report.json', contentType: 'application/tlsrpt+json' },
  { filename: null, contentType: 'application/octet-stream' },
];
const LIMITS = { maxOutput: 1 << 20, maxInput: 1 << 20 };

function allowed(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ReportError) return undefined;
    throw err;
  }
}

/** @param {Buffer} data */
export function fuzz(data) {
  const guise = GUISES[(data[0] ?? 0) % GUISES.length];
  const bytes = data.subarray(data.length > 0 ? 1 : 0);

  const parsed = allowed(() => parseReportAttachment({ ...guise, bytes }, LIMITS));
  if (parsed !== undefined && parsed !== null) {
    if (parsed.kind === 'dmarc') {
      const again = parseDmarcAggregate(serializeDmarcAggregate(parsed.report));
      if (!isDeepStrictEqual(again, parsed.report)) throw new Error('DMARC round-trip changed the report');
    } else {
      const again = parseTlsRpt(serializeTlsRpt(parsed.report));
      if (!isDeepStrictEqual(again, parsed.report)) throw new Error('TLS-RPT round-trip changed the report');
    }
  }

  allowed(() => parseXml(data, { maxBytes: 1 << 20, maxDepth: 64 }));
  allowed(() => parseDmarcAggregate(data, { maxBytes: 1 << 20 }));
  allowed(() => parseTlsRpt(data, { maxBytes: 1 << 20 }));
}
