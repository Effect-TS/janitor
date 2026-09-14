// Serves a runner bundle locally through Miniflare for service-level drivers.
//
// Usage: node scripts/serve.mjs [--test] [--port N] [--persist DIR]
//
// Prints one JSON line `{"url": "...", "token": "..."}` once the runner accepts
// requests. `--test` serves the fault-injecting test bundle with the scripted
// model; the default serves the production bundle and expects real model
// configuration through JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS.
import { Miniflare } from "miniflare"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const test = args.includes("--test")
const port = Number(flag("--port") ?? "0")
const persist = flag("--persist") ?? fs.mkdtempSync(path.join(os.tmpdir(), "janitor-runner-serve-"))
const token = process.env.JANITOR_AGENT_RUNNER_TOKEN ?? "runner-local-token"
const root = new URL("..", import.meta.url).pathname

const testConfigurations = {
  default: "test-default",
  records: [
    {
      id: "test-default",
      provider: "scripted",
      apiModelId: "scripted-1",
      route: "openai-chat",
      endpoint: "https://provider.test/v1/",
      secretBinding: "MODEL_SECRET_TEST",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 100000, output: 4000 },
    },
  ],
}

const bindings = {
  JANITOR_AGENT_RUNNER_TOKEN: token,
  JANITOR_AGENT_RUNNER_RELEASE: process.env.JANITOR_AGENT_RUNNER_RELEASE ?? "local",
  JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS:
    process.env.JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS ??
    (test ? JSON.stringify(testConfigurations) : ""),
  ...(test ? { MODEL_SECRET_TEST: "scripted-secret" } : {}),
}
for (const [name, value] of Object.entries(process.env))
  if (
    (name.startsWith("MODEL_SECRET_") || name === "JANITOR_AGENT_RUNNER_MODEL_API_KEY") &&
    value !== undefined
  )
    bindings[name] = value

const mf = new Miniflare({
  modules: true,
  scriptPath: path.join(root, test ? "dist-test" : "dist", "worker.mjs"),
  compatibilityDate: "2026-07-04",
  compatibilityFlags: ["nodejs_compat"],
  bindings,
  durableObjects: { SESSIONS: { className: "SessionRunner", useSQLite: true } },
  durableObjectsPersist: persist,
  port,
  host: "127.0.0.1",
})
const url = await mf.ready
process.stdout.write(
  JSON.stringify({ url: url.toString().replace(/\/$/, ""), token, persist }) + "\n",
)

const stop = async () => {
  await mf.dispose()
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
process.stdin.on("end", stop)
process.stdin.resume()
