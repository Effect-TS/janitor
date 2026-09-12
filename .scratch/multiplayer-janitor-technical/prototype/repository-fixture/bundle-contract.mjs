import { build } from "vite-plus"
import { builtinModules } from "node:module"
import { readFileSync } from "node:fs"
const conditions = ["workerd", "browser", "module", "import", "default"]
await build({
  configFile: false,
  plugins: [
    {
      name: "fixture-text",
      load(id) {
        if (/\.(md|txt|sql)$/.test(id))
          return `export default ${JSON.stringify(readFileSync(id, "utf8"))}`
      },
    },
  ],
  resolve: {
    conditions,
    alias: {
      "@cloudflare/sandbox":
        process.env.SANDBOX_SDK_ENTRY ??
        "/tmp/janitor-remote-fixture-VWapHV/node_modules/@cloudflare/sandbox/dist/index.js",
    },
  },
  ssr: { target: "webworker", noExternal: true, resolve: { conditions } },
  build: {
    ssr: "contract-worker.mjs",
    outDir: "dist-contract",
    minify: false,
    rolldownOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        "cloudflare:workers",
      ],
      output: {
        entryFileNames: "worker.mjs",
        banner:
          'import {createRequire as fixtureCreateRequire} from "node:module"; const require = fixtureCreateRequire("/bundle/worker.mjs");',
      },
    },
  },
})
