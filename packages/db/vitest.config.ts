import { defineConfig } from 'vitest/config';

// Mirrors ../../vitest.shared.ts (unit + integration projects, `source` condition) with one
// difference. The shared config lists `import` and `module` among the resolve conditions, and
// Vitest forwards them to Node for externalised dependencies: `pg` then `require`s pg-pool's ESM
// build and gets a module namespace instead of a class ("Class extends value [object Module]").
// This package talks to PostgreSQL, so it keeps `source` and drops the conditions Node must not see.
const conditions = ['source', 'node', 'default'];
const resolve = { conditions };
const ssr = { resolve: { conditions, externalConditions: ['source'] } };

export default defineConfig({
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
