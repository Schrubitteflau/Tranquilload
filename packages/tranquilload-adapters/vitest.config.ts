import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@tranquilload/core': path.resolve(__dirname, '../tranquilload-core/src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
