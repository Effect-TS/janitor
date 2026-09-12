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
  const c = await call("normal", "/create", { intervalMs: 500, delayMs: 1800 })
  const a = await call("normal", "/admit", { text: "do work" })
  await new Promise((r) => setTimeout(r, 4000))
  const e = await call("normal", "/evidence")
  console.log(JSON.stringify(e, null, 2))
  assert.equal(e.modelCalls, 1)
  assert.equal(e.row.time_suspended, null)
  assert.equal(e.obligation, false)
  assert(e.trace.filter((x) => x.kind === "alarm-start").length >= 2)
  await call("normal", "/admit", { id: a.id, text: "changed retry" })
  await new Promise((r) => setTimeout(r, 1200))
  const d = await call("normal", "/evidence")
  assert.equal(d.modelCalls, 1)
  await call("normal", "/cleanup", {})
  results.push({ passed: true })
} finally {
  await mf.dispose()
  fs.writeFileSync("runner-local-result.json", JSON.stringify(results, null, 2) + "\n")
}
