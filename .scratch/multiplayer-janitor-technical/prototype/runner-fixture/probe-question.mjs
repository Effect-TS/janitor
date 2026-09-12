import { Miniflare } from "miniflare"
import fs from "node:fs"
import assert from "node:assert/strict"
const mf = new Miniflare({
  modules: true,
  scriptPath: new URL("./dist-runner/worker.mjs", import.meta.url).pathname,
  compatibilityDate: "2026-07-04",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { FIXTURE_TOKEN: "local-test" },
  durableObjects: { RUNNER: { className: "Runner", useSQLite: true } },
})
const results = []
async function call(name, path, body) {
  const r = await mf.dispatchFetch("http://fixture" + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer local-test", "x-fixture-instance": name },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  results.push({ name, path, status: r.status, data })
  assert.equal(r.status, 200, String(text))
  return data
}
try {
  await call("question", "/create", { intervalMs: 500, httpMode: "question", deadlineMs: 150 })
  await call("question", "/admit", { text: "ask me a question" })
  await new Promise((r) => setTimeout(r, 1800))
  const before = await call("question", "/evidence")
  await call("question", "/admit", { text: "Choose A" })
  await new Promise((r) => setTimeout(r, 2000))
  const after = await call("question", "/evidence")
  console.log(JSON.stringify({ before, after }, null, 2))
  await call("question", "/cleanup", {})
} finally {
  await mf.dispose()
  fs.writeFileSync("runner-question-result.json", JSON.stringify(results, null, 2) + "\n")
}
