import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ExecutorContainer } from "./ExecutorContainer.ts"

/**
 * The per-run workspace Durable Object from the EFF-1651 design: a small
 * proxy that owns the run's sandbox container, starts it on `provision`,
 * forwards executor RPC on its plain `fetch` to `ctx.container.getTcpPort(3000)`,
 * and destroys it on `release`.
 *
 * It drives the raw workerd container API instead of alchemy's
 * `Containers.layer`, which starts the container eagerly whenever the object
 * is constructed: here a reconstructed object must not restart anything, so
 * `status` and `fetch` show whether the container outlived the object.
 *
 * Egress: the container starts with `enableInternet: false`; HTTP (port 80)
 * and HTTPS (port 443) are intercepted and handed to this Worker's default
 * entrypoint (`ctx.exports.default`), which applies the allowlist (see
 * `Egress.ts`). Every other port is closed.
 */
export interface WorkspaceShape {
  /**
   * "Start the container at the pinned SHA": a fresh container for this
   * acquire. `hold` picks what keeps the object and its container alive
   * between requests: `none`, `timeout` (`setInactivityTimeout`) or `alarm`
   * (a 30 s alarm while the container runs).
   */
  readonly provision: (acquire: number, hold: string) => Effect.Effect<unknown>
  /** `container.destroy()`. */
  readonly release: () => Effect.Effect<unknown>
  /** Never starts the container. */
  readonly status: () => Effect.Effect<unknown>
}

export class WorkspaceObject extends Cloudflare.DurableObject<WorkspaceObject, WorkspaceShape>()(
  "Eff1847Workspace",
) {}

const PORT = 3000
const INACTIVITY_TIMEOUT_MS = 15 * 60_000
const ALARM_EVERY_MS = 30_000

