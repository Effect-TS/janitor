import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { createSign } from "node:crypto"
import { parseGitHubJSON } from "./github-json.mjs"
import assert from "node:assert/strict"
const e = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE, "utf8")),
  pending = JSON.parse(readFileSync(process.env.FIXTURE_PENDING_PATH, "utf8"))
function jwt() {
  const now = Math.floor(Date.now() / 1000),
    enc = (x) => Buffer.from(JSON.stringify(x)).toString("base64url")
  const raw =
    enc({ alg: "RS256", typ: "JWT" }) +
    "." +
    enc({ iat: now - 60, exp: now + 540, iss: e.JANITOR_GITHUB_APP_ID })
  return (
    raw +
    "." +
    createSign("RSA-SHA256")
      .update(raw)
      .sign(e.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"), "base64url")
  )
}
const report = {
  checkedAt: new Date().toISOString(),
  guid: pending.guid,
  attempts: [],
  pages: 0,
  summaries: 0,
  fullWindowScanned: false,
  mutations: 0,
}
let path = "/app/hook/deliveries?per_page=100"
const started = Date.now(),
  seen = new Set()
for (let page = 0; path && page < 200; page++) {
  assert(!seen.has(path))
  seen.add(path)
  const url = new URL(path, "https://api.github.com")
  assert.equal(url.origin, "https://api.github.com")
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    signal: AbortSignal.timeout(30000),
  })
  assert(r.ok, `HTTP ${r.status}`)
  const summaries = parseGitHubJSON(await r.text())
  report.pages++
  report.summaries += summaries.length
  report.rateRemaining = r.headers.get("x-ratelimit-remaining")
  for (const s of summaries)
    if (
      s.guid === pending.guid &&
      s.repository_id === 1323166030 &&
      s.installation_id === 158746421
    )
      report.attempts.push({
        id: s.id,
        guid: s.guid,
        redelivery: s.redelivery,
        status: s.status_code,
      })
  path = r.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1]
  if (report.rateRemaining !== null && Number(report.rateRemaining) < 200) break
}
report.fullWindowScanned = !path
report.resumeCursor = path ?? null
report.elapsedMs = Date.now() - started
writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
assert(report.attempts.some((a) => a.id === pending.originalAttemptID && !a.redelivery))
assert(
  report.attempts.some(
    (a) => a.id !== pending.originalAttemptID && a.redelivery && a.status >= 200 && a.status < 300,
  ),
)
assert.equal(new Set(report.attempts.map((a) => a.guid)).size, 1)
writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
