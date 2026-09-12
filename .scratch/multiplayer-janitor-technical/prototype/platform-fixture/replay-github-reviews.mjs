import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
const run = JSON.parse(readFileSync(process.env.FIXTURE_RUN_PATH, "utf8"))
const capture = JSON.parse(readFileSync(process.env.FIXTURE_CAPTURE_PATH, "utf8"))
assert.equal(capture.runID, run.runID)
assert.equal(capture.missing.length, 0)
const reviews = new Map(run.allReviews.map((r) => [r.id, r]))
const batch = run.reviews[0].id
function snapshot(reviewID) {
  // This local replay uses known fixture snapshots, not a historical API guarantee.
  if (reviewID === batch) return structuredClone(run.snapshots[0].comments)
  return structuredClone(run.allComments.filter((c) => c.reviewID === reviewID))
}
function replay(events) {
  const inputs = new Map(),
    covered = new Map(),
    receipts = new Set(),
    decisions = new Map()
  for (const event of events) {
    if (receipts.has(event.guid)) continue
    receipts.add(event.guid)
    const c = event.contribution
    if (event.event === "issue_comment") {
      if (event.action !== "created" || c.authorType === "Bot" || !/@effect-janitor\b/.test(c.body))
        continue
      inputs.set(`comment:${c.id}`, { body: c.body, comments: [] })
      continue
    }
    if (
      !(
        (event.event === "pull_request_review" && event.action === "submitted") ||
        (event.event === "pull_request_review_comment" && event.action === "created")
      )
    )
      continue
    const reviewID = event.event === "pull_request_review" ? c.id : c.reviewID
    assert(reviewID, "Unclassified contribution must stay pending, not disappear")
    if (decisions.has(reviewID)) continue
    const review = reviews.get(reviewID)
    assert(
      review?.submittedAt,
      "Hydration missing or pending; production must retain pending classification",
    )
    if (review.authorType === "Bot") {
      decisions.set(reviewID, "bot")
      continue
    }
    const comments = snapshot(reviewID)
    if (!review.body.trim() && !comments.length) {
      decisions.set(reviewID, "empty")
      continue
    }
    const key = `review:${reviewID}`
    for (const comment of comments) {
      assert(!covered.has(comment.id), "Comment assigned to two instructions")
      covered.set(comment.id, key)
    }
    inputs.set(key, { body: review.body, comments })
    decisions.set(reviewID, "accepted")
  }
  return { inputs, covered }
}
const original = capture.deliveries
const ordered = (first) => [...original.filter(first), ...original.filter((e) => !first(e))]
const scenarios = [
  ["capture-order", original],
  ["reverse-order", [...original].reverse()],
  ["reviews-first", ordered((e) => e.event === "pull_request_review")],
  ["inline-first", ordered((e) => e.event === "pull_request_review_comment")],
  ["duplicate-deliveries", [...original, ...original]],
  [
    "submission-hydration-without-inline-events",
    original.filter((e) => e.event !== "pull_request_review_comment"),
  ],
]
const expected = [
  ...run.allReviews
    .filter((r) => r.authorType !== "Bot" && (r.body.trim() || snapshot(r.id).length))
    .map((r) => `review:${r.id}`),
  ...run.comments
    .filter((c) => !c.reviewID && c.authorType !== "Bot")
    .map((c) => `comment:${c.id}`),
].sort()
assert.equal(expected.length, 5)
const results = scenarios.map(([name, events]) => {
  const result = replay(events)
  assert.deepEqual([...result.inputs.keys()].sort(), expected)
  assert.equal(result.covered.size, 4)
  assert.equal(
    result.inputs.get(`review:${batch}`).comments[1].body,
    "Fixture batch second inline comment",
  )
  return {
    name,
    instructionCount: result.inputs.size,
    humanInlineCommentsCovered: result.covered.size,
  }
})
const partial = replay(original.filter((e) => e.event !== "pull_request_review"))
assert.equal(partial.inputs.size, 4)
results.push({
  name: "inline-hydration-without-submission-events",
  instructionCount: 4,
  limitation: "Body-only review has no inline event and still needs its own delivery recovery",
})
const report = {
  runID: run.runID,
  results,
  expectedInstructions: expected,
  remoteCalls: 0,
  limitation:
    "Candidate classifier tested against REST-created fixture relationships and known first snapshots. Actual membership authorization, pending-review UI replies, missing/inconsistent hydration, historical completeness, and production transactionality remain unverified.",
}
writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
