// `pnpm --filter @postroom/api openapi`        writes openapi.json from the zod schemas.
// `pnpm --filter @postroom/api openapi:check`  regenerates to a temp file and compares it with the
//                                              committed one; exit 1 on any drift (CI, PST-REQ-085).
// `--against <path>` checks a different committed file (the unit test uses it on a mutated copy).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument, serializeSpec, specDrift } from './document.js';

export const SPEC_PATH = fileURLToPath(new URL('../../openapi.json', import.meta.url));

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  const at = argv.indexOf('--against');
  const target = at >= 0 ? argv[at + 1] : SPEC_PATH;
  if (target === undefined) {
    process.stderr.write('--against needs a path\n');
    return 2;
  }
  const generated = serializeSpec(buildOpenApiDocument());
  if (!check) {
    await writeFile(target, generated);
    process.stdout.write(`wrote ${target}\n`);
    return 0;
  }
  const dir = await mkdtemp(join(tmpdir(), 'postroom-openapi-'));
  try {
    const temp = join(dir, 'openapi.json');
    await writeFile(temp, generated);
    let committed: string;
    try {
      committed = await readFile(target, 'utf8');
    } catch (error) {
      process.stderr.write(`cannot read ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const drift = specDrift(committed, await readFile(temp, 'utf8'));
    if (drift === null) {
      process.stdout.write(`openapi.json is up to date with the schemas\n`);
      return 0;
    }
    process.stderr.write(
      `openapi.json has drifted from the zod schemas (PST-REQ-085).\n${drift}\nRun: pnpm --filter @postroom/api openapi, and commit the result.\n`,
    );
    return 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
