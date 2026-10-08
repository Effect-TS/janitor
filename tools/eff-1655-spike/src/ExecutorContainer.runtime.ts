import * as Dockerfile from "alchemy/Docker/Dockerfile"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { ExecutorContainer } from "./ExecutorContainer.ts"

/**
 * Container guest: serves clanka's `AgentExecutor.layerRpcServer` over two
 * Effect RPC protocols, both carried by the container's `fetch` handler:
 *
 *   POST /rpc  — RpcServer HTTP protocol (ndjson, streamed responses)
 *   GET  /ws   — RpcServer WebSocket protocol (upgrade)
 *
 * Each protocol gets its own executor instance; they share /workspace.
 */
const startedAt = Date.now()

export default ExecutorContainer.make(
  {
    main: import.meta.url,
    runtime: "node",
    // janitor's real image adds git + ripgrep via apt; the spike does not
    // need them, and apt cannot drop privileges inside a rootless podman build
    // on this machine (seteuid 42 failed), so the step is left out.
    dockerfile: Dockerfile.inline`
      FROM node:24-bookworm-slim
      RUN mkdir -p /workspace && printf '# Spike workspace\\n\\nThis AGENTS.md lives inside the container.\\n' > /workspace/AGENTS.md
      WORKDIR /workspace
    `,
  },
  Effect.gen(function* () {
    const http = yield* RpcServer.makeProtocolWithHttpEffect().pipe(
      Effect.provide(RpcSerialization.layerNdjson),
    )
    const ws = yield* RpcServer.makeProtocolWithHttpEffectWebsocket.pipe(
      Effect.provide(RpcSerialization.layerNdjson),
    )
    // The executor servers live for the whole container process.
    const scope = yield* Scope.make()
    yield* Layer.build(
      AgentExecutor.layerRpcServer({ directory: "/workspace" }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, http.protocol)),
      ),
    ).pipe(Scope.provide(scope))
    yield* Layer.build(
      AgentExecutor.layerRpcServer({ directory: "/workspace" }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, ws.protocol)),
      ),
    ).pipe(Scope.provide(scope))

    return ExecutorContainer.of({
      ping: () => Effect.succeed(`pong from pid ${process.pid}`),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://container")
        // RpcClient.layerProtocolHttp posts to `${url}/`, i.e. with a trailing
        // slash; normalise so both spellings reach the protocol.
        const path = url.pathname.replace(/\/+$/, "") || "/"
        if (path === "/rpc") return yield* http.httpEffect
        if (path === "/ws") return yield* ws.httpEffect
        if (path === "/health") {
          return HttpServerResponse.jsonUnsafe({
            ok: true,
            pid: process.pid,
            startedAt,
            uptimeMs: Date.now() - startedAt,
          })
        }
        return HttpServerResponse.empty({ status: 404 })
      }),
    })
  }),
)
