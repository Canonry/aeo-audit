import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@ainyc/aeo-audit': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules', 'dist'],
    environment: 'node',
    reporters: ['default'],
  },
})
