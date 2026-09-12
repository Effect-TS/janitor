import { parseGitHubJSON } from "./github-json.mjs"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { createSign, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

// Prepared fixture. Never run without approval for App and IMax153-authored test content.
if (process.env.FIXTURE_ALLOW_GITHUB_REVIEWS !== "Effect-TS/slopcop-sandbox")
  throw new Error("Explicit sandbox review authorization is required")
assert(process.env.FIXTURE_REPORT_PATH, "Absolute report path required")
const env = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE, "utf8"))
const privateKey = env.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n")
const human = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()
const repository = "Effect-TS/slopcop-sandbox",
  repositoryID = 1323166030,
  installationID = 158746421
const prefix = `/repos/${repository}`
const runID = randomUUID()
const branch = `janitor-delivery/${runID}`
const file = `janitor-delivery-${runID}.txt`
const report = {
  runID,
  startedAt: new Date().toISOString(),
  repository,
  branch,
  operations: [],
  reviews: [],
  comments: [],
  snapshots: [],
  deliveries: [],
  checks: [],
  cleanup: [],
}
let token,
  pr,
  branchCreated = false,
  lastWrite = 0
const secrets = [human, privateKey]
const safe = (value) =>
  secrets.reduce((s, secret) => (secret ? s.replaceAll(secret, "[redacted]") : s), String(value))
const save = () =>
  writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  })
