import assert from "node:assert/strict"
import { parseEnv } from "node:util"
import { createSign, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Authorized disposable repository only. Secrets stay in process memory and
// short-lived Git child environments, never URLs, config, or saved artifacts.
const repository = "Effect-TS/slopcop-sandbox"
const repositoryID = 1323166030
const env = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE, "utf8"))
const appID = env.JANITOR_GITHUB_APP_ID
const privateKey = env.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n")
const runID = randomUUID().slice(0, 8)
const base = `janitor-verification/${runID}-base`
const head = `janitor-verification/${runID}-work`
const root = mkdtempSync(join(tmpdir(), "janitor-github-fixture-"))
const work = join(root, "work")
const human = join(root, "human")
const tokens = []
const createdBranches = []
let pr
let writeToken
let installationID
const report = { repository, repositoryID, runID, root, checks: [], cleanup: [] }
const save = () => writeFileSync("github-result.json", JSON.stringify(report, null, 2) + "\n")
const safe = (text) =>
  tokens.reduce((value, token) => value.replaceAll(token, "[redacted]"), String(text))
function jwt() {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const value =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({ iat: now - 60, exp: now + 540, iss: appID })
  return value + "." + createSign("RSA-SHA256").update(value).sign(privateKey, "base64url")
}
async function api(path, token, method = "GET", body, allowed = [200, 201, 204]) {
  const r = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await r.text()
  const value = text ? JSON.parse(text) : undefined
  if (!allowed.includes(r.status))
    throw new Error(`GitHub ${method} ${path}: ${r.status} ${safe(value?.message)}`)
  return { status: r.status, value }
}
const cache = new Map()
let now = () => Date.now()
let minted = 0
async function tokenFor(permissions, force = false) {
  const key = JSON.stringify([installationID, repositoryID, Object.entries(permissions).sort()])
  const cached = cache.get(key)
  if (!force && cached && cached.expires - 60000 > now()) return cached.token
  const { value } = await api(`/app/installations/${installationID}/access_tokens`, jwt(), "POST", {
    repository_ids: [repositoryID],
    permissions,
  })
  tokens.push(value.token)
  minted++
  assert.deepEqual(
    value.repositories.map((r) => r.id),
    [repositoryID],
  )
  for (const [permission, access] of Object.entries(permissions))
    assert.equal(value.permissions[permission], access)
  cache.set(key, { token: value.token, expires: Date.parse(value.expires_at) })
  return value.token
}
const helper =
  '!f() { test "$1" = get || exit 0; printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_FIXTURE_TOKEN"; }; f'
