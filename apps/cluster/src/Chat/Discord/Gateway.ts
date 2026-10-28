import * as Cloudflare from "@alchemy.run/cloudflare"
import * as DiscordConfig from "dfx/DiscordConfig"
import { JsonDiscordWSCodecLive } from "dfx/DiscordGateway/DiscordWS"
import { Shard, ShardLive } from "dfx/DiscordGateway/Shard"
import { DispatchHook } from "dfx/DiscordGateway/Shard/DispatchHook"
import { type ShardState, ShardStateStore } from "dfx/DiscordGateway/Shard/StateStore"
import { MemoryRateLimitStoreLive } from "dfx/RateLimit"
import { GatewayIntentBits, GatewayOpcodes } from "dfx/types"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as LogLevel from "effect/LogLevel"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Socket from "effect/socket/Socket"
import { restLayer } from "./Api.ts"
import { chatBotGate } from "../Config.ts"
import { DiscordBotConfig, discordSettings } from "./Config.ts"
import * as Ingress from "./Ingress.ts"

/**
 * The Discord gateway Durable Object (EFF-3020): one instance, named
 * `GATEWAY_NAME`, holding the bot's gateway socket with dfx's shard. The
 * shard's session (`session_id`, `resume_gateway_url`, sequence) lives in
 * this object's storage through `ShardStateStore`, so a rebuilt instance
 * RESUMEs instead of identifying again. A 60-second self-rescheduling alarm
 * wakes the object after an eviction and restarts a shard that died or went
 * quiet.
 *
 * It is ingress only: each `MESSAGE_CREATE` goes through `Ingress` before
 * its sequence is stored, so a message that couldn't reach its session comes
 * back with the RESUME, and the message ids already handled are kept here to
 * drop the ones a RESUME replays. A 12-hour spike measured two evictions with
 * a live socket in six hours, each healed by the alarm within a minute, and
 * every reconnect was a RESUME.
 */

export const GATEWAY_NAME = "gateway"

/**
 * `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES` (for the pointer) and the
 * privileged `MESSAGE_CONTENT`.
 */
export const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.DirectMessages |
  GatewayIntentBits.MessageContent

/** How long without any payload before the alarm treats the socket as dead. */
const STALE_AFTER_MS = 3 * 60_000
const ALARM_EVERY_MS = 60_000

/** How many of the shard's log lines are held for the next alarm or `start` to write. */
const HELD_LOGS = 200

/** How long handled message ids are kept: longer than any RESUME replays. */
const SEEN_FOR_MS = 24 * 60 * 60_000

/**
 * Close codes Discord won't change its mind on: an invalid token (4004) and
 * intents the app isn't allowed (4014). The shard waits this long before it
 * identifies again, so a misconfigured app spends 24 IDENTIFYs a day, well
 * inside Discord's 1,000.
 */
const FATAL_CLOSE_CODES: ReadonlyMap<number, string> = new Map([
  [4004, "the bot token is invalid"],
  [
    4014,
    "the app isn't allowed an intent it asks for; turn on the Message Content intent under Bot in the Discord developer portal",
  ],
])
const FATAL_BACKOFF_MS = 60 * 60_000

export interface ChatDiscordGatewayShape {
  /** Turns the gateway on: connects the shard unless it's running, and arms the alarm. */
  readonly start: () => Effect.Effect<void>
}

export class ChatDiscordGateway extends Cloudflare.DurableObject<
  ChatDiscordGateway,
  ChatDiscordGatewayShape
>()("ChatDiscordGateway") {}

/** The part of the Durable Object's storage the gateway uses. SQL is synchronous. */
interface GatewayStorage {
  readonly sql: {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: Array<unknown>
    ): { toArray(): Array<T> }
  }
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

