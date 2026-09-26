import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: { conditions: ['source'] },
  // Unit tests run in Node (SSR): workspace packages reached from them (a test imports packages/sieve,
  // which imports @postroom/mime) must resolve their `source` export too, or CI — which tests before
  // it builds — finds no dist. The same conditions as vitest.shared.ts.
  ssr: { resolve: { conditions: ['source', 'node', 'default'], externalConditions: ['source'] } },
  build: { outDir: 'dist', manifest: true, sourcemap: false },
  server: {
    port: 5373,
    proxy: {
      '/api': 'http://localhost:3300',
      '/auth': 'http://localhost:3300',
      '/health': 'http://localhost:3300',
    },
  },
  test: { include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'] },
});
