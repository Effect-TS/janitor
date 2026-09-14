import { Context, Effect, Layer } from "effect"
import type { Host } from "../Host.ts"

/** Owns one native SDK runtime per object incarnation, including concurrent startup and shutdown. */
export class NativeSession extends Context.Service<
  NativeSession,
  {
    readonly active: () => boolean
    readonly get: Effect.Effect<Host, unknown>
    readonly stop: Effect.Effect<void, unknown>
  }
>()("janitor/runner/NativeSession") {
  static make(initialize: () => Promise<Host>, stopped: () => void): NativeSession["Service"] {
    let host: Host | undefined
    let starting: Promise<Host> | undefined
    return {
      active: () => host !== undefined || starting !== undefined,
      get: Effect.tryPromise({
        try: () => {
          if (host) return Promise.resolve(host)
          return (starting ??= initialize()
            .then((created) => {
              host = created
              return created
            })
            .finally(() => {
              starting = undefined
            }))
        },
        catch: (cause) => cause,
      }).pipe(Effect.withSpan("NativeSession.start")),
      stop: Effect.tryPromise({
        try: async () => {
          await starting?.catch(() => undefined)
          const current = host
          host = undefined
          if (current) {
            await current.dispose()
            stopped()
          }
        },
        catch: (cause) => cause,
      }).pipe(Effect.withSpan("NativeSession.stop")),
    }
  }
  static layer(initialize: () => Promise<Host>, stopped: () => void) {
    return Layer.sync(this, () => this.make(initialize, stopped))
  }
}
