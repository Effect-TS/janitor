import { build } from "vite-plus"
import { builtinModules } from "node:module"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
const root = fileURLToPath(new URL(".", import.meta.url))
const conditions = ["workerd", "browser", "module", "import", "default"]
await build({
  root,
  configFile: false,
  plugins: [
    {
      name: "opencode-text-imports",
      enforce: "pre",
      load(id) {
        if (/\.(md|txt|sql)$/.test(id))
          return `export default ${JSON.stringify(readFileSync(id, "utf8"))}`
      },
    },
  ],
  resolve: { conditions },
  ssr: { target: "webworker", noExternal: true, resolve: { conditions } },
  build: {
    ssr: "runner-worker.mjs",
    outDir: "dist-runner",
    minify: false,
    sourcemap: true,
    rolldownOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
        "cloudflare:workers",
      ],
      output: {
        banner:
          'import {createRequire as makeProbeRequire} from "node:module"; const require = makeProbeRequire("/bundle/worker.mjs");',
        entryFileNames: "worker.mjs",
        format: "es",
      },
    },
  },
})
