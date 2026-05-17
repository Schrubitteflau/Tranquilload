import { defineConfig } from "vite"

// Note: @tranquilload/core and @tranquilload/adapters are resolved via
// pnpm workspace symlinks → their built `dist/` is consumed (you must
// `pnpm turbo build` from the repo root first, or run it in --watch mode).
export default defineConfig({
  root: ".",
  publicDir: "public",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
})
