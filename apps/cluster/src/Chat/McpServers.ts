import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServerConfig } from "@janitor/domain/Chat/McpServer"
import * as McpServersLayer from "clanka/McpServers"
import * as SlackWebApi from "@effect/chat-slack/SlackWebApi"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import { McpCredentials } from "./McpCredential.ts"
import { fetchVia } from "./McpFetch.ts"
import { McpServerStore } from "./McpServerStore.ts"
import type { ChatThread } from "@janitor/domain/Chat/Session"
import { SlackConfig } from "./Slack/Config.ts"

/**
 * The MCP servers configured on the dashboard, in chat turns (EFF-3443).
 * Every tool of each enabled server is offered, as `mcp.<name>.<tool>`, to
 * the turn and its sub-agents. A private server is offered only in Slack
 * channels that hold no one from outside the workspace; any other server in
 * every thread. The connections run in the Worker, and each request gets
 * its token from the server's credential there, so no token reaches the
 * sandbox, the model or the logs.
 */

/** A channel named for a guest organisation, whatever its flags say. */
const EXTERNAL_PREFIX = "effectful-x-"

/** Each flag is required: a missing one doesn't count as false. */
const ChannelInfo = Schema.Struct({
  channel: Schema.Struct({
    name: Schema.String,
    is_shared: Schema.Boolean,
    is_ext_shared: Schema.Boolean,
    is_org_shared: Schema.Boolean,
    is_pending_ext_shared: Schema.Boolean,
  }),
})

export class ChatMcpServers extends Context.Service<
  ChatMcpServers,
  {
    /**
     * Whether a thread may have private servers: a Slack channel of our
     * workspace whose `conversations.info` sets every sharing flag to false
     * and whose name doesn't start with `effectful-x-`. Anything else, a
     * failed lookup included, is no. A rate limit is no at once, never
     * waited out.
     */
    readonly internal: (thread: ChatThread) => Effect.Effect<boolean>
    /**
     * A turn's servers, read from the dashboard's configuration: every
     * enabled server, the private ones only when `internal` says yes, which
     * is asked only if there is one. Undefined when there are none, or the
     * configuration can't be read, so no private server is offered unchecked.
     * The layer connects them while it's built: one turn's worth.
     */
    readonly forTurn: (
      internal: Effect.Effect<boolean>,
    ) => Effect.Effect<Layer.Layer<McpServersLayer.McpServers> | undefined>
  }
>()("@janitor/cluster/Chat/McpServers/ChatMcpServers") {
  /** Without Slack: no thread is internal, so only non-private servers are offered. */
  static readonly layerWithoutSlack: Layer.Layer<
    ChatMcpServers,
    never,
    HttpClient.HttpClient | McpServerStore | McpCredentials
  > = Layer.effect(
    this,
    make(() => Effect.succeed(false)),
  )

  static readonly layer: Layer.Layer<
    ChatMcpServers,
    never,
    SlackConfig | HttpClient.HttpClient | McpServerStore | McpCredentials
  > = Layer.effect(
    this,
    Effect.gen(function* () {
      const slack = yield* SlackConfig
      const api = yield* SlackWebApi.SlackWebApi
      return yield* make((thread) =>
        thread._tag !== "Slack" || thread.team !== slack.workspaceId
          ? Effect.succeed(false)
          : api.call("conversations.info", { channel: thread.channel }, { retry: false }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ChannelInfo)),
              Effect.map(
                ({ channel }) =>
                  !channel.is_shared &&
                  !channel.is_ext_shared &&
                  !channel.is_org_shared &&
                  !channel.is_pending_ext_shared &&
                  !channel.name.startsWith(EXTERNAL_PREFIX),
              ),
              Effect.catch((error) =>
                Effect.logWarning("Couldn't classify a Slack channel for private MCP servers").pipe(
                  Effect.annotateLogs({ reason: error.message }),
                  Effect.as(false),
                ),
              ),
            ),
      )
    }),
  ).pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const slack = yield* SlackConfig
          return SlackWebApi.layer({ botToken: slack.botToken })
        }),
      ),
    ),
  )
}

function make(internal: (thread: ChatThread) => Effect.Effect<boolean>) {
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const store = yield* McpServerStore
    const credentials = yield* McpCredentials
    /** What the layer was built with, which each MCP request runs with. */
    const services = yield* Effect.context<never>()

    const transport = (server: McpServerConfig) =>
      Effect.map(
        server.auth === "none" ? Effect.succeed(undefined) : credentials.forServer(server),
        (credential) => ({
          transport: () =>
            new StreamableHTTPClientTransport(new URL(server.url), {
              fetch: fetchVia(http, services, { credential, withoutErrorBodies: true }),
            }),
        }),
      )

    const forTurn = (isInternal: Effect.Effect<boolean>) =>
      Effect.gen(function* () {
        const configured = yield* store.list.pipe(
          Effect.map((servers) => servers.filter((server) => server.enabled)),
          Effect.catch((error) =>
            Effect.logWarning("Couldn't read the MCP servers; the turn gets none", error).pipe(
              Effect.as([]),
            ),
          ),
        )
        const allowPrivate = configured.some((server) => server.private) ? yield* isInternal : false
        const offered = configured.filter((server) => allowPrivate || !server.private)
        if (offered.length === 0) return undefined
        const entries = yield* Effect.forEach(offered, (server) =>
          Effect.map(transport(server), (config) => [server.name, config] as const),
        )
        return McpServersLayer.layerTransports(Object.fromEntries(entries))
      })

    return ChatMcpServers.of({ internal, forTurn })
  })
}
