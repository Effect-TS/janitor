import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Scope from "effect/Scope"
import { createServer } from "node:http"
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Stand-in for the sandbox container's `fetch` handler (see
 * `tools/eff-1655-spike/src/ExecutorContainer.runtime.ts`): the same
 * `AgentExecutor.layerRpcServer` served over the RpcServer HTTP streaming
 * protocol (`POST /:ws/rpc`) and the WebSocket protocol (`GET /:ws/ws`),
 * one executor per workspace id, in a directory under $EXECUTOR_ROOT.
 *
 *   POST /:ws/reset?acquire=N   fresh directory (the "fresh container")
 *   POST /:ws/release           drop the executor and the directory
 *   GET  /:ws/health
 *   GET  /:ws/ls
 */
const port = Number(process.env.EXECUTOR_PORT ?? 3100)
const root = process.env.EXECUTOR_ROOT ?? "/tmp/eff1847-executor"
const startedAt = Date.now()

interface Instance {
  readonly directory: string
  readonly acquire: number
  readonly createdAt: number
  readonly scope: Scope.Closeable
  readonly http: Effect.Effect<HttpServerResponse.HttpServerResponse, any, HttpServerRequest.HttpServerRequest | Scope.Scope>
  readonly ws: Effect.Effect<HttpServerResponse.HttpServerResponse, any, HttpServerRequest.HttpServerRequest | Scope.Scope>
}

const instances = new Map<string, Instance>()
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

const makeInstance = (id: string, acquire: number) =>
  Effect.gen(function* () {
    const directory = join(root, id.replace(/[^a-zA-Z0-9_-]/g, "_"), `acquire-${acquire}`)
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "AGENTS.md"), `# Smoke-test workspace\n\nWorkspace ${id}, acquire ${acquire}. Created ${new Date().toISOString()}.\n`)
    const scope = yield* Scope.make()
    const http = yield* RpcServer.makeProtocolWithHttpEffect().pipe(Effect.provide(RpcSerialization.layerNdjson))
    const ws = yield* RpcServer.makeProtocolWithHttpEffectWebsocket.pipe(Effect.provide(RpcSerialization.layerNdjson))
    const server = (protocol: RpcServer.Protocol["Service"]) =>
      AgentExecutor.layerRpcServer({ directory }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
        Layer.provide(NodeServices.layer),
        Layer.provide(FetchHttpClient.layer),
      )
    yield* Layer.build(server(http.protocol)).pipe(Scope.provide(scope))
    yield* Layer.build(server(ws.protocol)).pipe(Scope.provide(scope))
    const instance: Instance = { directory, acquire, createdAt: Date.now(), scope, http: http.httpEffect, ws: ws.httpEffect }
    instances.set(id, instance)
    log(`[${id}] executor created acquire=${acquire} dir=${directory}`)
    return instance
  })

const dropInstance = (id: string) =>
  Effect.gen(function* () {
    const instance = instances.get(id)
    if (!instance) return false
    instances.delete(id)
    yield* Scope.close(instance.scope, Exit.void)
    rmSync(instance.directory, { recursive: true, force: true })
    log(`[${id}] executor released (acquire=${instance.acquire})`)
    return true
  })

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, "http://executor")
  const [, rawId, ...rest] = url.pathname.split("/")
  const id = decodeURIComponent(rawId ?? "")
  const action = "/" + rest.join("/").replace(/\/+$/, "")
  const started = Date.now()
  const done = (status: number) => log(`[${id}] ${request.method} ${action} -> ${status} (${Date.now() - started}ms)`)
  if (!id) return HttpServerResponse.text("executor: /:ws/{reset|release|health|ls|rpc|ws}", { status: 404 })
  switch (action) {
    case "/reset": {
      const acquire = Number(url.searchParams.get("acquire") ?? "1")
      yield* dropInstance(id)
      const instance = yield* makeInstance(id, acquire)
      done(200)
      return HttpServerResponse.jsonUnsafe({ ok: true, pid: process.pid, acquire, directory: instance.directory, createdAt: instance.createdAt })
    }
    case "/release": {
      const dropped = yield* dropInstance(id)
      done(200)
      return HttpServerResponse.jsonUnsafe({ ok: true, dropped })
    }
    case "/health": {
      const instance = instances.get(id)
      done(200)
      return HttpServerResponse.jsonUnsafe({ ok: true, pid: process.pid, serverStartedAt: startedAt, instance: instance ? { acquire: instance.acquire, createdAt: instance.createdAt, directory: instance.directory } : null })
    }
    case "/ls": {
      const instance = instances.get(id)
      done(200)
      return HttpServerResponse.jsonUnsafe({ files: instance ? readdirSync(instance.directory) : null })
    }
    case "/rpc":
    case "/ws": {
      const instance = instances.get(id)
      if (!instance) {
        done(409)
        return HttpServerResponse.text(`workspace ${id} not provisioned`, { status: 409 })
      }
      log(`[${id}] ${request.method} ${action} (acquire=${instance.acquire}) begin`)
      return yield* (action === "/rpc" ? instance.http : instance.ws)
    }
    default:
      done(404)
      return HttpServerResponse.empty({ status: 404 })
  }
}).pipe(
  Effect.catchCause((cause) => {
    log(`request failed: ${String(cause).slice(0, 500)}`)
    return Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 }))
  }),
)

const ServerLive = HttpServer.serve(app).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
)

mkdirSync(root, { recursive: true })
log(`executor listening on :${port}, root ${root}`)
NodeRuntime.runMain(Layer.launch(ServerLive))
