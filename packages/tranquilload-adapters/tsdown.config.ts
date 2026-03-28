import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'from-file': 'src/sources/from-file.ts',
    'from-node-readable': 'src/sources/from-node-readable.ts',
    's3-multipart-upload': 'src/protocols/s3-multipart-upload.ts',
    'simple-http-upload': 'src/protocols/simple-http-upload.ts',
    'network-multiplier': 'src/resilience/network-multiplier.ts',
    'optimal-part-size': 'src/resilience/optimal-part-size.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
})
