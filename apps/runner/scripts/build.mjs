// Bundles the runner Worker with the workspace-pinned OpenCode and Effect dependencies.
//
// OpenCode selects `workerd`/`browser` export conditions, some packages import
// Markdown/text prompt files, and some transitive CommonJS modules need
// `require` for Node builtins under nodejs_compat. `--test` bundles the test entry, which
// wraps the production runner with fault injection and a scripted model.
import { build } from "vite-plus"
import { builtinModules } from "node:module"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const test = process.argv.includes("--test")
const dev = process.argv.includes("--dev")
const outDir = test ? "dist-test" : dev ? "dist-dev" : "dist"
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
    ssr: test ? "test/worker.ts" : dev ? "dev/worker.ts" : "src/worker.ts",
    outDir,
    emptyOutDir: !dev,
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
writeFileSync(
  new URL(`../${outDir}/release-manifest.json`, import.meta.url),
  readFileSync(new URL("../release-manifest.json", import.meta.url)),
)
