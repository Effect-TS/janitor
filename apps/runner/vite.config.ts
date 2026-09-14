import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/support/globalSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Miniflare instances are heavy; scenarios inside one file share an instance.
    fileParallelism: false,
  },
})
