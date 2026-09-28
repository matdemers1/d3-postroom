// Jazzer.js coverage-guided target for @postroom/dsn's report readers (PST-T-11.15 / PST-REQ-088).
//
// The bytes are the machine-readable part of a multipart/report that came back to us: a DSN's
// message/delivery-status (RFC 3464) or an ARF message/feedback-report (RFC 5965). Both readers are
// total, so nothing may be thrown at all; what they return must be bounded (at most MAX_RECIPIENTS
// recipients, no kept value longer than MAX_VALUE_CHARS) and every Status must be a real x.y.z code,
// because the caller bounces and suppresses on it. A crasher here becomes a fixture under
// fuzz/dsn-report/fixtures before the reader is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'dsn');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('dsn fuzz target: build failed');
}
const { parseDeliveryStatus, parseFeedbackReport, MAX_RECIPIENTS, MAX_VALUE_CHARS } = await import(pathToFileURL(entry).href);

const STATUS = /^[245]\.\d{1,3}\.\d{1,3}$/;

function bounded(value, what) {
  if (value !== null && value.length > MAX_VALUE_CHARS) throw new Error(`${what} is longer than MAX_VALUE_CHARS`);
}

/** @param {Buffer} data */
export function fuzz(data) {
  // The first byte picks bytes or text input, so both entry shapes are exercised.
  const asText = (data[0] ?? 0) % 2 === 0;
  const body = data.subarray(data.length > 0 ? 1 : 0);
  const input = asText ? body.toString('latin1') : body;

  const dsn = parseDeliveryStatus(input);
  if (dsn.recipients.length > MAX_RECIPIENTS) throw new Error('more recipients than MAX_RECIPIENTS');
  bounded(dsn.originalEnvelopeId, 'Original-Envelope-Id');
  bounded(dsn.reportingMta, 'Reporting-MTA');
  for (const r of dsn.recipients) {
    if (r.status !== null && !STATUS.test(r.status)) throw new Error(`status ${JSON.stringify(r.status)} is not an x.y.z code`);
    if (r.smtpCode !== null && (r.smtpCode < 200 || r.smtpCode > 599)) throw new Error('smtp code out of range');
    for (const [k, v] of Object.entries(r)) if (typeof v === 'string') bounded(v, k);
  }

  const arf = parseFeedbackReport(input);
  if (arf.feedbackType !== null && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(arf.feedbackType)) throw new Error('feedback type is not a token');
  if (arf.originalRcptTo.length > 20 || arf.reportedDomain.length > 20) throw new Error('ARF lists are unbounded');
  for (const [k, v] of Object.entries(arf)) if (typeof v === 'string') bounded(v, k);
}
