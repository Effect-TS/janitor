import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

/**
 * The per-run workspace Durable Object from the EFF-1651 design: a small
 * proxy that owns the run's sandbox, starts it lazily, forwards executor RPC
 * on its plain `fetch`, and destroys it on release.
 *
 * Staging stand-in: the account used for this smoke test has no Workers Paid
 * plan, so Cloudflare Containers cannot be deployed. Instead of
 * `ctx.container.getTcpPort(3000)` the object forwards to an external
 * executor (`executor/server.ts` behind a cloudflared quick tunnel, URL in
 * `EXECUTOR_URL`). Everything in front of that hop — the entity, the entity →
 * workspace DO `fetch` on the real edge, HTTP streaming and WebSocket
 * upgrades through it — is real.
 */
export interface WorkspaceShape {
  /** Stand-in for "start the container at the pinned SHA": resets the workspace directory. */
  readonly provision: (acquire: number) => Effect.Effect<unknown>
  /** Stand-in for `container.destroy()`. */
  readonly release: () => Effect.Effect<unknown>
  readonly status: () => Effect.Effect<unknown>
}

export class WorkspaceObject extends Cloudflare.DurableObject<WorkspaceObject, WorkspaceShape>()(
  "Eff1847Workspace",
) {}

export default WorkspaceObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const env = yield* Cloudflare.Workers.WorkerEnvironment
    const executorBase = String((env as any).EXECUTOR_URL ?? "").replace(/\/+$/, "")

    return Effect.gen(function* () {
      const objectInstance = Math.random().toString(36).slice(2, 10)
      const raw = state.raw as any
      const storage = raw.storage
      const workspaceId = String(state.id.name ?? state.id.toString())
      console.log(`[Workspace ${workspaceId}] instance ${objectInstance} constructed`)

      const upstream = (path: string, init?: RequestInit) =>
        Effect.promise(() => fetch(`${executorBase}/${encodeURIComponent(workspaceId)}${path}`, init))

      return {
        provision: (acquire) =>
          Effect.gen(function* () {
            const started = Date.now()
            const response = yield* upstream(`/reset?acquire=${acquire}`, { method: "POST" })
            const body = yield* Effect.promise(() => response.json())
            const record = {
              workspaceId,
              objectInstance,
              acquire,
              provisionedAt: started,
              latencyMs: Date.now() - started,
              executor: body,
            }
            yield* Effect.promise(() => storage.put("provision", record))
            yield* Effect.promise(() => storage.put("released", null))
            console.log(`[Workspace ${workspaceId}] provisioned acquire=${acquire} in ${record.latencyMs}ms`)
            return record
          }),

        release: () =>
          Effect.gen(function* () {
            const started = Date.now()
            const response = yield* upstream(`/release`, { method: "POST" })
            const body = yield* Effect.promise(() => response.json())
            const record = { workspaceId, objectInstance, releasedAt: started, latencyMs: Date.now() - started, executor: body }
            yield* Effect.promise(() => storage.put("released", record))
            console.log(`[Workspace ${workspaceId}] released in ${record.latencyMs}ms`)
            return record
          }),

        status: () =>
          Effect.gen(function* () {
            const provision = yield* Effect.promise(() => storage.get("provision"))
            const released = yield* Effect.promise(() => storage.get("released"))
            return { workspaceId, objectInstance, executorBase, provision: provision ?? null, released: released ?? null }
          }),

        // Executor RPC forwarding. The request body is forwarded as a stream;
        // a WebSocket upgrade returns the upstream socket to the caller.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://workspace")
          const webRequest = (request as any).source as Request | undefined
          const headers = new Headers(request.headers as Record<string, string>)
          const isUpgrade = headers.get("upgrade")?.toLowerCase() === "websocket"
          const init: RequestInit & { duplex?: string } = { method: request.method, headers }
          if (!isUpgrade && request.method !== "GET" && request.method !== "HEAD") {
            init.body = webRequest?.body ?? null
            init.duplex = "half"
          }
          const target = `${executorBase}/${encodeURIComponent(workspaceId)}${url.pathname}${url.search}`
          const started = Date.now()
          const response = (yield* Effect.promise(() => fetch(target, init))) as Response & { webSocket?: WebSocket | null }
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
      } satisfies WorkspaceShape & { fetch: unknown }
    })
  }),
)
