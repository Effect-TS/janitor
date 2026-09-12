// Bundles the runner Worker with the isolated OpenCode dependency graph.
//
// OpenCode imports Markdown/text prompt files, selects `workerd`/`browser`
// export conditions, and some transitive CommonJS modules need `require` for
// Node builtins under nodejs_compat. `--test` bundles the test entry, which
// wraps the production runner with fault injection and a scripted model.
import { build } from "vite-plus"
import { builtinModules } from "node:module"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const test = process.argv.includes("--test")
const root = fileURLToPath(new URL("..", import.meta.url))
const conditions = ["workerd", "browser", "module", "import", "default"]

await build({
  root,
  configFile: false,
  logLevel: "warn",
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
    ssr: test ? "test/worker.ts" : "src/worker.ts",
    outDir: test ? "dist-test" : "dist",
    emptyOutDir: true,
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
          'import { createRequire as makeRunnerRequire } from "node:module"; const require = makeRunnerRequire("/bundle/worker.mjs");',
        entryFileNames: "worker.mjs",
        format: "es",
      },
    },
  },
})