function jwt() {
  const encode = (x) => Buffer.from(JSON.stringify(x)).toString("base64url")
  const now = Math.floor(Date.now() / 1000)
  const unsigned =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({ iat: now - 60, exp: now + 540, iss: env.JANITOR_GITHUB_APP_ID })
  const signed =
    unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")
  secrets.push(signed)
  return signed
}
async function api(path, credential, method = "GET", body, allowed = [200, 201, 202, 204]) {
  const url = new URL(path, "https://api.github.com")
  assert.equal(url.origin, "https://api.github.com")
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${credential}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const raw = await response.text()
  const value = raw ? parseGitHubJSON(raw) : undefined
  if (!allowed.includes(response.status))
    throw new Error(
      `${method} ${url.pathname}: HTTP ${response.status}, ${safe(value?.message ?? "unknown")}`,
    )
  return {
    value,
    status: response.status,
    next: response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1],
  }
}
async function write(name, path, credential, method, body) {
  const operation = { name, method, path, state: "uncertain" }
  report.operations.push(operation)
  save()
  await delay(Math.max(0, lastWrite + 1100 - Date.now()))
  lastWrite = Date.now()
  const result = await api(path, credential, method, body)
  operation.state = "confirmed"
  operation.id = result.value?.id
  operation.number = result.value?.number
  save()
  return result.value
}
async function list(path, credential = token) {
  const all = [],
    seen = new Set()
  for (let n = 0; path; n++) {
    assert(n < 30, "Pagination exceeds fixture bound")
    assert(!seen.has(path), "Repeated pagination link")
    seen.add(path)
    const r = await api(path, credential)
    assert(Array.isArray(r.value))
    all.push(...r.value)
    path = r.next
  }
  return all
}
const shape = (v) => ({
  id: v.id,
  reviewID: v.pull_request_review_id,
  replyTo: v.in_reply_to_id,
  author: v.user?.login,
  authorID: v.user?.id,
  authorType: v.user?.type,
  state: v.state,
  body: v.body,
  createdAt: v.created_at,
  updatedAt: v.updated_at,
  submittedAt: v.submitted_at,
  path: v.path,
  line: v.line,
  commitID: v.commit_id,
})
async function capture() {
  const expected = [
    ...report.allReviews.map((r) => `pull_request_review:submitted:${r.id}`),
    ...report.allComments.map((c) => `pull_request_review_comment:created:${c.id}`),
    ...report.comments.filter((c) => !c.reviewID).map((c) => `issue_comment:created:${c.id}`),
    `pull_request_review_comment:edited:${report.snapshots[0].comments[1].id}`,
  ]
  let path = "/app/hook/deliveries?per_page=100"
  const seen = new Set()
  for (let page = 0; path && page < 30; page++) {
    assert(!seen.has(path), "Repeated delivery cursor")
    seen.add(path)
    const response = await api(path, jwt())
    const summaries = response.value
    for (const summary of summaries) {
      if (
        summary.repository_id !== repositoryID ||
        summary.installation_id !== installationID ||
        !["pull_request_review", "pull_request_review_comment", "issue_comment"].includes(
          summary.event,
        ) ||
        Date.parse(summary.delivered_at) < Date.parse(report.startedAt) - 5000 ||
        report.deliveries.some((d) => d.attemptID === summary.id)
      )
        continue
      const detail = (await api(`/app/hook/deliveries/${summary.id}`, jwt())).value
      const payload = detail.request?.payload
      if (
        payload?.repository?.id !== repositoryID ||
        (payload.pull_request?.number ?? payload.issue?.number) !== pr.number
      )
        continue
      report.deliveries.push({
        attemptID: summary.id,
        guid: summary.guid,
        event: summary.event,
        action: payload.action,
        statusCode: summary.status_code,
        redelivery: summary.redelivery,
        contribution: shape(payload.comment ?? payload.review ?? {}),
        deliveredAt: summary.delivered_at,
      })
    }
    report.captureMissing = expected.filter(
      (key) =>
        !report.deliveries.some((d) => `${d.event}:${d.action}:${d.contribution.id}` === key),
    )
    save()
    if (!report.captureMissing.length) return
    path = response.next
  }
}
try {
  save()
  const app = (await api("/app", jwt())).value
  assert.equal(app.id, 4811166)
  for (const event of ["issue_comment", "pull_request_review", "pull_request_review_comment"])
    assert(app.events.includes(event), `Missing subscription ${event}`)
  assert.equal((await api("/user", human)).value.login, "IMax153")
  const issued = (
    await api(`/app/installations/${installationID}/access_tokens`, jwt(), "POST", {
      repository_ids: [repositoryID],
      permissions: { contents: "write", pull_requests: "write" },
    })
  ).value
  token = issued.token
  secrets.push(token)
  assert.deepEqual(
    issued.repositories.map((r) => r.id),
    [repositoryID],
  )
  const repo = (await api(prefix, token)).value
  assert.equal(repo.id, repositoryID)
  const base = (await api(`${prefix}/git/ref/heads/${repo.default_branch}`, token)).value.object.sha
  await write("branch", `${prefix}/git/refs`, token, "POST", {
    ref: `refs/heads/${branch}`,
    sha: base,
  })
  branchCreated = true
  const commit = await write("fixture-file", `${prefix}/contents/${file}`, token, "PUT", {
    branch,
    message: `Disposable review fixture ${runID}`,
    content: Buffer.from(
      "First fixture line\nSecond fixture line\nThird fixture line\nFourth fixture line\n",
    ).toString("base64"),
  })
  pr = await write("draft-pr", `${prefix}/pulls`, token, "POST", {
    title: `Disposable Janitor review fixture ${runID}`,
    head: branch,
    base: repo.default_branch,
    draft: true,
    body: `Synthetic delivery verification. Close unmerged after capture. Run ${runID}.`,
  })
  report.pr = { number: pr.number, url: pr.html_url }
  save()
  const pulls = `${prefix}/pulls/${pr.number}`
  const batch = await write("submitted-batch-as-IMax153", `${pulls}/reviews`, human, "POST", {
    commit_id: commit.commit.sha,
    event: "COMMENT",
    body: `Fixture review batch ${runID}`,
    comments: [
      { path: file, line: 1, side: "RIGHT", body: "Fixture batch first inline comment" },
      { path: file, line: 2, side: "RIGHT", body: "Fixture batch second inline comment" },
    ],
  })
  report.reviews.push(shape(batch))
  const initial = await list(`${pulls}/reviews/${batch.id}/comments?per_page=1`)
  assert.equal(initial.length, 2)
  report.snapshots.push({ name: "batch-before-replies", comments: initial.map(shape) })
  save()
  const standalone = await write("standalone-as-IMax153", `${pulls}/comments`, human, "POST", {
    commit_id: commit.commit.sha,
    path: file,
    line: 3,
    side: "RIGHT",
    body: `Standalone fixture comment ${runID}`,
  })
  report.comments.push(shape(standalone))
  const later = await write(
    "later-batch-reply-as-IMax153",
    `${pulls}/comments/${initial[0].id}/replies`,
    human,
    "POST",
    { body: `Later human fixture reply ${runID}` },
  )
  report.comments.push(shape(later))
  const marker = `<!-- janitor-operation:${runID}:inline -->`
  const answer = await write(
    "inline-app-answer",
    `${pulls}/comments/${standalone.id}/replies`,
    token,
    "POST",
    { body: `Fixture agent answer.\n\n${marker}` },
  )
  report.comments.push(shape(answer))
  const general = await write(
    "general-mention-as-IMax153",
    `${prefix}/issues/${pr.number}/comments`,
    human,
    "POST",
    { body: `@effect-janitor please inspect this synthetic fixture. Run ${runID}.` },
  )
  report.comments.push(shape(general))
  const overallMarker = `<!-- janitor-operation:${runID}:overall -->`
  const overall = await write(
    "overall-app-answer",
    `${prefix}/issues/${pr.number}/comments`,
    token,
    "POST",
    { body: `Fixture overall answer.\n\n${overallMarker}` },
  )
  report.comments.push(shape(overall))
  const bodyOnly = await write("body-only-review-as-IMax153", `${pulls}/reviews`, human, "POST", {
    event: "COMMENT",
    body: `Fixture body-only review ${runID}`,
  })
  report.reviews.push(shape(bodyOnly))
  const empty = await write("empty-approval-as-IMax153", `${pulls}/reviews`, human, "POST", {
    event: "APPROVE",
  })
  report.reviews.push(shape(empty))
  const inline = await list(`${pulls}/comments?per_page=2`),
    conversation = await list(`${prefix}/issues/${pr.number}/comments?per_page=2`)
  const found = inline.filter(
    (c) =>
      c.body.includes(marker) && c.user.id === answer.user.id && c.in_reply_to_id === standalone.id,
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].id, answer.id)
  assert.equal(
    conversation.filter((c) => c.body.includes(overallMarker) && c.user.id === overall.user.id)
      .length,
    1,
  )
  report.checks.push("Paginated inline and overall App marker reconciliation")
  report.snapshots.push({
    name: "batch-after-later-reply",
    comments: (await list(`${pulls}/reviews/${batch.id}/comments?per_page=1`)).map(shape),
  })
  await write(
    "edit-fixture-inline-as-IMax153",
    `${prefix}/pulls/comments/${initial[1].id}`,
    human,
    "PATCH",
    { body: `Edited fixture inline ${runID}` },
  )
  report.snapshots.push({
    name: "batch-after-edit",
    comments: (await list(`${pulls}/reviews/${batch.id}/comments?per_page=1`)).map(shape),
  })
  report.allReviews = (await list(`${pulls}/reviews?per_page=2`)).map(shape)
  report.allComments = (await list(`${pulls}/comments?per_page=2`)).map(shape)
  report.checks.push(
    "Captured review and standalone/reply relationships without assuming their classification",
  )
  save()
  for (let attempt = 0; attempt < 3; attempt++) {
    await capture()
    if (attempt < 2) await delay(5000)
  }
  for (const type of ["pull_request_review", "pull_request_review_comment", "issue_comment"])
    assert(
      report.deliveries.some((d) => d.event === type),
      `No captured ${type} delivery`,
    )
  assert.equal(report.captureMissing.length, 0, "Incomplete fixture delivery capture")
  report.checks.push("App delivery API captured all expected fixture contributions")
} catch (error) {
  report.failure = safe(error.message)
  process.exitCode = 1
} finally {
  // Unknown write outcomes are recorded, never blindly retried. Reconcile any unknown PR first.
  if (
    token &&
    !pr &&
    report.operations.some((o) => o.name === "draft-pr" && o.state === "uncertain")
  ) {
    try {
      const matches = await list(
        `${prefix}/pulls?state=all&head=Effect-TS:${encodeURIComponent(branch)}&per_page=100`,
      )
      if (matches.length === 1) {
        pr = matches[0]
        report.pr = { number: pr.number, url: pr.html_url }
        report.cleanup.push({ action: "reconciled-pr", number: pr.number })
      } else report.cleanup.push({ action: "reconcile-pr", unresolved: true })
    } catch (error) {
      report.cleanup.push({ action: "reconcile-pr", error: safe(error.message) })
    }
  }
  if (pr && token)
    try {
      await api(`${prefix}/pulls/${pr.number}`, token, "PATCH", { state: "closed" })
      const closed = (await api(`${prefix}/pulls/${pr.number}`, token)).value
      assert.equal(closed.state, "closed")
      assert.equal(closed.merged, false)
      report.cleanup.push({ action: "close-pr-unmerged", ok: true })
    } catch (error) {
      report.cleanup.push({ action: "close-pr", error: safe(error.message) })
      process.exitCode = 1
    }
  if (token && (branchCreated || report.operations.some((o) => o.name === "branch")))
    try {
      await api(`${prefix}/git/refs/heads/${branch}`, token, "DELETE", undefined, [204, 404])
      assert.equal(
        (await api(`${prefix}/git/ref/heads/${branch}`, token, "GET", undefined, [404])).status,
        404,
      )
      report.cleanup.push({ action: "delete-branch", ok: true })
    } catch (error) {
      report.cleanup.push({ action: "delete-branch", error: safe(error.message) })
      process.exitCode = 1
    }
  if (token)
    try {
      await api("/installation/token", token, "DELETE")
      report.cleanup.push({ action: "revoke-token", ok: true })
    } catch (error) {
      report.cleanup.push({ action: "revoke-token", error: safe(error.message) })
      process.exitCode = 1
    }
  save()
  console.log(
    JSON.stringify(
      {
        report: process.env.FIXTURE_REPORT_PATH,
        pr: report.pr,
        checks: report.checks,
        failure: report.failure,
        cleanup: report.cleanup,
      },
      null,
      2,
    ),
  )
}
