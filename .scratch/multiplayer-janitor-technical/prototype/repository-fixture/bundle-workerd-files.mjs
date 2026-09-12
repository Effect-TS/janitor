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
  resolve: { conditions },
  ssr: { target: "webworker", noExternal: true, resolve: { conditions } },
  build: {
    ssr: "worker-opencode.mjs",
    outDir: "dist-workerd-files",
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
