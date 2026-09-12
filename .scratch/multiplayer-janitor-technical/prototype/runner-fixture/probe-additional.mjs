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
    ...[
      "before-first",
      "midstream",
      "activity",
      "quiet-tool",
      "retry-after",
      "disconnect",
      "always-stall",
    ].map((mode) =>
      scenario("http-" + mode + "-v2", async (name) => {
        await call(name, "/create", { httpMode: mode, deadlineMs: 150, intervalMs: 1000 })
        await call(name, "/admit", { text: "exercise " + mode })
        await sleep(mode === "always-stall" ? 45000 : 10000)
        const e = await call(name, "/evidence")
        assert.equal(e.obligation, false)
        assert.equal(e.modelCalls, mode === "activity" ? 1 : mode === "always-stall" ? 5 : 2)
        if (mode === "always-stall") assert.equal(e.row.idle_outcome, "failed")
        else assert.equal(e.row.idle_outcome, "succeeded")
        if (mode === "quiet-tool")
          assert(
            e.trace.find((t) => t.kind === "tool-end").time -
              e.trace.find((t) => t.kind === "tool-start").time >=
              800,
          )
        if (mode === "retry-after") {
          const starts = e.trace.filter((t) => t.kind === "http-start")
          assert(starts[1].time - starts[0].time >= 1000)
        }
      }),
    ),
    scenario("duplicates-v2", async (name) => {
      await call(name, "/create", { intervalMs: 700, delayMs: 1200, lostReply: true }, 503)
      const [c1, c2] = await Promise.all([call(name, "/create", {}), call(name, "/create", {})])
      assert.equal(c1.session, c2.session)
      const a = await call(name, "/admit", { text: "original immutable input" })
      await call(name, "/admit", { id: a.id, text: "changed duplicate" })
      await sleep(4000)
      const e = await call(name, "/evidence")
      assert.equal(e.modelCalls, 1)
      assert.equal(e.events.filter((t) => t.type === "session.inbox.enqueued").length, 1)
      await call(name, "/admit", { id: a.id, text: "changed after promotion" })
      await sleep(2000)
      const d = await call(name, "/evidence")
      assert.equal(d.modelCalls, 1)
      const rollback = await call(name, "/projection", { fail: true })
      assert.equal(rollback.cursor, 0)
      assert.deepEqual(rollback.projected, [])
      const applied = await call(name, "/projection", {})
      const replay = await call(name, "/projection", {})
      assert.deepEqual(applied, replay)
      assert.equal(new Set(applied.projected).size, applied.projected.length)
      assert(applied.cursor > 0)
    }),
    scenario("inspection-v2", async (name) => {
      await call(name, "/create", { intervalMs: 700, delayMs: 1000, inspectionHang: true })
      await call(name, "/inspection-failures", { count: 7 })
      await call(name, "/admit", { text: "wake despite inspection failures", skipWake: true })
      await sleep(11000)
      const e = await call(name, "/evidence")
      assert.equal(e.modelCalls, 1)
      assert.equal(e.obligation, false)
      assert.equal(e.trace.filter((t) => t.kind === "inspection-error").length, 8)
    }),
    scenario("disconnect-v2", async (name) => {
      await call(name, "/create", { intervalMs: 700, delayMs: 6000 })
      await call(name, "/admit", { text: "stop by disconnection" })
      await sleep(1000)
      await call(name, "/disconnect", {})
      await sleep(2000)
      const e = await call(name, "/evidence")
      assert.equal(e.alarm, null)
      assert.equal(e.obligation, false)
      assert.equal(e.trace.filter((t) => t.kind === "model-response").length, 0)
      await call(name, "/admit", { text: "stale input" }, 409)
    }),
    scenario("idle-race-v2", async (name) => {
      await call(name, "/create", { intervalMs: 500, idleDelayMs: 1500 })
      await call(name, "/admit", { text: "first" })
      let saw = false
      for (let i = 0; i < 20; i++) {
        await sleep(150)
        const e = await call(name, "/evidence")
        if (e.trace.some((t) => t.kind === "idle-inspection")) {
          saw = true
          break
        }
      }
      assert(saw)
      await call(name, "/admit", { text: "arrived during idle check" })
      await sleep(5000)
      const e = await call(name, "/evidence")
      assert.equal(e.modelCalls, 2)
      assert(e.trace.some((t) => t.kind === "idle-raced"))
      assert.equal(e.obligation, false)
    }),
    scenario("saved-abort-v2", async (name) => {
      await call(name, "/create", { intervalMs: 1000 })
      await call(
        name,
        "/admit",
        { text: "saved then crash", skipWake: true, abortAfter: true },
        500,
      )
      await sleep(6000)
      const e = await call(name, "/evidence")
      assert.equal(e.modelCalls, 1)
      assert.equal(e.obligation, false)
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
