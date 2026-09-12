import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/support/globalSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Miniflare instances are heavy; scenarios inside one file share an instance.
    fileParallelism: false,
  },
})
