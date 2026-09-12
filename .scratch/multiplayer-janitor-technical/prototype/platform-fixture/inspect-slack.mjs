import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"

const env = parseEnv(readFileSync(process.env.FIXTURE_SLACK_ENV_FILE, "utf8"))
const report = {
  checkedAt: new Date().toISOString(),
  mode: "read-only",
  appID: env.SLACK_APP_ID,
  checks: [],
  mutations: 0,
}
async function api(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  })
  const body = await response.json()
  report.checks.push({
    method,
    status: response.status,
    ok: body.ok === true,
    error: body.ok ? undefined : body.error,
    scopes: response.headers.get("x-oauth-scopes"),
  })
  if (!response.ok || !body.ok)
    throw new Error(`${method} failed: HTTP ${response.status}, ${body.error ?? "unknown"}`)
  return body
}
try {
  const auth = await api("auth.test")
  report.identity = {
    teamID: auth.team_id,
    botID: auth.bot_id,
    userID: auth.user_id,
    workspaceURL: auth.url,
  }
  if (new URL(auth.url).hostname !== env.SLACK_WORKSPACE_DOMAIN)
    throw new Error("Workspace mismatch")
  const info = await api("conversations.info", { channel: env.SLACK_CHANNEL_ID })
  report.channel = {
    id: info.channel.id,
    name: info.channel.name,
    private: info.channel.is_private,
    member: info.channel.is_member,
    archived: info.channel.is_archived,
  }
  if (
    info.channel.name !== env.SLACK_CHANNEL_NAME ||
    !info.channel.is_private ||
    !info.channel.is_member ||
    info.channel.is_archived
  )
    throw new Error("Test channel name, privacy, membership, or archived-state mismatch")
  const history = await api("conversations.history", {
    channel: env.SLACK_CHANNEL_ID,
    limit: 2,
    include_all_metadata: true,
  })
  report.history = {
    count: history.messages.length,
    hasMore: history.has_more === true,
    hasCursor: Boolean(history.response_metadata?.next_cursor),
    limited: history.is_limited === true,
  }
  const root = history.messages.find(
    (message) => !message.subtype && (!message.thread_ts || message.thread_ts === message.ts),
  )
  if (root) {
    const replies = await api("conversations.replies", {
      channel: env.SLACK_CHANNEL_ID,
      ts: root.ts,
      limit: 2,
      include_all_metadata: true,
    })
    report.replies = {
      count: replies.messages.length,
      hasMore: replies.has_more === true,
      hasCursor: Boolean(replies.response_metadata?.next_cursor),
    }
  } else report.replies = { skipped: "No ordinary root message in the bounded history sample" }
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  // Do not retain message bodies, author identities, raw responses, or tokens.
  const serialized = JSON.stringify(report, null, 2) + "\n"
  if (process.env.FIXTURE_REPORT_PATH) writeFileSync(process.env.FIXTURE_REPORT_PATH, serialized)
  console.log(serialized)
}
