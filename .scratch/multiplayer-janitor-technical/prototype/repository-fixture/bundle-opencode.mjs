import { build } from "vite-plus"
import { builtinModules } from "node:module"
import { readFileSync } from "node:fs"
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
  ssr: { noExternal: true },
  build: {
    ssr: "probe-opencode.mjs",
    outDir: "dist-opencode-fixture",
    minify: false,
    rolldownOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { entryFileNames: "probe.mjs" },
    },
  },
})
