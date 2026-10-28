import * as Cloudflare from "alchemy/Cloudflare"
import { MemoryRateLimitStoreLive } from "dfx"
import * as DiscordConfig from "dfx/DiscordConfig"
import { JsonDiscordWSCodecLive } from "dfx/DiscordGateway/DiscordWS"
import { Shard, ShardLive } from "dfx/DiscordGateway/Shard"
import { type ShardState, ShardStateStore } from "dfx/DiscordGateway/Shard/StateStore"
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Socket from "effect/socket/Socket"

/**
 * The Discord gateway Durable Object (EFF-3020): one instance, named
 * `GATEWAY_NAME`, holding the bot's gateway socket with dfx's shard. The
 * shard's session (`session_id`, `resume_gateway_url`, sequence) lives in
 * this object's storage through `ShardStateStore`, so a rebuilt instance
 * RESUMEs instead of identifying again. A 60-second self-rescheduling alarm
 * wakes the object after an eviction and restarts a shard that died or went
 * quiet.
 *
 * This is the spike build. Every instance records how it came to exist, and
 * dfx's trace log is folded into counters and events in storage, so 24 hours
 * of evictions, RESUMEs and IDENTIFYs can be read back through `stats`.
 * Nothing here posts to Discord or reaches a chat session yet.
 */

export const GATEWAY_NAME = "gateway"

/** `GUILDS`, `GUILD_MESSAGES` and `MESSAGE_CONTENT`. */
export const DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 15)

/** How long without any payload before the alarm treats the socket as dead. */
const STALE_AFTER_MS = 3 * 60_000
const ALARM_EVERY_MS = 60_000

export interface GatewayEvent {
  readonly id: number
  readonly at: number
  readonly instance: string
  readonly kind: string
  readonly detail: unknown
}

export interface GatewayStats {
  readonly instance: string
  readonly instanceStartedAt: number
  readonly enabled: boolean
  readonly phase: number | null
  readonly lastSeenAt: number | null
  readonly now: number
  readonly firstEventAt: number | null
  readonly counters: Record<string, number>
  readonly eventsByKind: Record<string, number>
  /** Every restart: how long the previous instance had lived and how long the socket was dark. */
  readonly restarts: ReadonlyArray<{
    readonly at: number
    readonly uptimeMs: number
    readonly gapMs: number
    readonly phase: number | null
  }>
  readonly recent: ReadonlyArray<GatewayEvent>
}

export interface ChatDiscordGatewayShape {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  /** Clears every event and counter; refused while the gateway is on. */
  readonly reset: () => Effect.Effect<boolean>
  readonly stats: () => Effect.Effect<GatewayStats>
  readonly events: (input: {
    readonly after: number
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<GatewayEvent>>
}

export class ChatDiscordGateway extends Cloudflare.DurableObject<
  ChatDiscordGateway,
  ChatDiscordGatewayShape
>()("ChatDiscordGateway") {}

/** The spike's settings; the token is the dev Discord app's. */
export const discordGatewayConfig = Config.all({
  token: Config.Redacted("DISCORD_BOT_TOKEN"),
  intents: Config.Int("DISCORD_GATEWAY_INTENTS").pipe(Config.withDefault(DEFAULT_INTENTS)),
})

/** The part of the Durable Object's storage the gateway uses. SQL is synchronous. */
interface GatewayStorage {
  readonly sql: {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: Array<unknown>
    ): { toArray(): Array<T> }
  }
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

interface LiveMarker {
  readonly instance: string
  readonly since: number
  readonly lastSeen: number
  readonly phase: number | null
}

const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const

export const ChatDiscordGatewayLive = ChatDiscordGateway.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      const storage = state.raw.storage as unknown as GatewayStorage
      const sql = storage.sql
      sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      sql.exec(
        `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, instance TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`,
      )
      sql.exec(
        `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
      )

      const kvGet = (key: string): string | undefined =>
        sql.exec<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, key).toArray()[0]?.value
      const kvSet = (key: string, value: string) => {
        sql.exec(
          `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key,
          value,
        )
      }
      const kvDelete = (key: string) => {
        sql.exec(`DELETE FROM kv WHERE key = ?`, key)
      }
      const bump = (name: string) => {
        sql.exec(
          `INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1`,
          name,
        )
      }

      // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
      const instance = crypto.randomUUID().slice(0, 8)
      const instanceStartedAt = Date.now()
      let phase: number | null = null
      let lastSeenAt: number | null = null

