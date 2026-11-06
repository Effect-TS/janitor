import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import * as McpServers from "clanka/McpServers"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import type { ChatThread } from "./Platform.ts"
import { decode, SlackApi } from "./Slack/Api.ts"
import { SlackConfig } from "./Slack/Config.ts"

/**
 * Attio's hosted MCP server in chat turns (EFF-3443). Every tool the server
 * lists is offered, to the turn and its sub-agents, in Slack channels no one
 * outside the workspace is in. The bearer token stays in the Worker: the MCP
 * transport sends its requests through the Worker's `HttpClient`, which adds
 * it.
 */

export interface AttioSettings {
  readonly token: Redacted.Redacted<string>
  readonly url: string
}

/**
 * `ATTIO_MCP_TOKEN` and `ATTIO_MCP_URL`, which defaults to Attio's server.
 * Attio is off while the token is unset.
 */
export const attioSettings: Config.Config<Option.Option<AttioSettings>> = Config.option(
  Config.all({
    token: Config.Redacted("ATTIO_MCP_TOKEN"),
    url: Config.String("ATTIO_MCP_URL").pipe(Config.withDefault("https://mcp.attio.com/mcp")),
  }),
)

/** The name the server is offered under: `mcp.attio.<tool>`. */
const SERVER = "attio"

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

/**
 * A `fetch` over `http`, for the MCP SDK's transport. Each response lives
 * until the transport aborts the request's signal, which it does on close, so
 * an open event stream ends with the turn.
 */
const fetchVia =
  (http: HttpClient.HttpClient): typeof globalThis.fetch =>
  (input, init) => {
    const request = new Request(input, init)
    const scope = Scope.makeUnsafe()
    const release = () => Effect.runFork(Scope.close(scope, Exit.void))
    if (request.signal.aborted) release()
    else request.signal.addEventListener("abort", release, { once: true })
    return Effect.runPromise(
      Effect.gen(function* () {
        const body =
          request.body === null ? undefined : yield* Effect.tryPromise(() => request.text())
        const outgoing = HttpClientRequest.make(request.method as "GET")(request.url, {
          headers: request.headers,
        }).pipe(
          body === undefined
            ? (self) => self
            : HttpClientRequest.bodyText(body, request.headers.get("content-type") ?? undefined),
        )
        const response = yield* HttpClient.withScope(http)
          .execute(outgoing)
          .pipe(Scope.provide(scope))
        return Option.getOrElse(
          HttpClientResponse.toWeb(response),
          () =>
            new Response(
              response.status === 204 || response.status === 304
                ? null
                : Stream.toReadableStream(response.stream),
              { status: response.status, headers: response.headers as Record<string, string> },
            ),
        )
      }),
      { signal: request.signal },
    )
  }

export class ChatAttio extends Context.Service<
  ChatAttio,
  {
    /**
     * Whether a thread's turns get Attio: a Slack channel of our workspace
     * whose `conversations.info` sets every sharing flag to false and whose
     * name doesn't start with `effectful-x-`. Anything else, a failed lookup
     * included, is no. A rate limit is no at once, never waited out.
     */
    readonly allowed: (thread: ChatThread) => Effect.Effect<boolean>
    /** Attio's server, connected while the layer is built: one turn's worth. */
    readonly servers: Layer.Layer<McpServers.McpServers>
  }
>()("@janitor/cluster/Chat/Attio/ChatAttio") {
  static readonly layer = (
    settings: AttioSettings,
  ): Layer.Layer<ChatAttio, never, SlackConfig | HttpClient.HttpClient> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const slack = yield* SlackConfig
        const api = yield* SlackApi
        const http = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(settings.token))),
        )

        const allowed = (thread: ChatThread): Effect.Effect<boolean> =>
          thread._tag !== "Slack" || thread.team !== slack.workspaceId
            ? Effect.succeed(false)
            : api.call("conversations.info", { channel: thread.channel }, { retry: false }).pipe(
                Effect.flatMap(decode("conversations.info", ChannelInfo)),
                Effect.map(
                  ({ channel }) =>
                    !channel.is_shared &&
                    !channel.is_ext_shared &&
                    !channel.is_org_shared &&
                    !channel.is_pending_ext_shared &&
                    !channel.name.startsWith(EXTERNAL_PREFIX),
                ),
                Effect.catchTag("SlackApiError", (error) =>
                  Effect.logWarning("Couldn't classify a Slack channel for Attio").pipe(
                    Effect.annotateLogs({ reason: error.message }),
                    Effect.as(false),
                  ),
                ),
              )

        const servers = McpServers.layerTransports({
          [SERVER]: {
            transport: () =>
              new StreamableHTTPClientTransport(new URL(settings.url), { fetch: fetchVia(http) }),
          },
        })

        return ChatAttio.of({ allowed, servers })
      }),
    ).pipe(Layer.provide(SlackApi.layer))
}
