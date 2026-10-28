import type { KillSwitchState } from "@janitor/domain/Chat/Session"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as SqlClient from "effect/sql/SqlClient"
import type * as SqlError from "effect/sql/SqlError"

export type { KillSwitchState } from "@janitor/domain/Chat/Session"

/**
 * The chat bot's kill switch (EFF-3012): on for every thread, or for one
 * platform's. While it is on, running turns are cancelled, no new turn
 * starts and each thread is told once that the bot is switched off.
 * Session entities only read it; the web app's settings set it.
 */
export class ChatKillSwitch extends Context.Service<
  ChatKillSwitch,
  { readonly get: Effect.Effect<KillSwitchState> }
>()("@janitor/cluster/Chat/KillSwitch/ChatKillSwitch") {
  /**
   * A switch that is never on. The Worker binds it until "Chat sessions in
   * the web app" (EFF-3021) stores the real one.
   */
  static readonly off = Layer.succeed(this, {
    get: Effect.succeed({ global: false, slack: false, discord: false }),
  })
}

/**
 * The stored kill switch, in Postgres (EFF-3021): every switch is off until
 * someone with Access turns it on.
 */
export class ChatKillSwitchStore extends Context.Service<
  ChatKillSwitchStore,
  {
    readonly get: Effect.Effect<KillSwitchState, SqlError.SqlError>
    readonly set: (state: KillSwitchState) => Effect.Effect<void, SqlError.SqlError>
  }
>()("@janitor/cluster/Chat/KillSwitch/ChatKillSwitchStore") {
  /** Not stored yet: "Chat sessions in the web app" (EFF-3021) builds it. */
  static readonly layer: Layer.Layer<ChatKillSwitchStore, never, SqlClient.SqlClient> =
    Layer.succeed(this, {
      get: Effect.die("The chat kill switch is not stored yet (EFF-3021)"),
      set: () => Effect.die("The chat kill switch is not stored yet (EFF-3021)"),
    })
}
