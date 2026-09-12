import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { createSign, randomUUID } from "node:crypto"
import assert from "node:assert/strict"
const e = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE, "utf8"))
const fixtureToken = JSON.parse(readFileSync(process.env.FIXTURE_SECRET_FILE, "utf8")).FIXTURE_TOKEN
const now = Math.floor(Date.now() / 1000)
const enc = (x) => Buffer.from(JSON.stringify(x)).toString("base64url")
const value =
  enc({ alg: "RS256" }) + "." + enc({ iat: now - 60, exp: now + 540, iss: e.JANITOR_GITHUB_APP_ID })
const jwt =
  value +
  "." +
  createSign("RSA-SHA256")
    .update(value)
    .sign(e.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"), "base64url")
const branch = `janitor-verification/${randomUUID().slice(0, 8)}-cloudflare`
const report = { branch, checks: [] }
let token
async function api(path, credential, method = "GET", body, statuses = [200, 201, 204]) {
  const r = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${credential}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  const b = text ? JSON.parse(text) : undefined
  assert.ok(statuses.includes(r.status), `GitHub ${r.status}: ${b?.message}`)
  return b
}
async function call(path, body) {
  const r = await fetch(process.env.FIXTURE_URL + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixtureToken}`,
      "content-type": "application/json",
      "x-fixture-instance": branch.split("/")[1],
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  const result = await r.json()
  assert.equal(r.status, 200, JSON.stringify(result))
  return result
}
try {
  token = (
    await api("/app/installations/158746421/access_tokens", jwt, "POST", {
      repository_ids: [1323166030],
      permissions: { contents: "write" },
    })
  ).token
  await call("/start", {})
  report.remote = await call("/github-network", { token, branch })
  const ref = await api(`/repos/Effect-TS/slopcop-sandbox/git/ref/heads/${branch}`, token)
  assert.equal(ref.object.sha, report.remote.sha)
  report.passed = true
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  try {
    if (token) {
      await api(
        `/repos/Effect-TS/slopcop-sandbox/git/refs/heads/${branch}`,
        token,
        "DELETE",
        undefined,
        [204, 422],
      )
      report.branchDeleted = true
      await api("/installation/token", token, "DELETE")
      report.tokenRevoked = true
    }
    await call("/cleanup", {})
    report.sandboxCleaned = true
  } catch (error) {
    report.cleanupError = String(error)
    report.passed = false
  }
  writeFileSync("github-cloudflare-result.json", JSON.stringify(report, null, 2) + "\n")
}
assert.equal(report.passed, true, JSON.stringify(report))
console.log(JSON.stringify(report))