function git(cwd, args, token = writeToken, expected = 0) {
  const result = spawnSync(
    "git",
    ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GITHUB_FIXTURE_TOKEN: token,
      },
    },
  )
  if (result.status !== expected)
    throw new Error(
      `Git ${args[0]} expected ${expected}, got ${result.status}: ${safe(result.stderr)}`,
    )
  return result.stdout
}
const identify = (cwd, name) => {
  git(cwd, ["config", "user.name", name])
  git(cwd, ["config", "user.email", "fixture@example.invalid"])
}
const ref = async () => git(work, ["ls-remote", "origin", `refs/heads/${head}`]).split(/\s/)[0]
const check = (name) => {
  report.checks.push(name)
  save()
  console.log(name)
}
try {
  installationID = (await api(`/repos/${repository}/installation`, jwt())).value.id
  report.installationID = installationID
  const permissions = { contents: "write", pull_requests: "write" }
  writeToken = await tokenFor(permissions)
  assert.equal(await tokenFor(permissions), writeToken)
  assert.equal(minted, 1)
  const readToken = await tokenFor({ contents: "read" })
  assert.notEqual(readToken, writeToken)
  const visible = (await api("/installation/repositories", writeToken)).value
  assert.equal(visible.total_count, 1)
  assert.equal(visible.repositories[0].id, repositoryID)
  check(
    "installation tokens restricted to the designated repository and distinct read/write permissions",
  )
  const beforeRefresh = minted
  now = () => Date.now() + 3600000
  const refreshProbe = await tokenFor(permissions)
  now = () => Date.now()
  assert.equal(minted, beforeRefresh + 1)
  check("token cache reuses a valid scope and refreshes at expiry under an injected clock")

  const repo = (await api(`/repos/${repository}`, writeToken)).value
  assert.equal(repo.id, repositoryID)
  assert.equal(repo.archived, false)
  report.defaultBranch = repo.default_branch
  git(root, [
    "clone",
    "--no-tags",
    "--single-branch",
    "--branch",
    repo.default_branch,
    `https://github.com/${repository}.git`,
    work,
  ])
  identify(work, "Janitor Fixture")
  report.originalDefaultHead = git(work, ["rev-parse", "HEAD"]).trim()
  git(work, ["push", "origin", `HEAD:refs/heads/${base}`])
  createdBranches.push(base)
  git(work, ["checkout", "-b", head])
  mkdirSync(join(work, ".janitor-fixture"), { recursive: true })
  const file = `.janitor-fixture/${runID}.md`
  writeFileSync(join(work, file), "# Disposable Janitor verification\nInitial fixture draft.\n")
  git(work, ["add", file])
  git(work, ["commit", "-m", "Disposable Janitor verification draft"])
  git(work, ["push", "origin", `HEAD:refs/heads/${head}`])
  createdBranches.push(head)
  check("ordinary HTTPS Git with installation credentials creates isolated new-work branches")

  const query = `/repos/${repository}/pulls?state=all&head=${encodeURIComponent("Effect-TS:" + head)}&base=${encodeURIComponent(base)}`
  assert.equal((await api(query, writeToken)).value.length, 0)
  // Discard successful publication result at the application boundary. Recovery
  // must inspect identity rather than issue another creation request.
  await api(`/repos/${repository}/pulls`, writeToken, "POST", {
    title: `Disposable Janitor verification ${runID}`,
    head,
    base,
    draft: true,
    body: "Authorized disposable execution-contract fixture. No merge is intended. This PR will be closed and its temporary branches deleted after verification.",
  })
  const found = (await api(query, writeToken)).value
  assert.equal(found.length, 1)
  pr = found[0]
  report.pullRequest = pr.html_url
  save()
  check("discarded successful PR creation reply reconciles to exactly one draft PR")

  writeFileSync(
    join(work, file),
    "# Disposable Janitor verification\nReview feedback implemented.\n",
  )
  git(work, ["add", file])
  git(work, ["commit", "-m", "Address fixture review feedback"])
  const expected = git(work, ["rev-parse", "HEAD"]).trim()
  git(work, ["push", "origin", `HEAD:refs/heads/${head}`])
  assert.equal(await ref(), expected)
  const deadline = Date.now() + 20000
  for (;;) {
    const observed = (await api(`/repos/${repository}/pulls/${pr.number}`, writeToken)).value.head
      .sha
    if (observed === expected) break
    assert.ok(Date.now() < deadline, "PR projection did not catch up to published ref")
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  check("existing PR branch update and discarded successful push reply reconcile by remote commit")

  git(root, [
    "clone",
    "--single-branch",
    "--branch",
    head,
    `https://github.com/${repository}.git`,
    human,
  ])
  identify(human, "Simulated Teammate")
  writeFileSync(
    join(human, ".janitor-fixture", `${runID}-human.md`),
    "Concurrent teammate change.\n",
  )
  git(human, ["add", ".janitor-fixture"])
  git(human, ["commit", "-m", "Simulated concurrent teammate commit"])
  const humanHead = git(human, ["rev-parse", "HEAD"]).trim()
  git(human, ["push", "origin", `HEAD:refs/heads/${head}`])
  writeFileSync(join(work, ".janitor-fixture", `${runID}-agent.md`), "Concurrent agent change.\n")
  git(work, ["add", ".janitor-fixture"])
  git(work, ["commit", "-m", "Concurrent agent fixture commit"])
  git(work, ["push", "origin", `HEAD:refs/heads/${head}`], writeToken, 1)
  git(work, ["fetch", "origin", head])
  git(work, ["rebase", "FETCH_HEAD"])
  git(work, ["merge-base", "--is-ancestor", humanHead, "HEAD"])
  const beforeDeniedPush = await ref()
  const denied = spawnSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helper}`,
      "push",
      "origin",
      `HEAD:refs/heads/${head}`,
    ],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GITHUB_FIXTURE_TOKEN: readToken,
      },
    },
  )
  assert.notEqual(denied.status, 0)
  assert.equal(await ref(), beforeDeniedPush)
  git(work, ["push", "origin", `HEAD:refs/heads/${head}`])
  assert.equal(await ref(), git(work, ["rev-parse", "HEAD"]).trim())
  check(
    "concurrent GitHub push is rejected, human history survives reconciliation, and read-only credentials cannot publish",
  )

  const archive = join(root, "checkpoint.tar")
  execFileSync("tar", ["-cf", archive, "-C", work, "."])
  const archiveBytes = readFileSync(archive)
  for (const token of tokens) assert.equal(archiveBytes.includes(Buffer.from(token)), false)
  assert.equal(archiveBytes.includes(Buffer.from(privateKey)), false)
  assert.equal(readFileSync(join(work, ".git/config"), "utf8").includes("credential"), false)
  check("working-tree and Git-state checkpoint contains no App key or installation token")

  await api("/installation/token", writeToken, "DELETE")
  assert.equal(
    (await api("/installation/repositories", writeToken, "GET", undefined, [401])).status,
    401,
  )
  writeToken = await tokenFor(permissions, true)
  assert.equal(
    (await api("/installation/repositories", writeToken)).value.repositories[0].id,
    repositoryID,
  )
  check("revoked token is rejected and a fresh scoped installation token restores access")
  const defaultHead = git(work, ["ls-remote", "origin", `refs/heads/${repo.default_branch}`]).split(
    /\s/,
  )[0]
  assert.equal(defaultHead, report.originalDefaultHead)
  report.passed = true
} catch (error) {
  report.error = safe(error)
  save()
  throw error
} finally {
  if (writeToken) {
    try {
      if (!pr) {
        const found = (
          await api(
            `/repos/${repository}/pulls?state=all&head=${encodeURIComponent("Effect-TS:" + head)}`,
            writeToken,
          )
        ).value
        pr = found.find((p) => p.base.ref === base)
      }
      if (pr) {
        await api(`/repos/${repository}/pulls/${pr.number}`, writeToken, "PATCH", {
          state: "closed",
        })
        report.cleanup.push({ closedPR: pr.html_url })
      }
      for (const branch of createdBranches.reverse()) {
        await api(`/repos/${repository}/git/refs/heads/${branch}`, writeToken, "DELETE")
        report.cleanup.push({ deletedBranch: branch })
      }
    } catch (error) {
      report.cleanupError = safe(error)
      report.passed = false
    }
    for (const token of tokens) {
      try {
        await api("/installation/token", token, "DELETE", undefined, [204, 401])
      } catch {
        report.cleanup.push({ tokenRevocationFailed: true })
        report.passed = false
      }
    }
  }
  save()
}
assert.equal(report.passed, true, JSON.stringify(report))
console.log(
  JSON.stringify({
    passed: report.passed,
    pullRequest: report.pullRequest,
    cleanup: report.cleanup,
  }),
)
