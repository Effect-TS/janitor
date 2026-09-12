import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { AdmissionLedger, historyBoundary } from "./contract.mjs"

// Read-only remote checks plus local replay. No platform messages or membership changes.
const env = parseEnv(readFileSync(process.env.FIXTURE_SLACK_ENV_FILE, "utf8"))
const root = "1789218813.600349",
  initiating = "1789218823.819509",
  followup = "1789218845.026139"
const wanted = new Set([root, initiating, followup])
const events = []
let after = 0
for (let pageNumber = 0; ; pageNumber++) {
  assert(pageNumber < 100, "Fixture export exceeded bounded page count")
  const response = await fetch(
    `https://janitor-platform-delivery-fixture.matechs.workers.dev/events?after=${after}`,
    {
      headers: { authorization: `Bearer ${env.FIXTURE_CONTROL_TOKEN}` },
      signal: AbortSignal.timeout(30000),
    },
  )
  assert.equal(response.status, 200)
  const rows = await response.json()
  for (const row of rows) {
    const body = JSON.parse(row.payload)
    if (
      wanted.has(body.event?.ts) &&
      !body.event.subtype &&
      ["message", "app_mention"].includes(body.event.type)
    )
      events.push(body)
  }
  if (rows.length < 100) break
  after = rows.at(-1).cursor
}
const pair = events.filter((e) => e.event.ts === initiating)
assert.deepEqual(pair.map((e) => e.event.type).sort(), ["app_mention", "message"])
assert.notEqual(pair[0].event_id, pair[1].event_id)
assert.equal(pair[0].event.text, pair[1].event.text)
const next = events.filter((e) => e.event.ts === followup)
assert.equal(next.length, 1)
assert.equal(next[0].event.type, "message")
assert(!next[0].event.text.includes("<@U0C0YCF3B1D>"))
const route = { team: pair[0].team_id, channel: env.SLACK_CHANNEL_ID, thread: root, private: true }
const replay = []
for (const ordering of [pair, [...pair].reverse()]) {
  const ledger = new AdmissionLedger()
  try {
    // Synthetic eligibility only. Actual Janitor account linking has not been implemented.
    ledger.member(pair[0].event.user, true)
    const a = ledger.admitSlack(ordering[0], route),
      duplicate = ledger.admitSlack(ordering[1], route),
      b = ledger.admitSlack(next[0], route)
    assert.equal(a.outcome, "accepted")
    assert.equal(duplicate.accepted_seq, a.accepted_seq)
    assert.equal(b.accepted_seq, 2)
    assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM decision").get().n, 2)
    replay.push({ firstType: ordering[0].event.type, instructionCount: 2, receiptCount: 3 })
  } finally {
    ledger.close()
  }
}
const pages = [],
  messages = [],
  cursors = new Set()
let cursor
for (let pageNumber = 0; ; pageNumber++) {
  assert(pageNumber < 20, "Fixture history exceeded bounded page count")
  const url = new URL("https://slack.com/api/conversations.replies")
  for (const [key, value] of Object.entries({
    channel: env.SLACK_CHANNEL_ID,
    ts: root,
    latest: initiating,
    inclusive: true,
    limit: 1,
    ...(cursor ? { cursor } : {}),
  }))
    url.searchParams.set(key, String(value))
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  })
  const body = await response.json()
  assert(response.ok && body.ok, body.error ?? `HTTP ${response.status}`)
  pages.push({
    timestamps: body.messages.map((m) => m.ts),
    hasNextCursor: Boolean(body.response_metadata?.next_cursor),
  })
  messages.push(...body.messages.map((m) => ({ ...m, channel: env.SLACK_CHANNEL_ID })))
  cursor = body.response_metadata?.next_cursor || undefined
  if (!cursor) break
  assert(!cursors.has(cursor), "Repeated history cursor")
  cursors.add(cursor)
}
const context = historyBoundary(messages, { ...route, initiator: initiating })
assert.deepEqual(
  context.map((m) => m.ts),
  [root, initiating],
)
assert(!messages.some((m) => m.ts === followup), "Slack returned a post-boundary message")
const report = {
  checkedAt: new Date().toISOString(),
  root,
  initiating,
  followup,
  captured: events.map((e) => ({
    eventID: e.event_id,
    type: e.event.type,
    timestamp: e.event.ts,
    thread: e.event.thread_ts ?? e.event.ts,
  })),
  liveChecks: [
    "One human mention produced two distinct envelopes with one source message identity",
    "Unmentioned human follow-up arrived as message event",
    "History through initiating timestamp includes root and initiating message, excludes later reply",
  ],
  localReplay: replay,
  historyPages: pages,
  contextTimestamps: context.map((m) => m.ts),
  remoteMutations: 0,
  limitation:
    "Eligibility is synthetic; no production Janitor admission, session creation, or agent execution is exercised. Initiating message is context boundary and one input, not two prompts.",
}
writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
