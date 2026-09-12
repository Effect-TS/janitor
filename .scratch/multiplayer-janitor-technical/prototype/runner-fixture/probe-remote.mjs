import fs from "node:fs"
import assert from "node:assert/strict"
const { FIXTURE_TOKEN } = JSON.parse(fs.readFileSync(process.env.FIXTURE_SECRET_FILE, "utf8"))
const url = process.env.FIXTURE_URL
const results = { startedAt: new Date().toISOString(), cases: [], calls: [] }
const names = new Set()
const save = () =>
  fs.writeFileSync(process.env.FIXTURE_RESULT_FILE, JSON.stringify(results, null, 2) + "\n")
async function call(name, path, body, expected = 200) {
  names.add(name)
  const start = Date.now()
  const r = await fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer " + FIXTURE_TOKEN, "x-fixture-instance": name },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  const raw = await r.text()
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }
  results.calls.push({ name, path, status: r.status, elapsedMs: Date.now() - start, data })
  save()
  assert.equal(r.status, expected, raw.slice(0, 1000))
  return data
}
async function check(name, config, inputs, waitMs, verify) {
  try {
    await call(name, "/create", config)
    for (const input of inputs) await call(name, "/admit", input, input.lostReply ? 503 : 200)
    const silenceStarted = Date.now()
    await new Promise((r) => setTimeout(r, waitMs))
    const evidence = await call(name, "/evidence")
    verify(evidence)
    results.cases.push({ name, passed: true, noRequestsDuringWaitMs: Date.now() - silenceStarted })
    console.log(name, "passed")
  } catch (error) {
    results.cases.push({ name, passed: false, error: String(error) })
    console.error(name, String(error))
  }
  save()
}
try {
  await Promise.all([
    check(
      "long-v1",
      { delayMs: 180000, intervalMs: 30000 },
      [{ text: "complete one long task" }],
      220000,
      (e) => {
        assert.equal(e.modelCalls, 1)
        assert.equal(e.row.time_suspended, null)
        assert.equal(e.obligation, false)
        assert(e.trace.filter((t) => t.kind === "alarm-start").length >= 5)
        assert.equal(e.trace.filter((t) => t.kind === "constructor").length, 1)
        assert.equal(e.events.filter((t) => t.type === "session.inbox.enqueued").length, 1)
      },
    ),
    check(
      "recover-v1",
      { crashes: 1, delayMs: 1500, intervalMs: 1000 },
      [{ text: "recover automatically" }],
      17000,
      (e) => {
        assert.equal(e.modelCalls, 2)
        assert.equal(e.obligation, false)
        assert(e.trace.filter((t) => t.kind === "constructor").length >= 2)
        const after = e.trace.findIndex((t) => t.kind === "constructor" && t.seq > 1)
        assert.equal(e.trace[after + 1].kind, "alarm-start")
        assert(e.events.some((t) => t.type === "session.synthetic"))
      },
    ),
    check(
      "exhaust-v1",
      { crashes: 11, intervalMs: 1000 },
      [{ text: "repeatedly interrupted" }],
      60000,
      (e) => {
        assert.equal(e.modelCalls, 11)
        assert.equal(e.obligation, false)
        assert(
          e.events.some(
            (t) =>
              t.type === "session.execution.failed" &&
              JSON.stringify(t).includes("interrupted repeatedly"),
          ),
        )
      },
    ),
    check(
      "saved-v1",
      { delayMs: 1000, intervalMs: 1000 },
      [{ text: "save without initial wake", skipWake: true, lostReply: true }],
      9000,
      (e) => {
        assert.equal(e.modelCalls, 1)
        assert.equal(e.obligation, false)
        assert(
          e.trace.findIndex((t) => t.kind === "alarm-start") <
            e.trace.findIndex((t) => t.kind === "model-start"),
        )
      },
    ),
    check(
      "queue-v1",
      { delayMs: 1000, intervalMs: 1000 },
      [{ text: "Slack first" }, { text: "GitHub second" }, { text: "Slack third" }],
      10000,
      (e) => {
        assert.equal(e.modelCalls, 3)
        const enqueued = e.events
          .filter((t) => t.type === "session.inbox.enqueued")
          .map((t) => t.data.inboxID)
        assert.deepEqual(
          e.events.filter((t) => t.type === "session.inbox.delivered").map((t) => t.data.inboxID),
          enqueued,
        )
        assert.equal(e.obligation, false)
      },
    ),
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
