import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
const token = JSON.parse(readFileSync(process.env.FIXTURE_SECRET_FILE, "utf8")).FIXTURE_TOKEN
const url = process.env.FIXTURE_URL
if (!url) throw new Error("FIXTURE_URL required")
const report = { kind: "cloudflare-repository-contract", steps: [] }
const save = () => writeFileSync("contract-result.json", JSON.stringify(report, null, 2) + "\n")
async function call(path, body, expected = 200) {
  const start = Date.now()
  const response = await fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-fixture-instance": process.env.FIXTURE_INSTANCE ?? "fixture",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  const text = await response.text()
  let result
  try {
    result = JSON.parse(text)
  } catch {
    result = { text: text.slice(0, 400) }
  }
  report.steps.push({
    path,
    input: body,
    status: response.status,
    elapsedMs: Date.now() - start,
    result,
  })
  save()
  console.log(path, response.status, Date.now() - start + "ms")
  assert.equal(response.status, expected, JSON.stringify(result))
  return result
}
await call("/start", {})
await call("/sdk", {})
await call("/tools", {})
await call("/protocol", {})
await call("/prepare", {})
await call("/stage", { op: "baseline" })
const baseline = await call("/commit", {})
await call("/stage", { op: "upload-failure", fail: "before-upload" }, 500)
assert.deepEqual((await call("/status")).checkpoint, baseline.checkpoint)
await call("/reconcile", {})
const beforeUploadCrash = await call("/status")
await call("/stage", { op: "upload-crash", fail: "after-upload" }, 500)
const afterUploadCrash = await call("/status")
assert.notEqual(afterUploadCrash.boot, beforeUploadCrash.boot)
assert.deepEqual(afterUploadCrash.checkpoint, baseline.checkpoint)
assert.equal(afterUploadCrash.operations["upload-crash"].state, "uncertain")
await call("/reconcile", {})
await call("/stage", { op: "commit-crash" })
const beforeCommitCrash = await call("/status")
await call("/commit", { fail: "after-commit" }, 500)
const afterCommitCrash = await call("/status")
assert.notEqual(afterCommitCrash.boot, beforeCommitCrash.boot)
assert.equal(afterCommitCrash.operations["commit-crash"].state, "complete")
assert.equal(afterCommitCrash.checkpoint.key, beforeCommitCrash.pending.key)
await call("/restore", {})
await call("/stage", { op: "disconnect-race" })
await call("/active-command", {})
await call("/disconnect", {})
await call("/commit", {}, 500)
await call("/reconcile", {})
await call("/start", {}, 500)
await call("/tools", {}, 500)
await call("/cleanup", {})
report.passed = true
save()
console.log("Contract checks passed")
