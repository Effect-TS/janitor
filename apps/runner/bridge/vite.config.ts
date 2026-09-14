import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "runner-bridge",
    include: ["*.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
})
