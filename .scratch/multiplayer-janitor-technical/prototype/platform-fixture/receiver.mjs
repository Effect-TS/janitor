import { DurableObject } from "cloudflare:workers"

const encoder = new TextEncoder()
async function validSignature(raw, timestamp, signature, secret) {
  if (
    !secret ||
    !/^\d+$/.test(timestamp ?? "") ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !/^v0=[a-f0-9]{64}$/.test(signature ?? "")
  )
    return false
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  const bytes = Uint8Array.from(signature.slice(3).match(/../g), (hex) => parseInt(hex, 16))
  const prefix = encoder.encode(`v0:${timestamp}:`)
  const message = new Uint8Array(prefix.length + raw.length)
  message.set(prefix)
  message.set(raw, prefix.length)
  return crypto.subtle.verify("HMAC", key, bytes, message)
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (!env.SLACK_SIGNING_SECRET || !env.FIXTURE_CONTROL_TOKEN)
      return new Response("Fixture secrets missing", { status: 503 })
    if (!["/slack/events", "/evidence", "/events", "/faults"].includes(path))
      return new Response("Not found", { status: 404 })
    if (
      path !== "/slack/events" &&
      request.headers.get("authorization") !== `Bearer ${env.FIXTURE_CONTROL_TOKEN}`
    )
      return new Response("Unauthorized", { status: 401 })
    return env.JOURNAL.getByName("slack-delivery-fixture").fetch(request)
  },
}
export class Journal extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS receipt(id TEXT PRIMARY KEY, payload TEXT NOT NULL, hash TEXT NOT NULL, received_at TEXT NOT NULL)",
    )
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS attempt(seq INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id TEXT NOT NULL, retry_number TEXT, disposition TEXT NOT NULL)",
    )
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS fault(id INTEGER PRIMARY KEY, before_count INTEGER NOT NULL, after_count INTEGER NOT NULL)",
    )
    this.sql.exec("INSERT OR IGNORE INTO fault VALUES(1,0,0)")
  }
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/slack/events") {
      if (request.headers.get("authorization") !== `Bearer ${this.env.FIXTURE_CONTROL_TOKEN}`)
        return new Response("Unauthorized", { status: 401 })
      if (url.pathname === "/evidence" && request.method === "GET")
        return Response.json({
          receipts: this.sql
            .exec("SELECT id, hash, received_at FROM receipt ORDER BY rowid")
            .toArray(),
          attempts: this.sql.exec("SELECT * FROM attempt ORDER BY seq").toArray(),
        })
      if (url.pathname === "/events" && request.method === "GET") {
        const after = Number(url.searchParams.get("after") ?? 0)
        if (!Number.isSafeInteger(after) || after < 0)
          return new Response("Invalid cursor", { status: 400 })
        return Response.json(
          this.sql
            .exec(
              "SELECT rowid AS cursor, id, payload FROM receipt WHERE rowid > ? ORDER BY rowid LIMIT 100",
              after,
            )
            .toArray(),
        )
      }
      if (url.pathname === "/faults" && request.method === "POST") {
        const value = await request.json()
        if (![value.before, value.after].every((n) => Number.isInteger(n) && n >= 0 && n <= 3))
          return new Response("Invalid fault budget", { status: 400 })
        this.sql.exec(
          "UPDATE fault SET before_count=?, after_count=? WHERE id=1",
          value.before,
          value.after,
        )
        return Response.json({ configured: true })
      }
      return new Response("Method not allowed", { status: 405 })
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    const raw = new Uint8Array(await request.arrayBuffer())
    if (raw.length > 262144) return new Response("Fixture payload limit", { status: 413 })
    if (
      !(await validSignature(
        raw,
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
        this.env.SLACK_SIGNING_SECRET,
      ))
    )
      return new Response("Invalid signature", { status: 401 })
    let body
    try {
      body = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return new Response("Invalid JSON", { status: 400 })
    }
    if (body.type === "url_verification" && typeof body.challenge === "string")
      return Response.json({ challenge: body.challenge })
    if (body.team_id !== this.env.SLACK_TEAM_ID || body.api_app_id !== this.env.SLACK_APP_ID)
      return new Response("Outside fixture app/workspace", { status: 403 })
    if (body.type !== "event_callback" || typeof body.event_id !== "string" || !body.event)
      return new Response("Invalid event", { status: 400 })
    const channel = body.event.channel ?? body.event.item?.channel
    if (
      channel !== this.env.SLACK_CHANNEL_ID &&
      !["app_uninstalled", "tokens_revoked"].includes(body.event.type)
    )
      return new Response("Ignored outside test channel")
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const status = this.ctx.storage.transactionSync(() => {
      const fault = this.sql.exec("SELECT * FROM fault WHERE id=1").one()
      const disposition =
        fault.before_count > 0
          ? "failed-before-commit"
          : fault.after_count > 0
            ? "failed-after-commit"
            : "acknowledged"
      if (fault.before_count > 0)
        this.sql.exec("UPDATE fault SET before_count=before_count-1 WHERE id=1")
      else {
        this.sql.exec(
          "INSERT OR IGNORE INTO receipt VALUES(?,?,?,?)",
          body.event_id,
          JSON.stringify(body),
          digest,
          new Date().toISOString(),
        )
        if (fault.after_count > 0)
          this.sql.exec("UPDATE fault SET after_count=after_count-1 WHERE id=1")
      }
      this.sql.exec(
        "INSERT INTO attempt(receipt_id,retry_number,disposition) VALUES(?,?,?)",
        body.event_id,
        request.headers.get("x-slack-retry-num"),
        disposition,
      )
      return disposition === "acknowledged" ? 200 : 503
    })
    return new Response(status === 200 ? "Accepted" : "Injected fixture failure", { status })
  }
}
