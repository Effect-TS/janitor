import { JanitorApi } from "@janitor/domain/Api"
import {
  type McpServer,
  type McpServerConfig,
  McpOAuthUnavailable,
  McpServerNotFound,
  McpServerWrongAuth,
} from "@janitor/domain/Chat/McpServer"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { McpCredentials } from "../Chat/McpCredential.ts"
import { McpServerStore } from "../Chat/McpServerStore.ts"

/**
 * The dashboard's MCP servers (EFF-3443), behind Access like the kill
 * switch: anyone signed in may configure them. Configuration is in
 * Postgres, each server's credential in its own Durable Object. A bearer
 * token is written, never read back, and nothing logs more than a server's
 * id and name. Infrastructure failures die.
 */

/** The page the authorisation server's redirect ends on: it returns to the chat sessions page. */
const CONNECTED_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="2; url=/chat/sessions">
    <title>Connected</title>
  </head>
  <body>
    <p>The MCP server is connected. Returning to <a href="/chat/sessions">chat sessions</a>.</p>
  </body>
</html>
`

const publicOrigin = Config.option(Config.NonEmptyString("PUBLIC_ORIGIN"))

/** Where the authorisation server sends the browser back to, from the deployment's public origin. */
const redirectUri = (origin: string, id: string) =>
  `${origin.replace(/\/$/, "")}/api/v1/chat/mcp-servers/${encodeURIComponent(id)}/oauth/callback`

export const McpServersGroupLayer = HttpApiBuilder.group(JanitorApi, "mcpServers", (handlers) =>
  Effect.gen(function* () {
    const withStatus = (server: McpServerConfig) =>
      Effect.gen(function* () {
        if (server.auth === "none") return { ...server, status: "connected" } satisfies McpServer
        const credentials = yield* McpCredentials
        const credential = yield* credentials.forServer(server)
        return { ...server, status: yield* credential.status } satisfies McpServer
      })

    const find = (id: string) =>
      McpServerStore.use((store) => store.get(id)).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new McpServerNotFound({ id })),
            onSome: Effect.succeed,
          }),
        ),
      )

    const credentialOf = (server: McpServerConfig) =>
      McpCredentials.use((credentials) => credentials.forServer(server))

    const logged = (message: string, server: Pick<McpServerConfig, "id" | "name">) =>
      Effect.logInfo(message).pipe(
        Effect.annotateLogs({ serverId: server.id, server: server.name }),
      )

    return handlers
      .handle("list", () =>
        McpServerStore.use((store) => store.list).pipe(
          Effect.orDie,
          Effect.flatMap((servers) => Effect.forEach(servers, withStatus)),
          Effect.map((servers) => ({ servers })),
        ),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const server = yield* McpServerStore.use((store) => store.create(payload)).pipe(
            Effect.catchTag("SqlError", Effect.die),
          )
          yield* logged("MCP server added", server)
          return yield* withStatus(server)
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const updated = yield* McpServerStore.use((store) =>
            store.update(params.id, payload),
          ).pipe(Effect.orDie)
          if (Option.isNone(updated)) return yield* new McpServerNotFound({ id: params.id })
          yield* logged("MCP server changed", updated.value).pipe(
            Effect.annotateLogs({ ...payload }),
          )
          return yield* withStatus(updated.value)
        }),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          const server = yield* find(params.id)
          // The credential goes first: a failed wipe leaves the server listed, to delete again.
          yield* Effect.flatMap(credentialOf(server), (credential) => credential.wipe)
          yield* McpServerStore.use((store) => store.remove(server.id)).pipe(Effect.orDie)
          yield* logged("MCP server deleted", server)
        }),
      )
      .handle("setBearer", ({ params, payload }) =>
        Effect.gen(function* () {
          const server = yield* find(params.id)
          if (server.auth !== "bearer") return yield* new McpServerWrongAuth({ auth: server.auth })
          yield* Effect.flatMap(credentialOf(server), (credential) =>
            credential.setBearer(payload.token),
          )
          yield* logged("MCP server bearer token set", server)
          return yield* withStatus(server)
        }),
      )
      .handle("startOAuth", ({ params }) =>
        Effect.gen(function* () {
          const server = yield* find(params.id)
          if (server.auth !== "oauth") return yield* new McpServerWrongAuth({ auth: server.auth })
          const origin = yield* publicOrigin.pipe(Effect.orDie)
          if (Option.isNone(origin)) return yield* new McpOAuthUnavailable()
          const credential = yield* credentialOf(server)
          const authorizationUrl = yield* credential.startOAuth({
            redirectUri: redirectUri(origin.value, server.id),
          })
          yield* logged("MCP server Connect started", server)
          return { authorizationUrl }
        }),
      )
      .handle("finishOAuth", ({ params, query }) =>
        Effect.gen(function* () {
          const server = yield* find(params.id)
          const credential = yield* credentialOf(server)
          yield* credential.finishOAuth(query)
          yield* logged("MCP server connected", server)
          return CONNECTED_PAGE
        }),
      )
  }),
)
