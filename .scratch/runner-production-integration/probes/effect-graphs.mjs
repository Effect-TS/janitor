// Preliminary dependency probe, not native Workerd/Sandbox acceptance.
import { createRequire } from "node:module"
import { readFileSync, realpathSync } from "node:fs"
import { pathToFileURL, fileURLToPath } from "node:url"
import { relative } from "node:path"

const root = new URL("../../../", import.meta.url)
const resolveRoot = createRequire(new URL("package.json", root))
const resolveRunner = createRequire(new URL("runner/package.json", root))
const describe = (resolve, name) => {
  const path = realpathSync(
    new URL(`${resolve === resolveRunner ? "runner/" : ""}node_modules/${name}/package.json`, root),
  )
  return {
    version: JSON.parse(readFileSync(path, "utf8")).version,
    path: relative(fileURLToPath(root), path),
  }
}
const app = await import(pathToFileURL(resolveRoot.resolve("effect")))
const runner = await import(pathToFileURL(resolveRunner.resolve("effect")))
const result = {
  root: { effect: describe(resolveRoot, "effect"), alchemy: describe(resolveRoot, "alchemy") },
  runner: {
    effect: describe(resolveRunner, "effect"),
    opencode: describe(resolveRunner, "@opencode/core"),
  },
  sameEffectModule: app === runner,
  checks: [],
  acceptance:
    "Preliminary only. Does not validate native Workerd hosting, Alchemy resource bindings, checkpoints or Sandbox lifecycle.",
}
for (const [name, runtime, producer] of [
  ["root executes root Effect", app, app],
  ["runner executes runner Effect", runner, runner],
  ["root executes runner Effect", app, runner],
  ["runner executes root Effect", runner, app],
]) {
  try {
    const Service = producer.Context.Service(`probe/${name}`)
    const program = producer.Effect.gen(function* () {
      const value = yield* Service
      return value.answer
    }).pipe(producer.Effect.provide(producer.Layer.succeed(Service, { answer: 42 })))
    const value = await runtime.Effect.runPromise(program.pipe(runtime.Effect.timeout("2 seconds")))
    result.checks.push({ name, passed: value === 42 })
  } catch (error) {
    result.checks.push({ name, passed: false, error: String(error).slice(0, 500) })
  }
}
console.log(JSON.stringify(result, null, 2))
