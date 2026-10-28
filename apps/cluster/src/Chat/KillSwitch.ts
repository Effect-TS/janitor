import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * The chat bot's kill switch (EFF-3012): on for every thread, or for one
 * platform's. While it is on, running turns are cancelled, no new turn
 * starts and each thread is told once that the bot is switched off.
 * "Chat sessions in the web app" (EFF-3021) builds the controls; session
 * entities only read it.
 */
export interface KillSwitchState {
  readonly global: boolean
  readonly slack: boolean
  readonly discord: boolean
}

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
