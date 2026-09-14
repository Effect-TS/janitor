// Resolve the actual workspace graph without printing local paths or credentials.
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"

const root = new URL("../../../", import.meta.url)
const requireRoot = createRequire(new URL("package.json", root))
const requireRunner = createRequire(new URL("apps/runner/package.json", root))
const paths = { root: requireRoot.resolve("effect"), runner: requireRunner.resolve("effect") }
for (const name of ["@opencode/ai", "@opencode/core", "alchemy"]) {
  const requirePackage = createRequire(
    realpathSync(new URL(`apps/runner/node_modules/${name}/package.json`, root)),
  )
  paths[name] = requirePackage.resolve("effect")
}
const sameEffectModule = new Set(Object.values(paths).map((path) => realpathSync(path))).size === 1
const result = {
  sameEffectModule,
  packages: Object.keys(paths),
  effectSource: "ec83cbdb3c0b0f89df627a7895939a359db9f4ab",
  opencode: "2.0.2",
}
console.log(JSON.stringify(result))
if (!sameEffectModule) process.exitCode = 1
