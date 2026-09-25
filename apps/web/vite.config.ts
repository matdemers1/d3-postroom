import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: { conditions: ['source'] },
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
