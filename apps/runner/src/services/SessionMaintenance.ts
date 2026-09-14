import { Context, Effect, Layer } from "effect"
import {
  ProtocolError,
  type Maintenance,
  type MaintenanceCheck,
  type MaintenanceResult,
} from "../Protocol.ts"
import type { RunnerStorage } from "../Storage.ts"

interface MaintenanceDependencies {
  readonly storage: DurableObjectStorage
  readonly store: RunnerStorage
  readonly waitUntil: (work: Promise<unknown>) => void
  readonly nativeActive: () => boolean
  readonly workspaceBusy: () => boolean
  readonly uncertain: () => boolean
  readonly toolDeadline: () => number
  readonly stop: () => Promise<void>
  readonly checks: () => Promise<ReadonlyArray<MaintenanceCheck>>
  readonly guard: () => string | null
  readonly rearm: () => Promise<void>
}
const native = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause })

/** Durable epoch holds drain admitted work and require compatibility checks before release. */
export class SessionMaintenance extends Context.Service<
  SessionMaintenance,
  {
    readonly apply: (request: Maintenance) => Effect.Effect<MaintenanceResult, unknown>
  }
>()("janitor/runner/SessionMaintenance") {
  static make(deps: MaintenanceDependencies): SessionMaintenance["Service"] {
    const { storage, store } = deps
    let draining: Promise<void> | undefined
    const status = (checks: ReadonlyArray<MaintenanceCheck>): MaintenanceResult => ({
      ...store.maintenance,
      quiescent: !deps.nativeActive() && !deps.workspaceBusy() && draining === undefined,
      uncertain: store.blockers.length > 0 || deps.uncertain(),
      checks,
    })
    const drain = Effect.gen(function* () {
      const started = Date.now()
      const deadline = started + deps.toolDeadline() + 30_000
      while (deps.workspaceBusy() && Date.now() < deadline) yield* Effect.sleep("100 millis")
      const settled = !deps.workspaceBusy()
      yield* native(deps.stop)
      yield* native(() => storage.deleteAlarm())
      store.journal("maintenance-quiescent", { waitedMs: Date.now() - started, settled })
    }).pipe(Effect.withSpan("SessionMaintenance.drain"))
    return {
      apply: Effect.fn("SessionMaintenance.apply")(function* (body) {
        const current = store.maintenance
        if (body.hold) {
          if (current.held && current.epoch !== null && current.epoch > body.epoch)
            return status([])
          if (!current.held || current.epoch !== body.epoch) {
            store.maintenance = { held: true, epoch: body.epoch }
            yield* native(() => storage.sync())
            store.journal("maintenance-held", { epoch: body.epoch })
          }
          yield* native(() => storage.deleteAlarm())
          if (!draining && (deps.nativeActive() || deps.workspaceBusy())) {
            draining = Effect.runPromise(drain).finally(() => {
              draining = undefined
            })
            deps.waitUntil(draining)
          }
          if (draining)
            yield* Effect.raceFirst(
              native(() => draining!),
              Effect.sleep("50 millis"),
            )
          return status([])
        }
        if (store.disconnection !== undefined)
          return status([
            {
              name: "fence",
              ok: false,
              detail: "session was disconnected; the fence outranks release",
            },
          ])
        if (!current.held) return status([])
        if (current.epoch !== body.epoch)
          return yield* Effect.fail(
            new ProtocolError(
              "invalid_request",
              `Maintenance epoch ${body.epoch} does not match the held epoch ${current.epoch}`,
            ),
          )
        const checks = yield* native(deps.checks)
        if (checks.some((check) => !check.ok)) {
          store.journal("maintenance-release-refused", { epoch: body.epoch, checks })
          return status(checks)
        }
        store.maintenance = { held: false, epoch: body.epoch }
        store.journal("maintenance-released", { epoch: body.epoch })
        if (store.supervision.obligation && deps.guard() === null) yield* native(deps.rearm)
        return status(checks)
      }),
    }
  }
  static layer(deps: MaintenanceDependencies) {
    return Layer.sync(this, () => this.make(deps))
  }
}