      const record = (kind: string, detail: unknown = {}) => {
        const at = Date.now()
        sql.exec(
          `INSERT INTO events (at, instance, kind, detail) VALUES (?, ?, ?, ?)`,
          at,
          instance,
          kind,
          JSON.stringify(detail),
        )
        console.log(JSON.stringify({ at: new Date(at).toISOString(), instance, kind, detail }))
      }
      const markLive = () => {
        kvSet(
          "live",
          JSON.stringify({
            instance,
            since: instanceStartedAt,
            lastSeen: lastSeenAt ?? instanceStartedAt,
            phase,
          } satisfies LiveMarker),
        )
      }
      const seen = () => {
        lastSeenAt = Date.now()
        markLive()
      }

      // Every instance is a (re)start of the object. A live marker left by
      // the previous instance means that one was torn down without `stop`:
      // an eviction or a deploy. `gapMs` is how long the socket was dark.
      const previous = kvGet("live")
      if (previous !== undefined) {
        const marker = JSON.parse(previous) as LiveMarker
        record("restart", {
          previousInstance: marker.instance,
          uptimeMs: marker.lastSeen - marker.since,
          gapMs: instanceStartedAt - marker.lastSeen,
          phase: marker.phase,
        })
      }
      record("instance", {})
      const enabled = () => kvGet("enabled") === "1"
      if (enabled()) markLive()

