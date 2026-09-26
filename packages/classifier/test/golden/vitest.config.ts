// Standalone Vitest config for the golden replay test (PST-T-5.5, PST-REQ-107). Not registered as a
// third project in the shared `vitest.shared.ts` (owned by PST-T-0.2, out of this task's owned
// files) — `packages/classifier/package.json`'s `test` script instead runs this config as a second,
// separate `vitest run` after the normal `unit` project, so `pnpm test` still gates it in CI without
// this task's footprint reaching outside `packages/classifier/test/golden/**` and `package.json`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '../..');

// Same resolve conditions as vitest.shared.ts's `postroomVitest`: 'source' lets this test resolve
// @postroom/mime and @postroom/classifier straight from src/, with no build required first.
const conditions = ['source', 'node', 'default'];

export default defineConfig({
  root: packageRoot,
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['source'] } },
  test: {
    name: 'golden',
    include: ['test/golden/**/*.test.ts'],
  },
});
