import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { parseEnv } from "node:util"
import { createSign, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
const prior = JSON.parse(readFileSync("github-result.json", "utf8"))
const cwd = join(prior.root, "work")
const e = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE, "utf8"))
const encode = (x) => Buffer.from(JSON.stringify(x)).toString("base64url")
const now = Math.floor(Date.now() / 1000)
const payload =
  encode({ alg: "RS256" }) +
  "." +
  encode({ iat: now - 60, exp: now + 540, iss: e.JANITOR_GITHUB_APP_ID })
const jwt =
  payload +
  "." +
  createSign("RSA-SHA256")
    .update(payload)
    .sign(e.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"), "base64url")
const branch = `janitor-verification/${randomUUID().slice(0, 8)}-protected`
const prefix = "/repos/Effect-TS/slopcop-sandbox"
const report = { branch }
let token
let created = false
let protectedBranch = false
async function api(path, credential, method = "GET", body, expected = [200, 201, 204]) {
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
  const result = text ? JSON.parse(text) : undefined
  assert.ok(expected.includes(r.status), `${r.status}: ${result?.message}`)
  return result
}
const admin = (method, body) => {
  const args = [
    "api",
    "--method",
    method,
    `${prefix}/branches/${encodeURIComponent(branch)}/protection`,
  ]
  if (body) args.push("--input", "-")
  const result = spawnSync("gh", args, {
    input: body ? JSON.stringify(body) : undefined,
    encoding: "utf8",
    timeout: 30000,
  })
  assert.equal(result.status, 0, result.stderr)
  return result
}
try {
  token = (
    await api("/app/installations/158746421/access_tokens", jwt, "POST", {
      repository_ids: [1323166030],
      permissions: { contents: "write" },
    })
  ).token
  const initial = (await api(prefix + "/git/ref/heads/main", token)).object.sha
  await api(prefix + "/git/refs", token, "POST", { ref: "refs/heads/" + branch, sha: initial })
  created = true
  // Only this disposable branch receives a temporary rule. User GitHub CLI
  // authentication configures it; publication is attempted with the App token.
  admin("PUT", {
    required_status_checks: { strict: true, contexts: ["janitor-fixture-required"] },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
  })
  protectedBranch = true
  const helper =
    '!f() { test "$1" = get || exit 0; printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_FIXTURE_TOKEN"; }; f'
  const push = spawnSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helper}`,
      "push",
      "origin",
      `HEAD:refs/heads/${branch}`,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        GITHUB_FIXTURE_TOKEN: token,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  )
  assert.notEqual(push.status, 0)
  assert.match(push.stderr, /protected branch|GH006|GH013|required status check/i)
  assert.equal((await api(prefix + "/git/ref/heads/" + branch, token)).object.sha, initial)
  report.branchWriteRejected = true
  report.passed = true
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  try {
    if (protectedBranch) {
      admin("DELETE")
      report.protectionRemoved = true
    }
    if (created) {
      await api(prefix + "/git/refs/heads/" + branch, token, "DELETE")
      report.branchDeleted = true
    }
    if (token) {
      await api("/installation/token", token, "DELETE")
      report.tokenRevoked = true
    }
  } catch (error) {
    report.cleanupError = String(error)
    report.passed = false
  }
  writeFileSync("github-branch-protection-result.json", JSON.stringify(report, null, 2) + "\n")
}
assert.equal(report.passed, true, JSON.stringify(report))
console.log(JSON.stringify(report))
