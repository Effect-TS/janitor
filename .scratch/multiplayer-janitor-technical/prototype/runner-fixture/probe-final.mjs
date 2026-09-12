import fs from "node:fs"
import assert from "node:assert/strict"
const { FIXTURE_TOKEN } = JSON.parse(fs.readFileSync(process.env.FIXTURE_SECRET_FILE, "utf8"))
const results = { startedAt: new Date().toISOString(), cases: [], calls: [] },
  names = new Set()
const save = () =>
  fs.writeFileSync(process.env.FIXTURE_RESULT_FILE, JSON.stringify(results, null, 2) + "\n")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function call(name, path, body, expected = 200) {
  names.add(name)
  const r = await fetch(process.env.FIXTURE_URL + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer " + FIXTURE_TOKEN, "x-fixture-instance": name },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  let data
  const raw = await r.text()
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }
  results.calls.push({ name, path, status: r.status, data })
  save()
  assert.equal(r.status, expected, raw.slice(0, 500))
  return data
}
async function scenario(name, fn) {
  try {
    await fn(name)
    results.cases.push({ name, passed: true })
    console.log(name, "passed")
  } catch (error) {
    results.cases.push({ name, passed: false, error: String(error) })
    console.error(name, String(error))
  }
  save()
}
try {
  await Promise.all([
    scenario("shell-policy-v4", async (name) => {
      await call(name, "/create", { intervalMs: 700, guardShell: true })
      await call(name, "/admit", { text: "exercise native shell policy" })
      await sleep(7000)
      const e = await call(name, "/evidence")
      assert.equal(e.obligation, false)
      assert.equal(e.modelCalls, 5)
      assert.deepEqual(
        e.trace.filter((t) => t.kind === "shell-boundary").map((t) => t.data.timeout),
        [120000, 300000],
      )
      assert.equal(e.trace.filter((t) => t.kind === "shell-rejected").length, 2)
    }),
    scenario("boot-gate-v4", async (name) => {
      await call(name, "/create", { intervalMs: 1000, crashes: 1, blockOnCrash: true })
      await call(name, "/admit", { text: "must not recover through unresolved effects" })
      await sleep(7000)
      const e = await call(name, "/evidence")
      assert.equal(e.modelCalls, 1)
      assert.equal(e.obligation, false)
      assert(e.trace.some((t) => t.kind === "blocked"))
      assert.equal(e.trace.filter((t) => t.kind === "model-response").length, 0)
    }),
    scenario("creation-crash-v4", async (name) => {
      await call(name, "/create", { intervalMs: 700, abortCreate: true }, 500)
      const c = await call(name, "/create", { intervalMs: 700 })
      await call(name, "/admit", { text: "same native conversation after creation crash" })
      await sleep(4000)
      const e = await call(name, "/evidence")
      assert.equal(e.events.filter((t) => t.type === "session.created").length, 1)
      assert.equal(e.session, c.session)
      assert.equal(e.modelCalls, 1)
    }),
  ])
  results.passed = results.cases.every((c) => c.passed)
} finally {
  results.cleanup = []
  for (const name of names) {
    try {
      await call(name, "/cleanup", {})
      results.cleanup.push({ name, cleaned: true })
    } catch (error) {
      results.cleanup.push({ name, error: String(error) })
    }
  }
  results.finishedAt = new Date().toISOString()
  save()
}
if (!results.passed) process.exitCode = 1
