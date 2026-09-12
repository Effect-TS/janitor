import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { reconcilePost, historyBoundary, AdmissionLedger } from "./contract.mjs"
const env = parseEnv(readFileSync(process.env.FIXTURE_SLACK_ENV_FILE, "utf8"))
const report = {
  runID: randomUUID(),
  checks: [],
  messages: [],
  cleanup: [],
  ephemeral: [],
  uncertain: [],
}
const save = () =>
  writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  })
let last = 0
async function api(method, body = {}, write = false) {
  if (write) {
    await delay(Math.max(0, last + 1100 - Date.now()))
    last = Date.now()
  }
  const url = new URL("https://slack.com/api/" + method)
  if (!write) for (const [k, v] of Object.entries(body)) url.searchParams.set(k, String(v))
  const r = await fetch(url, {
    method: write ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: write ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const v = await r.json()
  assert(r.ok && v.ok, v.error ?? String(r.status))
  return v
}
async function post(part, thread) {
  report.uncertain.push(part)
  save()
  const v = await api(
    "chat.postMessage",
    {
      channel: env.SLACK_CHANNEL_ID,
      text: `Remaining delivery fixture ${part} ${report.runID}`,
      ...(thread ? { thread_ts: thread } : {}),
      metadata: {
        event_type: "janitor_fixture",
        event_payload: { operation: report.runID + ":" + part },
      },
    },
    true,
  )
  report.messages.push(v.ts)
  report.uncertain = report.uncertain.filter((p) => p !== part)
  save()
  return v.ts
}
async function history(root) {
  const all = [],
    seen = new Set()
  let cursor
  do {
    const p = await api("conversations.replies", {
      channel: env.SLACK_CHANNEL_ID,
      ts: root,
      limit: 2,
      include_all_metadata: true,
      ...(cursor ? { cursor } : {}),
    })
    all.push(...p.messages)
    cursor = p.response_metadata?.next_cursor
    if (cursor) {
      assert(!seen.has(cursor))
      seen.add(cursor)
    }
  } while (cursor)
  return [...new Map(all.map((m) => [m.ts, m])).values()]
}
try {
  const info = await api("conversations.info", { channel: env.SLACK_CHANNEL_ID })
  assert(info.channel.is_private && info.channel.is_member)
  assert.equal(info.channel.name, "janitor-test")
  const root = await post("root"),
    target = await post("deleted-reply", root),
    other = await post("unrelated-root")
  const initial = await history(root)
  assert(initial.some((m) => m.ts === target))
  assert(!initial.some((m) => m.ts === other))
  report.checks.push("Actual private-thread history excludes another root")
  await api("chat.delete", { channel: env.SLACK_CHANNEL_ID, ts: target }, true)
  report.cleanup.push(target)
  save()
  const after = await history(root)
  const matches = after.filter(
    (m) => m.metadata?.event_payload?.operation === report.runID + ":deleted-reply",
  )
  assert.equal(matches.length, 0)
  assert.equal(reconcilePost({ state: "uncertain", matches }).action, "blocked")
  report.checks.push("Deleted Slack marker has no match; local policy blocks automatic repost")
  const ep = await api(
    "chat.postEphemeral",
    {
      channel: env.SLACK_CHANNEL_ID,
      user: "U080M0Q2JLF",
      thread_ts: "1789218813.600349",
      text: "Janitor delivery verification: private onboarding test. No action needed.",
    },
    true,
  )
  report.ephemeral.push({
    ok: ep.ok,
    messageTS: ep.message_ts,
    humanVisibility: "unverified; API success is not receipt",
  })
  save()
  const durable = await history("1789218813.600349")
  assert(!durable.some((m) => m.ts === ep.message_ts))
  report.checks.push(
    "Ephemeral API accepted private test; it is absent from retained thread history",
  )
  const boundary = "1789218823.819509"
  const later = durable.filter((m) => m.ts === "1789218845.026139")
  assert.equal(later.length, 1)
  const ledger = new AdmissionLedger()
  try {
    ledger.member(later[0].user, true)
    const m = later[0],
      envelope = {
        team_id: "T05479Z6JBW",
        event_id: "recovery:" + m.ts,
        event: { ...m, channel: env.SLACK_CHANNEL_ID },
      }
    const route = {
      team: "T05479Z6JBW",
      channel: env.SLACK_CHANNEL_ID,
      thread: "1789218813.600349",
      private: true,
    }
    assert.equal(ledger.admitSlack(envelope, route).accepted_seq, 1)
    ledger.member(m.user, false)
    assert.equal(
      ledger.admitSlack({ ...envelope, event_id: "second-scan:" + m.ts }, route).accepted_seq,
      1,
    )
    const context = historyBoundary(
      durable.map((m) => ({ ...m, channel: env.SLACK_CHANNEL_ID })),
      { ...route, initiator: boundary },
    )
    assert(!context.some((m) => m.ts === m.ts && m.ts === "1789218845.026139"))
    report.checks.push(
      "Retained real human reply can backfill a locally omitted input once; context boundary and prior admission preserved",
    )
  } finally {
    ledger.close()
  }
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  for (const ts of [...report.messages].reverse()) {
    if (report.cleanup.includes(ts)) continue
    try {
      await api("chat.delete", { channel: env.SLACK_CHANNEL_ID, ts }, true)
      report.cleanup.push(ts)
    } catch (error) {
      report.cleanup.push({ ts, error: error.message })
      process.exitCode = 1
    }
    save()
  }
  save()
  console.log(JSON.stringify(report, null, 2))
}
