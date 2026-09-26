// Jazzer.js coverage-guided target for @postroom/ical (PST-T-8.1 / PST-REQ-088).
//
// Takes an expansion range and caps from the fuzzer, then treats the rest of the bytes as an
// iCalendar stream: parse it, check the serializer round-trips (parse(serialize(parse(x))) equals
// parse(x)), and expand every parsed root into the range, checking the result is sorted, unique,
// within the range and within the cap. The same bytes also go through the RECUR, DURATION, PERIOD
// and UTC-OFFSET parsers as a string. The only thing any of these may throw is ICalError. A crasher
// here becomes a fixture under fuzz/ical/fixtures before ical is fixed — see
// docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FuzzedDataProvider } from '@jazzer.js/core';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'ical');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('ical fuzz target: build failed');
}
const { ICalError, parseICalendarAll, serializeICalendar, expandCalendar, parseRecur, parseDuration, parsePeriod, parseUtcOffset } =
  await import(pathToFileURL(entry).href);

function allowed(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ICalError) return undefined;
    throw err;
  }
}

/** @param {Buffer} data */
export function fuzz(data) {
  const fdp = new FuzzedDataProvider(data);
  // Range: any start from 1900 to 2100, any length up to ~12 years; small caps keep each run fast.
  const startSec = fdp.consumeIntegralInRange(0, 6_311_433_600) - 2_208_988_800;
  const lengthSec = fdp.consumeIntegralInRange(0, 400_000_000);
  const maxInstances = fdp.consumeIntegralInRange(0, 64);
  const body = Buffer.from(fdp.consumeRemainingAsBytes());

  const roots = allowed(() => parseICalendarAll(body, { maxBytes: 1 << 20 }));
  if (roots !== undefined) {
    const text = allowed(() => serializeICalendar(roots));
    if (text === undefined) throw new Error('serializeICalendar rejected a tree parseICalendarAll produced');
    const again = parseICalendarAll(text);
    if (JSON.stringify(again) !== JSON.stringify(roots)) throw new Error('round-trip changed the tree');

    const start = startSec * 1000;
    const end = start + lengthSec * 1000;
    for (const root of roots) {
      const r = allowed(() => expandCalendar(root, { start, end, maxInstances, maxIterations: 20_000 }));
      if (r === undefined) continue;
      if (r.instances.length > maxInstances) throw new Error(`${r.instances.length} instances > cap ${maxInstances}`);
      const seen = new Set();
      let prev = -Infinity;
      for (const i of r.instances) {
        if (!(i.start >= prev)) throw new Error('instances not sorted');
        prev = i.start;
        if (!(i.end >= i.start)) throw new Error('instance ends before it starts');
        const inRange = i.end > i.start ? i.start < end && i.end > start : i.start >= start && i.start < end;
        if (!inRange) throw new Error(`instance ${i.recurrenceId} outside the range`);
        const k = `${i.uid}\u0000${i.recurrenceId}`;
        if (seen.has(k)) throw new Error(`duplicate instance ${i.recurrenceId}`);
        seen.add(k);
      }
    }
  }

  const s = body.toString('latin1');
  allowed(() => parseRecur(s));
  allowed(() => parseDuration(s));
  allowed(() => parsePeriod(s));
  allowed(() => parseUtcOffset(s));
}
