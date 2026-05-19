import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    globalSetup: ["./integration/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: ["default"],
  },
})
