import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
if (process.env.FIXTURE_ALLOW_POSTS !== "janitor-test")
  throw new Error("Requires explicit authorization and FIXTURE_ALLOW_POSTS=janitor-test")
if (!process.env.FIXTURE_REPORT_PATH) throw new Error("A report path is required before publishing")
const env = parseEnv(readFileSync(process.env.FIXTURE_SLACK_ENV_FILE, "utf8"))
const report = {
  runID: randomUUID(),
  checks: [],
  messages: [],
  cleanup: [],
  uncertain: [],
  pages: [],
}
const save = () =>
  writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  })
let lastWrite = 0
async function api(method, body, mutation = false) {
  if (mutation) {
    await delay(Math.max(0, lastWrite + 1100 - Date.now()))
    lastWrite = Date.now()
  }
  const url = new URL(`https://slack.com/api/${method}`)
  if (!mutation)
    for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value))
  const response = await fetch(url, {
    method: mutation ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: mutation ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const value = await response.json()
  if (!response.ok || !value.ok)
    throw new Error(`${method}: HTTP ${response.status}, ${value.error ?? "unknown"}`)
  return value
}
async function post(part, thread) {
  const operation = `${report.runID}:${part}`
  // Save intent before sending; never automatically retry a failed publication.
  report.uncertain.push(operation)
  save()
  const value = await api(
    "chat.postMessage",
    {
      channel: env.SLACK_CHANNEL_ID,
      text: `Janitor disposable delivery check ${part}. Run ${report.runID}`,
      ...(thread ? { thread_ts: thread } : {}),
      metadata: { event_type: "janitor_fixture", event_payload: { operation } },
      unfurl_links: false,
      unfurl_media: false,
    },
    true,
  )
  report.messages.push({ ts: value.ts, operation })
  report.uncertain = report.uncertain.filter((id) => id !== operation)
  save()
  return value.ts
}
try {
  const auth = await api("auth.test", {})
  assert.equal(new URL(auth.url).hostname, "effectfulworkspace.slack.com")
  const { channel } = await api("conversations.info", { channel: env.SLACK_CHANNEL_ID })
  assert.equal(channel.id, "C0C19USKLPQ")
  assert.equal(channel.name, "janitor-test")
  assert(channel.is_private && channel.is_member && !channel.is_archived)
  save()
  const root = await post("root")
  const progress = await post("progress", root)
  await post("reply", root)
  await post("final", root)
  const messages = [],
    cursors = new Set()
  let cursor
  do {
    const page = await api("conversations.replies", {
      channel: channel.id,
      ts: root,
      limit: 2,
      include_all_metadata: true,
      ...(cursor ? { cursor } : {}),
    })
    report.pages.push({
      timestamps: page.messages.map((m) => m.ts),
      hasNextCursor: Boolean(page.response_metadata?.next_cursor),
    })
    save()
    for (const message of page.messages) {
      const existing = messages.find((m) => m.ts === message.ts)
      if (existing) {
        assert.equal(
          existing.metadata?.event_payload?.operation,
          message.metadata?.event_payload?.operation,
          "Metadata changed across pages",
        )
      } else messages.push(message)
    }
    cursor = page.response_metadata?.next_cursor || undefined
    if (cursor) {
      assert(!cursors.has(cursor), "Repeated pagination cursor")
      cursors.add(cursor)
    }
  } while (cursor)
  assert(cursors.size >= 1, "Did not exercise actual pagination")
  for (const published of report.messages) {
    const matches = messages.filter(
      (m) =>
        m.user === auth.user_id &&
        m.metadata?.event_payload?.operation === published.operation &&
        (m.thread_ts ?? m.ts) === root,
    )
    assert.equal(matches.length, 1)
    assert.equal(matches[0].ts, published.ts)
  }
  report.checks.push("private-thread bot pagination and unique metadata readback")
  // Simulate discarding a successful send's return value. Cleanup still tracks it independently.
  const marker = report.messages[2].operation
  assert.equal(
    messages.find((m) => m.metadata?.event_payload?.operation === marker).ts,
    report.messages[2].ts,
  )
  report.checks.push("positive lookup after locally simulated response loss")
  await api(
    "chat.update",
    {
      channel: channel.id,
      ts: progress,
      text: `Janitor disposable progress updated. Run ${report.runID}`,
    },
    true,
  )
  report.checks.push("progress message update")
  save()
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  for (const message of [...report.messages].reverse()) {
    try {
      await api("chat.delete", { channel: env.SLACK_CHANNEL_ID, ts: message.ts }, true)
      report.cleanup.push({ ts: message.ts, deleted: true })
    } catch (error) {
      report.cleanup.push({ ts: message.ts, deleted: false, error: error.message })
      process.exitCode = 1
    }
    save()
  }
  save()
  console.log(JSON.stringify(report, null, 2))
}