/** The close in dfx's "Got socket error, reconnecting" log: its code if it was a close, and why. */
const describeClose = (
  cause: Cause.Cause<unknown>,
): { readonly code: number | undefined; readonly reason: string } => {
  const error = Cause.squash(cause) as {
    readonly reason?: { readonly _tag?: string; readonly code?: number; readonly message?: string }
    readonly message?: string
  }
  return {
    code: error?.reason?._tag === "SocketCloseError" ? error.reason.code : undefined,
    reason: String(error?.reason?.message ?? error?.message ?? Cause.pretty(cause)).slice(0, 500),
  }
}

/** dfx's shard phases, by the number its "phase transition" log carries. */
const PHASES = ["connecting", "handshake", "connected"] as const

/**
 * The gateway object. `sessions` reaches the chat session entities; the
 * Worker passes its cluster's, which exists by the time an instance starts.
 */
export const ChatDiscordGatewayLive = (sessions: Layer.Layer<Ingress.DiscordSessions>) =>
  ChatDiscordGateway.make(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState

      return Effect.gen(function* () {
        const storage = state.raw.storage as unknown as GatewayStorage
        const sql = storage.sql
        sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
        sql.exec(`CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`)

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

        // The Worker's rule: Discord is on only while the bot is. Settings
        // change only with a deploy, which rebuilds this object, so an
        // instance holding a socket always runs under the current settings.
        const settings = (yield* Effect.orDie(chatBotGate))
          ? yield* Effect.orDie(discordSettings)
          : Option.none()
        // Turned off: no shard starts, and the alarm left from before the
        // deploy wakes the object once to forget its session and stop.
        if (Option.isNone(settings)) {
          return {
            start: () => Effect.void,
            alarm: () =>
              Effect.promise(() => storage.deleteAlarm()).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    kvDelete("enabled")
                    kvDelete("shard-state")
                  }),
                ),
              ),
          }
        }
        const config = settings.value

        const SeenLive = Layer.succeed(Ingress.SeenMessages, {
          has: (id) =>
            Effect.sync(
              () => sql.exec(`SELECT 1 AS one FROM seen WHERE id = ?`, id).toArray().length > 0,
            ),
          add: (id) =>
            Effect.sync(() => {
              sql.exec(`INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)`, id, Date.now())
            }),
        })
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
        const ingress = yield* Ingress.DiscordIngress.pipe(
          Effect.provide(
            Ingress.layer.pipe(
              Layer.provide([
                DiscordBotConfig.layerFrom(config),
                sessions,
                SeenLive,
                restLayer(config.botToken).pipe(Layer.provide(FetchHttpClient.layer)),
              ]),
            ),
          ),
        )

        const instanceStartedAt = Date.now()
        let lastSeenAt = Date.now()
        let shardFiber: Fiber.Fiber<void> | undefined

        const stopShard = Effect.suspend(() => {
          const fiber = shardFiber
          shardFiber = undefined
          return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
        })

        // What the socket has done, for the alarm to report.
        let phase: number | undefined
        let socketsOpened = 0
        let lastExit: string | undefined
        let lastClose:
          | { readonly at: number; readonly code: number | undefined; readonly reason: string }
          | undefined
        // Since the last alarm: the messages Discord sent, and why ingress dropped them.
        let messagesReceived = 0
        const drops = new Map<string, number>()

        // The shard's socket belongs to the event that started it, and that
        // event never finishes, so nothing logged in it reaches Workers logs.
        // The shard's log lines are held instead, and the next alarm or
        // `start` writes them, up to `HELD_LOGS` a minute.
        let held: Array<Effect.Effect<void>> = []
        let heldDropped = 0
        const hold = (
          level: LogLevel.LogLevel,
          message: ReadonlyArray<unknown>,
          annotations: Record<string, unknown>,
          cause: Cause.Cause<unknown> = Cause.empty,
        ) => {
          if (held.length >= HELD_LOGS) heldDropped++
          else
            held.push(
              Effect.logWithLevel(level as LogLevel.Severity)(...message, cause).pipe(
                Effect.annotateLogs({ ...annotations, loggedAt: new Date().toISOString() }),
              ),
            )
        }
        const report = (
          level: LogLevel.Severity,
          message: string,
          annotations: Record<string, unknown>,
          cause?: Cause.Cause<unknown>,
        ) => hold(level, [message], annotations, cause)
        const flush = Effect.suspend(() => {
          const logs = held
          const dropped = heldDropped
          held = []
          heldDropped = 0
          return Effect.all(logs, { discard: true }).pipe(
            Effect.andThen(
              dropped === 0
                ? Effect.void
                : Effect.logWarning("Discord gateway dropped log lines").pipe(
                    Effect.annotateLogs({ dropped }),
                  ),
            ),
          )
        })

        // dfx logs every payload and phase change at Trace, which tells the
        // alarm the socket is alive, and a socket close or a failed write at
        // Debug, after which it reconnects whatever the code. Those are
        // reported here; closes that a reconnect can't fix stop the shard
        // instead. The rest of the shard's logs are held from the Worker's
        // minimum level up, which puts ingress's dropped messages at Debug.
        const minimumLevel = yield* References.MinimumLogLevel
        const onPayload = (payload: {
          readonly op: number
          readonly t?: string | null
          readonly d?: unknown
        }) => {
          lastSeenAt = Date.now()
          switch (payload.op) {
            case GatewayOpcodes.Hello: {
              socketsOpened++
              const resuming = kvGet("shard-state") !== undefined
              report("Info", "Discord gateway socket opened", {
                handshake: resuming ? "resume" : "identify",
              })
              return
            }
            case GatewayOpcodes.Dispatch: {
              if (payload.t === "MESSAGE_CREATE") messagesReceived++
              else if (payload.t === "READY") {
                const ready = payload.d as { readonly session_id?: string }
                report("Info", "Discord gateway READY", { sessionId: ready?.session_id })
              } else if (payload.t === "RESUMED") report("Info", "Discord gateway RESUMED", {})
              return
            }
            case GatewayOpcodes.InvalidSession: {
              report("Warn", "Discord invalidated the gateway session", {
                resumable: payload.d === true,
              })
              return
            }
            case GatewayOpcodes.Reconnect: {
              report("Info", "Discord asked the gateway to reconnect", {})
              return
            }
          }
        }
        const onClose = (cause: Cause.Cause<unknown>) => {
          const { code, reason } = describeClose(cause)
          lastClose = { at: Date.now(), code, reason }
          const fatal = code === undefined ? undefined : FATAL_CLOSE_CODES.get(code)
          if (fatal !== undefined) {
            kvSet("fatal-until", String(Date.now() + FATAL_BACKOFF_MS))
            report(
              "Error",
              `Discord closed the gateway with ${code}: ${fatal}. Trying again in an hour.`,
              { closeCode: code },
            )
            Effect.runFork(stopShard)
          } else
            report("Warn", "Discord gateway socket closed, reconnecting", {
              closeCode: code ?? "none",
              reason,
            })
        }
        const watcher = Logger.make<unknown, void>((options) => {
          const single =
            Array.isArray(options.message) && options.message.length === 1
              ? options.message[0]
              : options.message
          if (typeof single === "object" && single !== null && "op" in single)
            return onPayload(single as Parameters<typeof onPayload>[0])
          if (single === "phase transition") {
            const next = options.fiber.getRef(References.CurrentLogAnnotations)["phase"]
            if (typeof next === "number") phase = next
            return
          }
          if (single === "Got socket error, reconnecting") return onClose(options.cause)
          const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
          if (options.logLevel === "Debug" && annotations["channel"] === "outbound")
            return report("Warn", "Discord gateway couldn't write to the socket", {}, options.cause)
          if (single === Ingress.DROPPED) {
            const reason = String(annotations["reason"])
            drops.set(reason, (drops.get(reason) ?? 0) + 1)
          }
          if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, minimumLevel))
            hold(
              options.logLevel,
              Array.isArray(options.message) ? options.message : [options.message],
              annotations,
              options.cause,
            )
        })

        const runShard = Effect.gen(function* () {
          const shard = yield* Shard
          yield* shard.connect([0, 1])
          return yield* Effect.never
        }).pipe(
          Effect.scoped,
          Effect.provide([
            ShardLive.pipe(
              Layer.provide(
                DiscordConfig.layer({ token: config.botToken, gateway: { intents: INTENTS } }),
              ),
              Layer.provide(JsonDiscordWSCodecLive),
              Layer.provide(MemoryRateLimitStoreLive),
              Layer.provide(ShardStateLive),
            ),
            Socket.layerWebSocketConstructorGlobal,
          ]),
          // Runs before the sequence is stored: a failure reconnects and resumes from it.
          Effect.provideService(DispatchHook, (payload) =>
            payload.t === "MESSAGE_CREATE" ? Effect.orDie(ingress.handle(payload.d)) : Effect.void,
          ),
          Effect.provideService(References.MinimumLogLevel, "Trace"),
          Effect.provideService(References.CurrentLoggers, new Set([watcher])),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (Cause.hasInterruptsOnly(cause)) return
              lastExit = Cause.pretty(cause).slice(0, 500)
              report("Error", "Discord gateway shard exited", {}, cause)
            }),
          ),
        )

        const running = Effect.sync(
          () => shardFiber !== undefined && shardFiber.pollUnsafe() === undefined,
        )
        const startShard = (why: string) =>
          Effect.gen(function* () {
            yield* stopShard
            const fatalUntil = Number(kvGet("fatal-until") ?? 0)
            if (Date.now() < fatalUntil) return
            report("Info", "Discord gateway shard starting", {
              why,
              resuming: kvGet("shard-state") !== undefined,
            })
            lastSeenAt = Date.now()
            phase = undefined
            // The init closure's scope closes once the instance is built, so
            // the shard runs as a detached fiber the object tracks itself.
            shardFiber = yield* Effect.forkDetach(runShard)
          })

        const arm = Effect.promise(() => storage.setAlarm(Date.now() + ALARM_EVERY_MS))

        /** Reports the shard, restarts it if it died or went quiet, and forgets old message ids. */
        const check = Effect.gen(function* () {
          sql.exec(`DELETE FROM seen WHERE at < ?`, Date.now() - SEEN_FOR_MS)
          yield* flush
          const isRunning = yield* running
          const quietFor = Date.now() - lastSeenAt
          const fatalUntil = Number(kvGet("fatal-until") ?? 0)
          yield* Effect.logInfo("Discord gateway alarm").pipe(
            Effect.annotateLogs({
              running: isRunning,
              phase: phase === undefined ? "none" : (PHASES[phase] ?? phase),
              sinceLastPayloadMs: quietFor,
              socketsOpened,
              lastClose:
                lastClose === undefined
                  ? "none"
                  : `${lastClose.code ?? "no code"} (${lastClose.reason}) ${Date.now() - lastClose.at}ms ago`,
              lastExit: lastExit ?? "none",
              shardState: kvGet("shard-state") !== undefined,
              fatalUntil: Date.now() < fatalUntil ? new Date(fatalUntil).toISOString() : "none",
              instanceAgeMs: Date.now() - instanceStartedAt,
              messagesReceived,
              drops: JSON.stringify(Object.fromEntries(drops)),
            }),
          )
          messagesReceived = 0
          drops.clear()
          if (!isRunning) yield* startShard("not running")
          else if (quietFor > STALE_AFTER_MS) yield* startShard("socket quiet")
        })

        // A rebuilt instance picks the socket back up straight away; the
        // alarm that woke it only has to check.
        const enabled = kvGet("enabled") === "1"
        report("Info", "Discord gateway instance started", { enabled })
        if (enabled) yield* startShard("instance")

        return {
          start: () =>
            Effect.gen(function* () {
              kvSet("enabled", "1")
              yield* flush
              if (!(yield* running)) yield* startShard("start")
              if ((yield* Effect.promise(() => storage.getAlarm())) === null) yield* arm
            }),
          alarm: () =>
            Effect.gen(function* () {
              yield* check
              yield* arm
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Discord gateway alarm failed", cause).pipe(Effect.andThen(arm)),
              ),
            ),
        }
      })
    }),
  )
