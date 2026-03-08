import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    multipart: 'src/multipart/index.ts',
    oneshot: 'src/oneshot/index.ts',
    pipeline: 'src/pipeline/index.ts',
    services: 'src/services/index.ts',
    errors: 'src/errors/index.ts',
    progress: 'src/progress/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
})
