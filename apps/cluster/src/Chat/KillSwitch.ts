import type { KillSwitchChange, KillSwitchState } from "@janitor/domain/Chat/Session"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as SqlClient from "effect/sql/SqlClient"
import type * as SqlError from "effect/sql/SqlError"

export type { KillSwitchState } from "@janitor/domain/Chat/Session"

const off: KillSwitchState = { global: false, slack: false, discord: false }
const everywhere: KillSwitchState = { global: true, slack: true, discord: true }

/**
 * The chat bot's kill switch (EFF-3012): on for every thread, or for one
 * platform's. While it is on, running turns are cancelled, no new turn
 * starts and each thread is told once that the bot is switched off.
 * Session entities only read it; the web app's settings set it, in
 * `ChatKillSwitchStore`.
 */
export class ChatKillSwitch extends Context.Service<
  ChatKillSwitch,
  { readonly get: Effect.Effect<KillSwitchState> }
>()("@janitor/cluster/Chat/KillSwitch/ChatKillSwitch") {
  /**
   * The stored switch, read on every call and retried briefly. A read that
   * still fails answers the last state read, so a database blip neither
   * stops nor starts the bot. Before any read has worked it answers on
   * everywhere: an unknown switch never lets a turn start.
   */
  static readonly stored: Layer.Layer<ChatKillSwitch, never, ChatKillSwitchStore> = Layer.effect(
    this,
    Effect.gen(function* () {
      const store = yield* ChatKillSwitchStore
      let last: KillSwitchState | undefined
      return {
        get: store.get.pipe(
          Effect.retry({ times: 2, schedule: Schedule.exponential("100 millis") }),
          Effect.tap((state) => Effect.sync(() => (last = state))),
          Effect.catch((error) =>
            Effect.logWarning("Reading the chat kill switch failed", error).pipe(
              Effect.as(last ?? everywhere),
            ),
          ),
        ),
      }
    }),
  )
}

/**
 * The stored kill switch, in Postgres (EFF-3021): every switch is off until
 * someone with Access turns it on.
 */
export class ChatKillSwitchStore extends Context.Service<
  ChatKillSwitchStore,
  {
    readonly get: Effect.Effect<KillSwitchState, SqlError.SqlError>
    /** Sets one switch and leaves the others as they are. */
    readonly set: (change: KillSwitchChange) => Effect.Effect<void, SqlError.SqlError>
  }
>()("@janitor/cluster/Chat/KillSwitch/ChatKillSwitchStore") {
  static readonly layer: Layer.Layer<ChatKillSwitchStore, never, SqlClient.SqlClient> =
    Layer.effect(
      this,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return {
          get: sql<KillSwitchState>`
            SELECT global, slack, discord FROM chat_kill_switch`.pipe(
            Effect.map((rows) => rows[0] ?? off),
          ),
          set: ({ switch: key, on }) =>
            sql`
              INSERT INTO chat_kill_switch ${sql.insert({ id: true, [key]: on })}
              ON CONFLICT (id) DO UPDATE SET ${sql(key)} = EXCLUDED.${sql(key)},
                updated_at = CLOCK_TIMESTAMP()`.pipe(Effect.asVoid),
        }
      }),
    )
}
