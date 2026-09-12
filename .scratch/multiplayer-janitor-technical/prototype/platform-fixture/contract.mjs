import { createHmac, timingSafeEqual } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

export function verifySlack(raw, timestamp, supplied, secret, nowSeconds) {
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300) return false
  return secureEqual(
    "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw).digest("hex"),
    supplied,
  )
}
export function verifyGitHub(raw, supplied, secret) {
  return secureEqual("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"), supplied)
}
function secureEqual(expected, actual) {
  if (typeof actual !== "string") return false
  const a = Buffer.from(expected),
    b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}
export function slackTime(ts) {
  if (!/^\d+\.\d{6}$/.test(ts)) throw new Error("invalid Slack timestamp")
  const [s, us] = ts.split(".")
  return BigInt(s) * 1000000n + BigInt(us)
}
export function historyBoundary(messages, { team, channel, thread, initiator }) {
  const unique = new Map()
  for (const m of messages) {
    if (m.channel !== channel || (m.thread_ts ?? m.ts) !== thread) continue
    if (slackTime(m.ts) > slackTime(initiator)) continue
    unique.set(`${team}:${channel}:${m.ts}`, m)
  }
  return [...unique.values()].sort((a, b) =>
    slackTime(a.ts) < slackTime(b.ts) ? -1 : slackTime(a.ts) > slackTime(b.ts) ? 1 : 0,
  )
}
export class AdmissionLedger {
  constructor() {
    this.db = new DatabaseSync(":memory:")
    this.db.exec(`CREATE TABLE member(id TEXT PRIMARY KEY, active INTEGER NOT NULL);
      CREATE TABLE decision(identity TEXT PRIMARY KEY, outcome TEXT NOT NULL, payload TEXT NOT NULL, accepted_seq INTEGER);
      CREATE TABLE counter(id INTEGER PRIMARY KEY, seq INTEGER NOT NULL); INSERT INTO counter VALUES(1,0);
      CREATE TABLE receipt(id TEXT PRIMARY KEY, identity TEXT NOT NULL);`)
  }
  member(id, active) {
    this.db
      .prepare(
        "INSERT INTO member VALUES (?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active",
      )
      .run(id, Number(active))
  }
  admitSlack(envelope, route) {
    const e = envelope.event
    const identity = `${envelope.team_id}:${e.channel}:${e.ts}`
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const receipt = this.db.prepare("SELECT * FROM receipt WHERE id=?").get(envelope.event_id)
      if (receipt && receipt.identity !== identity) throw new Error("receipt identity conflict")
      const existing = this.db.prepare("SELECT * FROM decision WHERE identity=?").get(identity)
      if (existing) {
        this.db
          .prepare("INSERT OR IGNORE INTO receipt VALUES(?,?)")
          .run(envelope.event_id, identity)
        this.db.exec("COMMIT")
        return existing
      }
      const member = this.db.prepare("SELECT active FROM member WHERE id=?").get(e.user)
      const reason =
        envelope.team_id !== route.team || e.channel !== route.channel
          ? "unrelated-conversation"
          : route.private !== true
            ? "public-channel"
            : e.bot_id || e.app_id || e.subtype
              ? "non-original-human-message"
              : !member?.active
                ? "unauthorized"
                : (e.thread_ts ?? e.ts) !== route.thread
                  ? "unrelated-thread"
                  : null
      const outcome = reason ?? "accepted"
      let seq = null
      if (!reason) {
        this.db.exec("UPDATE counter SET seq=seq+1 WHERE id=1")
        seq = this.db.prepare("SELECT seq FROM counter WHERE id=1").get().seq
      }
      this.db
        .prepare("INSERT INTO decision VALUES(?,?,?,?)")
        .run(identity, outcome, JSON.stringify(e), seq)
      this.db.prepare("INSERT INTO receipt VALUES(?,?)").run(envelope.event_id, identity)
      this.db.exec("COMMIT")
      return this.db.prepare("SELECT * FROM decision WHERE identity=?").get(identity)
    } catch (e) {
      this.db.exec("ROLLBACK")
      throw e
    }
  }
  close() {
    this.db.close()
  }
}
// Negative lookups never prove an ambiguous remote publication failed.
export function reconcilePost({ state, matches }) {
  if (state === "known-rejected") return { action: "retry-safe" }
  if (matches.length === 1) return { action: "confirmed", remoteID: matches[0].id }
  if (matches.length > 1) return { action: "blocked", reason: "duplicate-marker" }
  return { action: "blocked", reason: "unresolved-publication" }
}
export function outputPlan(outputs) {
  const latestProgress = new Map(),
    retained = [],
    terminalTurns = new Set()
  for (const output of outputs) {
    if (output.kind === "progress") {
      if (!terminalTurns.has(output.turn)) latestProgress.set(output.turn, output)
    } else {
      retained.push(output)
      if (output.kind === "terminal") {
        latestProgress.delete(output.turn)
        terminalTurns.add(output.turn)
      }
    }
  }
  return [...latestProgress.values(), ...retained].sort((a, b) => a.seq - b.seq)
}

// Mutation receipts are observed, but never occupy an original message's admission key.
export function slackInstruction(envelope) {
  const e = envelope.event
  if (!e || !["message", "app_mention"].includes(e.type) || e.subtype || e.bot_id || e.app_id)
    return undefined
  if (typeof e.user !== "string" || typeof e.ts !== "string" || typeof e.channel !== "string")
    return undefined
  return envelope
}
