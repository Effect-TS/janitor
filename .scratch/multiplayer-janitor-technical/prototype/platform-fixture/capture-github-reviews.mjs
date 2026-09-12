import { parseGitHubJSON } from "./github-json.mjs"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { createSign } from "node:crypto"
const run = JSON.parse(readFileSync(process.env.FIXTURE_RUN_PATH, "utf8"))
assert.equal(run.repository, "Effect-TS/slopcop-sandbox")
const env = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE, "utf8"))
function jwt() {
  const now = Math.floor(Date.now() / 1000),
    encode = (x) => Buffer.from(JSON.stringify(x)).toString("base64url")
  const unsigned =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({ iat: now - 60, exp: now + 540, iss: env.JANITOR_GITHUB_APP_ID })
  return (
    unsigned +
    "." +
    createSign("RSA-SHA256")
      .update(unsigned)
      .sign(env.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"), "base64url")
  )
}
async function get(path) {
  const url = new URL(path, "https://api.github.com")
  assert.equal(url.origin, "https://api.github.com")
  assert(url.pathname.startsWith("/app/hook/deliveries"))
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    signal: AbortSignal.timeout(30000),
  })
  assert(r.ok, `Delivery GET ${url.pathname} HTTP ${r.status}`)
  return {
    value: parseGitHubJSON(await r.text()),
    next: r.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1],
  }
}
const expected = [
  ...run.allReviews.map((r) => `pull_request_review:submitted:${r.id}`),
  ...run.allComments.map((c) => `pull_request_review_comment:created:${c.id}`),
  ...run.comments.filter((c) => !c.reviewID).map((c) => `issue_comment:created:${c.id}`),
  `pull_request_review_comment:edited:${run.snapshots[0].comments[1].id}`,
]
const report = {
  runID: run.runID,
  pr: run.pr,
  checkedAt: new Date().toISOString(),
  pages: [],
  deliveries: [],
  expected,
  missing: [...expected],
  fullWindowScanned: false,
  mutations: 0,
}
const save = () =>
  writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
const shape = (v) => ({
  id: v.id,
  reviewID: v.pull_request_review_id,
  replyTo: v.in_reply_to_id,
  author: v.user?.login,
  authorID: v.user?.id,
  authorType: v.user?.type,
  body: v.body,
  state: v.state,
  createdAt: v.created_at,
  updatedAt: v.updated_at,
  submittedAt: v.submitted_at,
  path: v.path,
  commitID: v.commit_id,
})
let path = "/app/hook/deliveries?per_page=100"
const seen = new Set()
try {
  for (let pageNumber = 0; path && pageNumber < 100; pageNumber++) {
    assert(!seen.has(path), "Repeated delivery cursor")
    seen.add(path)
    const page = await get(path)
    const candidates = page.value.filter(
      (s) =>
        s.repository_id === 1323166030 &&
        s.installation_id === 158746421 &&
        Date.parse(s.delivered_at) >= Date.parse(run.startedAt) - 5000 &&
        ["issue_comment", "pull_request_review", "pull_request_review_comment"].includes(s.event),
    )
    report.pages.push({
      candidateIDs: candidates.map((s) => s.id),
      count: page.value.length,
      candidateCount: candidates.length,
      hasNext: Boolean(page.next),
    })
    for (const summary of candidates) {
      if (report.deliveries.some((d) => d.attemptID === summary.id)) continue
      const { value: detail } = await get(`/app/hook/deliveries/${summary.id}`)
      const payload = detail.request?.payload
      if (
        payload?.repository?.id !== 1323166030 ||
        (payload.pull_request?.number ?? payload.issue?.number) !== run.pr.number
      )
        continue
      report.deliveries.push({
        attemptID: summary.id,
        guid: summary.guid,
        event: summary.event,
        action: payload.action,
        statusCode: summary.status_code,
        redelivery: summary.redelivery,
        deliveredAt: summary.delivered_at,
        contribution: shape(payload.comment ?? payload.review ?? {}),
      })
    }
    report.missing = expected.filter(
      (key) =>
        !report.deliveries.some((d) => `${d.event}:${d.action}:${d.contribution.id}` === key),
    )
    path = page.next
    report.fullWindowScanned = !path
    save()
    if (!report.missing.length) break
  }
  if (report.missing.length) {
    report.incomplete = true
    process.exitCode = 1
  }
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  save()
  console.log(
    JSON.stringify(
      {
        pages: report.pages.length,
        pageSamples: report.pages.slice(0, 3),
        captured: report.deliveries.length,
        missing: report.missing,
        failure: report.failure,
        fullWindowScanned: report.fullWindowScanned,
      },
      null,
      2,
    ),
  )
}