      // Folds dfx's log into counters and events. dfx logs every gateway
      // payload at Trace (the raw `{ op, t, s, d }`), the shard's phase at
      // Trace, socket closes at Debug and handling failures at Error.
      const describeCause = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause) as {
          readonly reason?: {
            readonly _tag?: string
            readonly code?: number
            readonly closeReason?: string
          }
          readonly message?: string
        }
        return error?.reason?._tag !== undefined
          ? { tag: error.reason._tag, code: error.reason.code, reason: error.reason.closeReason }
          : { message: String(error?.message ?? Cause.pretty(cause)).slice(0, 500) }
      }
      const observer = Logger.make<unknown, void>(({ cause, fiber, logLevel, message }) => {
        try {
          const single = Array.isArray(message) && message.length === 1 ? message[0] : message
          if (typeof single === "object" && single !== null && "op" in single) {
            const payload = single as { op: number; t?: string; s?: number; d?: unknown }
            seen()
            switch (payload.op) {
              case Op.Dispatch: {
                bump("dispatches")
                const ready = payload.d as { session_id?: string; resume_gateway_url?: string }
                if (payload.t === "READY")
                  record("ready", {
                    sessionId: ready?.session_id,
                    resumeUrl: ready?.resume_gateway_url,
                    s: payload.s,
                  })
                else if (payload.t === "RESUMED") record("resumed", { s: payload.s })
                else bump(`dispatch:${payload.t}`)
                return
              }
              case Op.HeartbeatAck:
                bump("heartbeat_acks")
                return
              case Op.Hello:
                record("hello", (payload.d as { heartbeat_interval?: number }) ?? {})
                return
              case Op.Reconnect:
                record("reconnect_requested")
                return
              case Op.InvalidSession:
                record("invalid_session", { resumable: payload.d === true })
                return
              case Op.Heartbeat:
                bump("heartbeat_requests")
                return
              default:
                record("payload", { op: payload.op })
                return
            }
          }
          if (typeof single !== "string") return
          if (single === "phase transition") {
            const next = fiber.getRef(References.CurrentLogAnnotations)["phase"]
            if (typeof next === "number") {
              phase = next
              markLive()
              record("phase", { phase: next })
            }
            return
          }
          if (single === "Got socket error, reconnecting") {
            record("socket_error", describeCause(cause))
            return
          }
          if (logLevel === "Error" || logLevel === "Fatal") {
            record("shard_error", { message: single, cause: Cause.pretty(cause).slice(0, 2000) })
            return
          }
          if (logLevel === "Warn") record("warning", { message: single })
        } catch (error) {
          console.error("gateway observer failed", error)
        }
      })

      const config = yield* Effect.orDie(discordGatewayConfig)
      const ShardStateLive = Layer.succeed(
        ShardStateStore,
        ShardStateStore.of({
          forShard: () => ({
            get: Effect.sync(() =>
              Option.map(
                Option.fromUndefinedOr(kvGet("shard-state")),
                (json) => JSON.parse(json) as ShardState,
              ),
            ),
            set: (shardState) =>
              Effect.sync(() => {
                kvSet("shard-state", JSON.stringify(shardState))
              }),
            clear: Effect.sync(() => {
              kvDelete("shard-state")
            }),
          }),
        }),
      )
      const ShardLayer = ShardLive.pipe(
        Layer.provide(
          DiscordConfig.layer({ token: config.token, gateway: { intents: config.intents } }),
        ),
        Layer.provide(JsonDiscordWSCodecLive),
        Layer.provide(MemoryRateLimitStoreLive),
        Layer.provide(ShardStateLive),
      )
      const runShard = Effect.gen(function* () {
        const shard = yield* Shard
        yield* shard.connect([0, 1])
        return yield* Effect.never
      }).pipe(
        Effect.scoped,
        Effect.provide([ShardLayer, Socket.layerWebSocketConstructorGlobal]),
        Effect.provideService(References.MinimumLogLevel, "Trace"),
        Effect.provideService(Logger.CurrentLoggers, new Set([observer])),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            record("shard_exited", { cause: Cause.pretty(cause).slice(0, 2000) })
          }),
        ),
      )
      // The init closure's scope closes once the instance is built, so the
      // shard runs as a detached fiber the object tracks itself.
      let shardFiber: Fiber.Fiber<void> | undefined
      const running = Effect.sync(
        () => shardFiber !== undefined && shardFiber.pollUnsafe() === undefined,
      )
      const stopShard = Effect.suspend(() => {
        const fiber = shardFiber
        shardFiber = undefined
        return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
      })
      const startShard = (why: string) =>
        Effect.gen(function* () {
          yield* stopShard
          record("shard_start", { why, resuming: kvGet("shard-state") !== undefined })
          phase = null
          shardFiber = yield* Effect.forkDetach(runShard)
        })
      const arm = Effect.promise(() => storage.setAlarm(Date.now() + ALARM_EVERY_MS))

      // A rebuilt instance picks the socket back up straight away; the alarm
      // that woke it only has to check.
      if (enabled()) yield* startShard("instance")

      return {
        start: () =>
          Effect.gen(function* () {
            kvSet("enabled", "1")
            if (kvGet("started-at") === undefined) kvSet("started-at", String(Date.now()))
            markLive()
            if (!(yield* running)) yield* startShard("start")
            yield* arm
          }),
        stop: () =>
          Effect.gen(function* () {
            kvDelete("enabled")
            kvDelete("live")
            record("stop")
            yield* stopShard
            yield* Effect.promise(() => storage.deleteAlarm())
          }),
        reset: () =>
          Effect.sync(() => {
            if (enabled()) return false
            sql.exec(`DELETE FROM events`)
            sql.exec(`DELETE FROM counters`)
            sql.exec(`DELETE FROM kv`)
            record("reset")
            return true
          }),
        alarm: () =>
          Effect.gen(function* () {
            bump("alarms")
            if (!enabled()) return
            const quietFor = Date.now() - (lastSeenAt ?? instanceStartedAt)
            if (!(yield* running)) yield* startShard("alarm: shard not running")
            else if (quietFor > STALE_AFTER_MS) {
              record("stale", { quietForMs: quietFor, phase })
              yield* startShard("alarm: socket quiet")
            }
            yield* arm
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                record("alarm_failed", { cause: Cause.pretty(cause).slice(0, 2000) })
              }),
            ),
          ),
        stats: () =>
          Effect.sync((): GatewayStats => {
            const counters: Record<string, number> = {}
            for (const row of sql
              .exec<{ name: string; value: number }>(`SELECT name, value FROM counters`)
              .toArray())
              counters[row.name] = row.value
            const eventsByKind: Record<string, number> = {}
            for (const row of sql
              .exec<{ kind: string; n: number }>(
                `SELECT kind, COUNT(*) AS n FROM events GROUP BY kind`,
              )
              .toArray())
              eventsByKind[row.kind] = row.n
            const restarts = sql
              .exec<{ at: number; detail: string }>(
                `SELECT at, detail FROM events WHERE kind = 'restart' ORDER BY id`,
              )
              .toArray()
              .map((row) => {
                const detail = JSON.parse(row.detail) as {
                  uptimeMs: number
                  gapMs: number
                  phase: number | null
                }
                return {
                  at: row.at,
                  uptimeMs: detail.uptimeMs,
                  gapMs: detail.gapMs,
                  phase: detail.phase,
                }
              })
            const first = sql
              .exec<{ at: number | null }>(`SELECT MIN(at) AS at FROM events`)
              .toArray()[0]
            return {
              instance,
              instanceStartedAt,
              enabled: enabled(),
              phase,
              lastSeenAt,
              now: Date.now(),
              firstEventAt: first?.at ?? null,
              counters,
              eventsByKind,
              restarts,
              recent: readEvents(sql, { after: 0, limit: 50, newestFirst: true }),
            }
          }),
        events: (input) => Effect.sync(() => readEvents(sql, { ...input, newestFirst: false })),
      }
    })
  }),
)

const readEvents = (
  sql: GatewayStorage["sql"],
  { after, limit, newestFirst }: { after: number; limit: number; newestFirst: boolean },
): Array<GatewayEvent> =>
  sql
    .exec<{ id: number; at: number; instance: string; kind: string; detail: string }>(
      `SELECT id, at, instance, kind, detail FROM events WHERE id > ? ORDER BY id ${newestFirst ? "DESC" : "ASC"} LIMIT ?`,
      after,
      Math.min(Math.max(limit, 1), 1000),
    )
    .toArray()
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) as unknown }))
