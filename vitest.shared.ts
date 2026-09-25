import { defineConfig, type ViteUserConfig } from 'vitest/config';

// Every package runs the same two projects, because CI gates in layers (PST-T-0.2): `unit` is pure
// and runs anywhere in parallel; `integration` needs PostgreSQL and runs one file at a time.
//
// Workspace packages export a `source` condition pointing at `src/`, so a test never needs a
// sibling built first. The image and `tsc -p tsconfig.build.json` resolve `dist` instead.
const conditions = ['source', 'import', 'module', 'node', 'default'];

export function postroomVitest(_dir: string): ViteUserConfig {
  const resolve = { conditions };
  const ssr = { resolve: { conditions, externalConditions: ['source'] } };
  return defineConfig({
    resolve,
    ssr,
    test: {
      projects: [
        { resolve, ssr, test: { name: 'unit', include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'] } },
        {
          resolve,
          ssr,
          test: {
            name: 'integration',
            include: ['test/integration/**/*.test.ts'],
            fileParallelism: false,
            hookTimeout: 30_000,
            testTimeout: 30_000,
          },
        },
      ],
    },
  });
}
