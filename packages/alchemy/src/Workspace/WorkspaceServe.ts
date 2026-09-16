import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { serveRpc } from "alchemy/Rpc"
import * as Effect from "effect/Effect"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
// NodeHttpServer requires Node's server constructor.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from "node:http"
import { layerWorktree } from "../Git/CheckoutsWorktree.ts"
import { makeWorkspaceHost } from "./WorkspaceHost.ts"

/** One host process owns the worktree directory and its checkout locks. */
export const serveWorkspace = Effect.fnUntraced(function* (options: {
  readonly root: string
  readonly port?: number
}) {
  const host = yield* makeWorkspaceHost.pipe(Effect.provide(layerWorktree({ root: options.root })))
  const server = yield* NodeHttpServer.make(createServer, {
    host: "127.0.0.1",
    port: options.port ?? 0,
  })
  const rpc = serveRpc(host, Effect.succeed(HttpServerResponse.empty({ status: 404 })))
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest
      // Browser pages must not be able to issue shell commands to the dev host.
      if (request.headers.origin !== undefined) return HttpServerResponse.empty({ status: 403 })
      if (request.method === "GET" && request.url === "/health")
        return HttpServerResponse.text("ok")
      if (
        request.method !== "POST" ||
        !request.headers["content-type"]?.startsWith("application/json")
      ) {
        return HttpServerResponse.empty({ status: 405 })
      }
      return yield* rpc
    }),
  )
  if (server.address._tag !== "TcpAddress")
    return yield* Effect.die("workspace server requires TCP")
  return `http://127.0.0.1:${server.address.port}`
}, Effect.provide(NodeServices.layer))
