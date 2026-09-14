import { Context, Effect, Layer } from "effect"
import { Session } from "@opencode/sdk/effect"
import type { Host } from "../Host.ts"
import type { RunnerStorage, NativeSessionRow } from "../Storage.ts"

export const claimHeld = (row: NativeSessionRow | undefined) =>
  row !== undefined && row.timeSuspended !== null

interface SupervisionDependencies {
  readonly storage: DurableObjectStorage
  readonly store: RunnerStorage
  readonly interval: () => number
  readonly guard: () => string | null
  readonly host: () => Promise<Host>
  readonly disposeHost: () => Promise<void>
  readonly prune: () => Promise<void>
  readonly beforeIdle: () => Promise<void>
  readonly incarnation: string
}
const native = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause })

/** Owns durable wake obligations and recovery checks; alarms never become prompts. */
export class SessionSupervision extends Context.Service<
  SessionSupervision,
  {
    readonly arm: Effect.Effect<void, unknown>
    readonly rearm: Effect.Effect<void, unknown>
    readonly tick: Effect.Effect<void, unknown>
  }
>()("janitor/runner/SessionSupervision") {
  static make(deps: SupervisionDependencies): SessionSupervision["Service"] {
    const { storage, store } = deps
    const rearm = Effect.gen(function* () {
      const due = Date.now() + deps.interval()
      const existing = yield* native(() => storage.getAlarm())
      if (existing === null || existing > due) yield* native(() => storage.setAlarm(due))
      store.supervision = {
        ...store.supervision,
        dueAt: existing === null || existing > due ? due : existing,
      }
    }).pipe(Effect.withSpan("SessionSupervision.rearm"))
    const check = Effect.fn("SessionSupervision.check")(function* (revision: number) {
      const host = yield* native(deps.host)
      const session = store.session
      if (!session) {
        store.journal("inspected", { creating: true })
        return
      }
      const nativeId = Session.ID.make(session.nativeSessionId)
      const active = yield* native(() => host.run(host.execution.isActive(nativeId)))
      const row = store.nativeSession(session.nativeSessionId)
      const pending = store.pendingInbox(session.nativeSessionId, row?.timeIdle ?? null)
      store.journal("inspected", {
        active,
        claimHeld: claimHeld(row),
        outcome: row?.idleOutcome ?? null,
        pending,
        revision,
        resumeAttempts: row?.resumeAttempts ?? 0,
      })
      if (active) return
      yield* native(deps.prune)
      if (claimHeld(row)) {
        if (Date.now() - host.createdAt > deps.interval() * 2) {
          store.journal("recover-orphan", { resumeAttempts: row?.resumeAttempts ?? 0 })
          yield* native(deps.disposeHost)
        }
        return
      }
      if (row?.idleOutcome === "failed" ? pending.sinceIdle > 0 : pending.total > 0) {
        store.journal("wake")
        yield* native(() => host.run(host.execution.wake(nativeId)))
        return
      }
      yield* native(deps.beforeIdle)
      const cleared = store.transaction(() => {
        if (store.supervision.revision !== revision) return false
        store.supervision = { ...store.supervision, obligation: false, dueAt: null }
        return true
      })
      if (!cleared) {
        store.journal("idle-raced")
        return
      }
      yield* native(() => storage.deleteAlarm())
      if (store.supervision.revision !== revision) yield* rearm
      store.journal("idle", { outcome: row?.idleOutcome ?? null })
    })
    return {
      rearm,
      arm: Effect.gen(function* () {
        const previous = store.supervision
        store.supervision = {
          revision: previous.revision + 1,
          obligation: true,
          dueAt: previous.dueAt,
        }
        yield* rearm
        store.journal("armed", { revision: previous.revision + 1 })
      }).pipe(Effect.withSpan("SessionSupervision.arm")),
      tick: Effect.gen(function* () {
        store.journal("alarm-start", { incarnation: deps.incarnation })
        const pruned = yield* native(deps.prune).pipe(
          Effect.match({
            onFailure: (error) => {
              store.journal("checkpoint-cleanup-error", { error: String(error) })
              return false
            },
            onSuccess: () => true,
          }),
        )
        if (!pruned) {
          yield* rearm
          return
        }
        const supervision = store.supervision
        if (!supervision.obligation || store.disconnection !== undefined) {
          store.journal("alarm-noop")
          return
        }
        const guard = deps.guard()
        if (guard !== null) {
          store.journal("alarm-blocked", { reason: guard })
          yield* native(() => storage.deleteAlarm())
          return
        }
        yield* rearm
        yield* check(supervision.revision).pipe(
          Effect.catch((error) =>
            Effect.sync(() => store.journal("inspection-error", { error: String(error) })),
          ),
        )
        store.journal("alarm-end")
      }).pipe(Effect.withSpan("SessionSupervision.tick")),
    }
  }
  static layer(deps: SupervisionDependencies) {
    return Layer.sync(this, () => this.make(deps))
  }
}