export default WorkspaceObject.make(
  Effect.gen(function* () {
    // Registers the container application on this Durable Object class (and
    // the Worker's `containers` binding) at deploy time. The runtime handle
    // it returns is not used: the object drives `ctx.container` directly.
    yield* ((ExecutorContainer as any)["~alchemy/Container/Binding"] as Effect.Effect<unknown>)
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      const objectInstance = Math.random().toString(36).slice(2, 10)
      const constructedAt = Date.now()
      const raw = state.raw as any
      const storage = raw.storage
      const container = raw.container as any
      const workspaceId = String(state.id.name ?? state.id.toString())
      const exportsKeys = (() => {
        try {
          return Object.keys(raw.exports ?? {})
        } catch (error) {
          return [`error: ${String(error)}`]
        }
      })()
      const monitorEvents: Array<unknown> = []
      console.log(
        `[Workspace ${workspaceId}] instance ${objectInstance} constructed, container ${container ? (container.running ? "running" : "stopped") : "missing"}, exports [${exportsKeys.join(",")}]`,
      )

      // A restarted object sets the inactivity timeout again; the runtime
      // does not keep it.
      const hold = (yield* Effect.promise(() => storage.get("hold"))) as string | undefined
      if (container?.running && hold === "timeout") {
        yield* Effect.promise(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS))
      }

      const port = () => container.getTcpPort(PORT)
      const health = (timeoutMs: number) =>
        Effect.promise(async () => {
          if (!container?.running) return { running: false }
          try {
            const response = await port().fetch("http://container/health", { signal: AbortSignal.timeout(timeoutMs) })
            return { running: true, status: response.status, body: await response.json() }
          } catch (error) {
            return { running: true, error: String(error) }
          }
        })

      const watch = (acquire: number) => {
        const startedAt = Date.now()
        container.monitor().then(
          () => {
            const record = { acquire, exit: "ok", afterMs: Date.now() - startedAt, at: Date.now() }
            monitorEvents.push(record)
            console.log(`[Workspace ${workspaceId}] container exited ${JSON.stringify(record)}`)
            return storage.put("lastExit", { ...record, objectInstance })
          },
          (error: unknown) => {
            const record = { acquire, exit: String(error), afterMs: Date.now() - startedAt, at: Date.now() }
            monitorEvents.push(record)
            console.log(`[Workspace ${workspaceId}] container exited ${JSON.stringify(record)}`)
            return storage.put("lastExit", { ...record, objectInstance })
          },
        )
      }

      const destroy = Effect.promise(async () => {
        if (!container.running) return { wasRunning: false, ms: 0 }
        const started = Date.now()
        await container.destroy()
        for (let i = 0; i < 100 && container.running; i++) await new Promise((r) => setTimeout(r, 100))
        return { wasRunning: true, ms: Date.now() - started, runningAfter: container.running }
      })

      // Allowlisted egress through the Worker's own default entrypoint.
      const intercept = Effect.promise(async () => {
        const egress = raw.exports?.default
        if (!egress) return { egress: "none: ctx.exports.default missing", exportsKeys }
        const result: Record<string, string> = {}
        try {
          await container.interceptAllOutboundHttp(egress)
          result.http = "ok"
        } catch (error) {
          result.http = String(error)
        }
        try {
          await container.interceptOutboundHttps("*", egress)
          result.https = "ok"
        } catch (error) {
          result.https = String(error)
        }
        return result
      })

      return {
        provision: (acquire, hold) =>
          Effect.gen(function* () {
            const started = Date.now()
            const destroyed = yield* destroy
            yield* Effect.promise(() => storage.put("hold", hold))
            yield* Effect.promise(() => storage.put("alarms", 0))
            const intercepted = yield* intercept
            const startCalledAt = Date.now()
            const startOnce = Effect.sync(() => {
              container.start({ enableInternet: false, env: { ACQUIRE: String(acquire), WORKSPACE_ID: workspaceId } })
              watch(acquire)
            })
            yield* startOnce
            // Ready = the executor's /health answers on port 3000. A start can
            // exit straight away with "There is no container instance that can
            // be provided to this Durable Object, try again later" when the
            // pre-warmed pool is used up; retry those, as alchemy's
            // startContainer and @cloudflare/containers do.
            let ready: any = undefined
            let attempts = 0
            let starts = 1
            const noInstance: Array<number> = []
            while (Date.now() - startCalledAt < 90_000) {
              attempts++
              ready = yield* health(5_000)
              if (ready.status === 200) break
              if (!ready.running) {
                yield* Effect.sleep("300 millis")
                const last = monitorEvents[monitorEvents.length - 1] as { exit?: string } | undefined
                if (!container.running && last?.exit?.includes("no container instance")) {
                  noInstance.push(Date.now() - startCalledAt)
                  yield* Effect.sleep("1 second")
                  starts++
                  yield* startOnce
                  continue
                }
                if (!container.running) break
              }
              yield* Effect.sleep("250 millis")
            }
            const holdResult = yield* Effect.promise(async () => {
              try {
                if (hold === "timeout") {
                  await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
                  return `setInactivityTimeout(${INACTIVITY_TIMEOUT_MS})`
                }
                if (hold === "alarm") {
                  await storage.setAlarm(Date.now() + ALARM_EVERY_MS)
                  return `alarm every ${ALARM_EVERY_MS}ms`
                }
                return "none"
              } catch (error) {
                return `error: ${String(error)}`
              }
            })
            const record = {
              workspaceId,
              objectInstance,
              acquire,
              hold: holdResult,
              provisionedAt: started,
              destroyMs: destroyed.ms,
              destroyed,
              intercepted,
              coldStartMs: Date.now() - startCalledAt,
              attempts,
              starts,
              noInstance,
              latencyMs: Date.now() - started,
              container: ready,
            }
            yield* Effect.promise(() => storage.put("provision", record))
            yield* Effect.promise(() => storage.put("released", null))
            console.log(`[Workspace ${workspaceId}] provisioned acquire=${acquire} cold start ${record.coldStartMs}ms (${attempts} probes, ${starts} starts, ready=${ready?.status === 200})`)
            return record
          }),

        release: () =>
          Effect.gen(function* () {
            const started = Date.now()
            const destroyed = yield* destroy
            yield* Effect.promise(() => storage.deleteAlarm())
            const record = { workspaceId, objectInstance, releasedAt: started, latencyMs: Date.now() - started, destroyed, runningAfter: container.running }
            yield* Effect.promise(() => storage.put("released", record))
            console.log(`[Workspace ${workspaceId}] released in ${record.latencyMs}ms`)
            return record
          }),

        status: () =>
          Effect.gen(function* () {
            const provision = yield* Effect.promise(() => storage.get("provision"))
            const released = yield* Effect.promise(() => storage.get("released"))
            const lastExit = yield* Effect.promise(() => storage.get("lastExit"))
            const alarms = yield* Effect.promise(() => storage.get("alarms"))
            const currentHold = yield* Effect.promise(() => storage.get("hold"))
            const now = yield* health(5_000)
            return {
              workspaceId,
              objectInstance,
              constructedAt,
              objectAgeMs: Date.now() - constructedAt,
              exportsKeys,
              hold: currentHold ?? null,
              alarms: alarms ?? 0,
              container: now,
              monitorEvents,
              lastExit: lastExit ?? null,
              provision: provision ?? null,
              released: released ?? null,
            }
          }),

        // The `alarm` hold: re-arm while the container runs.
        alarm: () =>
          Effect.promise(async () => {
            const n = ((await storage.get("alarms")) ?? 0) + 1
            await storage.put("alarms", n)
            const running = container.running
            console.log(`[Workspace ${workspaceId}] alarm #${n} on instance ${objectInstance}, container ${running ? "running" : "stopped"}`)
            if (running && (await storage.get("hold")) === "alarm") await storage.setAlarm(Date.now() + ALARM_EVERY_MS)
          }),

        // Executor RPC forwarding to the container port. The request body is
        // forwarded as a stream; a WebSocket upgrade returns the container's
        // socket to the caller. A stopped container is reported, not restarted.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://workspace")
          if (!container.running) {
            console.log(`[Workspace ${workspaceId}] ${request.method} ${url.pathname} -> 503 (container not running)`)
            return HttpServerResponse.text(`workspace ${workspaceId}: container not running`, { status: 503 })
          }
          const webRequest = (request as any).source as Request | undefined
          const headers = new Headers(request.headers as Record<string, string>)
          const isUpgrade = headers.get("upgrade")?.toLowerCase() === "websocket"
          const init: RequestInit & { duplex?: string } = { method: request.method, headers }
          if (!isUpgrade && request.method !== "GET" && request.method !== "HEAD") {
            init.body = webRequest?.body ?? null
            init.duplex = "half"
          }
          const started = Date.now()
          const response = (yield* Effect.promise(() => port().fetch(`http://container${url.pathname}${url.search}`, init))) as Response & {
            webSocket?: WebSocket | null
          }
          console.log(`[Workspace ${workspaceId}] ${request.method} ${url.pathname} -> ${response.status} (${Date.now() - started}ms, ws=${response.webSocket ? "yes" : "no"})`)
          if (response.webSocket) {
            return HttpServerResponse.setBody(
              HttpServerResponse.empty({ status: 101 }),
              HttpBody.raw(new Response(null, { status: 101, webSocket: response.webSocket } as any)),
            )
          }
          const passthrough = new Response(response.body, { status: response.status, headers: response.headers })
          return HttpServerResponse.setBody(HttpServerResponse.empty({ status: response.status }), HttpBody.raw(passthrough))
        }),
      } satisfies WorkspaceShape & { fetch: unknown; alarm: unknown }
    })
  }),
)
