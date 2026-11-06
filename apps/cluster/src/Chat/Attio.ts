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
import type { AttioCredential } from "./AttioCredential.ts"
import type { ChatThread } from "./Platform.ts"
import { decode, SlackApi } from "./Slack/Api.ts"
import { SlackConfig } from "./Slack/Config.ts"

/**
 * Attio's hosted MCP server in chat turns (EFF-3443). Every tool the server
 * lists is offered, to the turn and its sub-agents, in Slack channels no one
 * outside the workspace is in. The access tokens stay in the Worker: the MCP
 * transport sends its requests through the Worker's `HttpClient`, and each
 * request gets the current token from the credential (`AttioCredential.ts`).
 */

export interface AttioSettings {
  /** The OAuth client registered with Attio. */
  readonly clientId: string
  /** Only for a client registered as confidential. */
  readonly clientSecret: Option.Option<Redacted.Redacted<string>>
  /** The refresh token from the one-time consent: the seed the stored one descends from. */
  readonly refreshToken: Redacted.Redacted<string>
  readonly url: string
  readonly tokenUrl: string
}

/**
 * `ATTIO_MCP_CLIENT_ID` and `ATTIO_MCP_REFRESH_TOKEN`, both required, and the
 * optional `ATTIO_MCP_CLIENT_SECRET`, `ATTIO_MCP_URL` and
 * `ATTIO_OAUTH_TOKEN_URL`, whose defaults are Attio's. Attio is off until
 * the client id and the refresh token are both set.
 */
export const attioSettings: Config.Config<Option.Option<AttioSettings>> = Config.option(
  Config.all({
    clientId: Config.String("ATTIO_MCP_CLIENT_ID"),
    clientSecret: Config.option(Config.Redacted("ATTIO_MCP_CLIENT_SECRET")),
    refreshToken: Config.Redacted("ATTIO_MCP_REFRESH_TOKEN"),
    url: Config.String("ATTIO_MCP_URL").pipe(Config.withDefault("https://mcp.attio.com/mcp")),
    tokenUrl: Config.String("ATTIO_OAUTH_TOKEN_URL").pipe(
      Config.withDefault("https://app.attio.com/oidc/token"),
    ),
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

/** Thrown by `fetchVia` when there's no access token: the MCP request fails, unsent. */
const UNAVAILABLE = "Attio's credential is unavailable"

/**
 * A `fetch` over `http`, for the MCP SDK's transport, that sends each
 * request with the credential's current access token. Each response lives
 * until the transport aborts the request's signal, which it does on close, so
 * an open event stream ends with the turn.
 *
 * A 401 reports the token rejected, so the next request gets a new one, and
 * is handed back as it is: the request is never sent again, so no write
 * reaches Attio twice. The SDK fails that request, and a `tools/call` becomes
 * a tool error the model sees.
 */
const fetchVia =
  (http: HttpClient.HttpClient, credential: AttioCredential): typeof globalThis.fetch =>
  (input, init) => {
    const request = new Request(input, init)
    const scope = Scope.makeUnsafe()
    const release = () => Effect.runFork(Scope.close(scope, Exit.void))
    if (request.signal.aborted) release()
    else request.signal.addEventListener("abort", release, { once: true })
    return Effect.runPromise(
      Effect.gen(function* () {
        const token = yield* credential
          .token()
          .pipe(Effect.catchTag("AttioUnavailable", () => Effect.die(new Error(UNAVAILABLE))))
        const body =
          request.body === null ? undefined : yield* Effect.tryPromise(() => request.text())
        const outgoing = HttpClientRequest.make(request.method as "GET")(request.url, {
          headers: request.headers,
        }).pipe(
          HttpClientRequest.bearerToken(token),
          body === undefined
            ? (self) => self
            : HttpClientRequest.bodyText(body, request.headers.get("content-type") ?? undefined),
        )
        const response = yield* HttpClient.withScope(http)
          .execute(outgoing)
          .pipe(Scope.provide(scope))
        if (response.status === 401) yield* Effect.ignore(credential.token(token))
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
  /** `credential` is the Worker's handle on the credential's Durable Object. */
  static readonly layer = (options: {
    readonly url: string
    readonly credential: AttioCredential
  }): Layer.Layer<ChatAttio, never, SlackConfig | HttpClient.HttpClient> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const slack = yield* SlackConfig
        const api = yield* SlackApi
        const http = yield* HttpClient.HttpClient

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
              new StreamableHTTPClientTransport(new URL(options.url), {
                fetch: fetchVia(http, options.credential),
              }),
          },
        })

        return ChatAttio.of({ allowed, servers })
      }),
    ).pipe(Layer.provide(SlackApi.layer))
}
