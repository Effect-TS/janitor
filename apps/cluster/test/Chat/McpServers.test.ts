import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it, layer } from "@effect/vitest"
import type { McpServerConfig } from "@janitor/domain/Chat/McpServer"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as SqlError from "effect/sql/SqlError"
import { type McpCredential, McpCredentials, McpUnavailable } from "../../src/Chat/McpCredential.ts"
import { ChatMcpServers } from "../../src/Chat/McpServers.ts"
import { McpServerStore } from "../../src/Chat/McpServerStore.ts"
import type { ChatThread } from "../../src/Chat/Platform.ts"
import { SlackConfig } from "../../src/Chat/Slack/Config.ts"
import {
  callTool,
  discordThread,
  makeSessionHarnessWith,
  type SessionHarness,
  say,
  seen,
} from "./sessionHarness.ts"

/**
 * The MCP servers configured on the dashboard, in chat turns (EFF-3443).
 * Every tool of each enabled server is offered, to the turn and its
 * sub-agents. A private server is offered only in Slack channels that hold no
 * one from outside the workspace; any other server in every thread. Slack and
 * the MCP servers are one fake behind the `HttpClient` the servers are given,
 * so bearer headers are checked on the HTTP requests themselves. The stored
 * configuration and the access tokens are fakes, which `McpServerStore`'s and
 * `McpCredential`'s tests stand in for. Every fixture is synthetic.
 */

const server = (
  name: string,
  config: Pick<McpServerConfig, "auth" | "private"> & { readonly enabled?: boolean },
): McpServerConfig => ({
  id: `srv-${name}`,
  name,
  url: `https://mcp.${name}.test/mcp`,
  enabled: true,
  ...config,
})

/** Private, as a CRM is: only for internal channels. */
const crm = server("crm", { auth: "oauth", private: true })
/** Not private: for every thread. */
const docs = server("docs", { auth: "bearer", private: false })
/** No authentication, so no credential either. */
const open = server("open", { auth: "none", private: false })
/** Switched off on the dashboard. */
const off = server("off", { auth: "none", private: false, enabled: false })
const configured = [crm, docs, open, off]

/**
 * Hands out `<server>-access-<n>`. `fresh` issues a new token on every call,
 * as a refresh between two requests would; otherwise the token changes only
 * when the current one is reported rejected. `unavailable` fails every call,
 * as a server that was never connected, or needs consent, does.
 */
class FakeCredential implements McpCredential {
  readonly issued: Array<string> = []
  readonly rejected: Array<string> = []

  constructor(
    readonly server: string,
    readonly mode: "fresh" | "stable" | "unavailable",
  ) {}

  private issue() {
    const token = `${this.server}-access-${this.issued.length + 1}`
    this.issued.push(token)
    return token
  }

  readonly token = (rejected?: Redacted.Redacted<string>) =>
    Effect.suspend(() => {
      if (this.mode === "unavailable") return Effect.fail(new McpUnavailable())
      if (rejected !== undefined) this.rejected.push(Redacted.value(rejected))
      const current = this.issued.at(-1)
      const token =
        current === undefined ||
        this.mode === "fresh" ||
        (rejected !== undefined && Redacted.value(rejected) === current)
          ? this.issue()
          : current
      return Effect.succeed(Redacted.make(token))
    })

  /** Configuring a server is the dashboard's, never a turn's. */
  readonly status = Effect.die("A turn read a credential's status")
  readonly setBearer = () => Effect.die("A turn set a bearer token")
  readonly startOAuth = () => Effect.die("A turn started OAuth")
  readonly finishOAuth = () => Effect.die("A turn finished OAuth")
  readonly wipe = Effect.die("A turn wiped a credential")
}

/** Each server's credential; `open` and `off` have none to give. */
const credentialsFor = (modes: { readonly crm?: FakeCredential["mode"] | undefined } = {}) => ({
  crm: new FakeCredential("crm", modes.crm ?? "fresh"),
  docs: new FakeCredential("docs", "fresh"),
  open: new FakeCredential("open", "unavailable"),
  off: new FakeCredential("off", "unavailable"),
})
type Credentials = ReturnType<typeof credentialsFor>

/** `conversations.info`'s flags for a channel no one outside the workspace is in. */
const internal = {
  is_shared: false,
  is_ext_shared: false,
  is_org_shared: false,
  is_pending_ext_shared: false,
}

/** What the fake Web API knows of each channel. Any other channel is `channel_not_found`. */
const channels: Record<string, () => Response> = {
  CPUBLIC: () =>
    Response.json({
      ok: true,
      channel: { id: "CPUBLIC", name: "general", is_private: false, ...internal },
    }),
  CPRIVATE: () =>
    Response.json({
      ok: true,
      channel: { id: "CPRIVATE", name: "sales", is_private: true, ...internal },
    }),
  ...Object.fromEntries(
    Object.keys(internal).map((flag) => [
      `C-${flag}`,
      () =>
        Response.json({
          ok: true,
          channel: { id: `C-${flag}`, name: "partners", ...internal, [flag]: true },
        }),
    ]),
  ),
  CEXTERNAL: () =>
    Response.json({
      ok: true,
      channel: { id: "CEXTERNAL", name: "effectful-x-acme", ...internal },
    }),
  CUNFLAGGED: () => {
    const { is_pending_ext_shared: _, ...flags } = internal
    return Response.json({ ok: true, channel: { id: "CUNFLAGGED", name: "general", ...flags } })
  },
  CTHROTTLED: () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
}

/** One request a fake MCP server received. */
interface McpRequest {
  readonly server: string
  readonly method: string
  readonly authorization: string | null
  /** The JSON-RPC method, for a POST. */
  readonly rpc: string | undefined
  readonly params: unknown
}

/**
 * Slack's Web API and each configured MCP server over streamable HTTP,
 * answering JSON. Each MCP server lists one tool, `whoami`, and accepts only
 * the tokens its own credential issued; `open` and `off` accept any request.
 */
class FakeHttp {
  readonly mcp: Array<McpRequest> = []
  /** A `tools/call` bearing this token is answered 401, as a server does once it revoked it. */
  rejectCallsWith: string | undefined
  /** crm's requests for this JSON-RPC method are answered with this status, as a failing server does. */
  failCrm: { readonly rpc: string; readonly status: number } | undefined

  constructor(readonly credentials: Credentials) {}

  /** An error body that echoes the request's credential, as some servers' errors do. */
  private echo(status: number, authorization: string | null, headers?: Record<string, string>) {
    return new Response(`upstream failed for authorization: ${authorization}`, {
      status,
      ...(headers === undefined ? {} : { headers }),
    })
  }

  private answerMcp(
    server: McpServerConfig,
    method: string,
    authorization: string | null,
    body: string,
  ): Response {
    if (method !== "POST") {
      this.mcp.push({
        server: server.name,
        method,
        authorization,
        rpc: undefined,
        params: undefined,
      })
      return new Response(null, { status: 405 })
    }
    const message = JSON.parse(body) as {
      readonly id?: number | string
      readonly method: string
      readonly params?: { readonly protocolVersion?: string }
    }
    this.mcp.push({
      server: server.name,
      method,
      authorization,
      rpc: message.method,
      params: message.params,
    })
    const token = authorization?.match(/^Bearer (.+)$/)?.[1]
    if (server.name === "crm" && message.method === this.failCrm?.rpc)
      return this.echo(this.failCrm.status, authorization)
    if (
      server.auth !== "none" &&
      (token === undefined ||
        !this.credentials[server.name as keyof Credentials].issued.includes(token) ||
        (message.method === "tools/call" && token === this.rejectCallsWith))
    )
      return this.echo(401, authorization, { "www-authenticate": 'Bearer scope="mcp"' })
    if (message.id === undefined) return new Response(null, { status: 202 })
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: `${server.name}-fake`, version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "whoami",
                  description: "The member the token belongs to.",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "Synthetic Member, Example Workspace" }] }
            : undefined
    return Response.json(
      result === undefined
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
        : { jsonrpc: "2.0", id: message.id, result },
    )
  }

  get layer() {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen({ self: this }, function* () {
          const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
          const body = yield* Effect.promise(() => web.text())
          const url = new URL(web.url)
          const mcpServer = configured.find((server) => server.url === url.href)
          if (mcpServer !== undefined)
            return HttpClientResponse.fromWeb(
              request,
              this.answerMcp(mcpServer, web.method, web.headers.get("authorization"), body),
            )
          if (url.hostname === "slack.com" && url.pathname === "/api/conversations.info") {
            const channel = new URLSearchParams(body).get("channel") ?? ""
            const answer = channels[channel]
            return HttpClientResponse.fromWeb(
              request,
              answer === undefined
                ? Response.json({ ok: false, error: "channel_not_found" })
                : answer(),
            )
          }
          return HttpClientResponse.fromWeb(request, Response.json({ ok: true }))
        }),
      ),
    )
  }
}

const slackConfig = SlackConfig.layerFrom({
  signingSecret: Redacted.make("synthetic-signing-secret"),
  botToken: Redacted.make("xoxb-synthetic"),
  workspaceId: "T1",
  appId: "A1",
})

/** The stored servers, or a failed read of them. */
type Stored = ReadonlyArray<McpServerConfig> | "failing"

/** The integration on `http`, as the Worker builds it once chat is on. */
const mcpServers = (http: FakeHttp, stored: Stored = configured) =>
  ChatMcpServers.layer.pipe(
    Layer.provide([
      slackConfig,
      http.layer,
      Layer.mock(McpServerStore)({
        list:
          stored === "failing"
            ? Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.ConnectionError({
                    cause: new Error("connection refused"),
                    message: "Postgres is unreachable",
                  }),
                }),
              )
            : Effect.succeed(stored),
      }),
      Layer.succeed(
        McpCredentials,
        McpCredentials.of({
          forServer: (server) => Effect.succeed(http.credentials[server.name as keyof Credentials]),
        }),
      ),
    ]),
  )

const inChannel = (channel: string): ChatThread => ({
  _tag: "Slack",
  team: "T1",
  channel,
  threadTs: "1700000000.000100",
})

describe("ChatMcpServers.internal", () => {
  const cases: ReadonlyArray<readonly [string, ChatThread, boolean]> = [
    ["an internal public channel", inChannel("CPUBLIC"), true],
    ["an internal private channel", inChannel("CPRIVATE"), true],
    ["a Discord thread", discordThread, false],
    ...Object.keys(internal).map((flag): readonly [string, ChatThread, boolean] => [
      `a channel with ${flag}`,
      inChannel(`C-${flag}`),
      false,
    ]),
    ["an effectful-x- channel with no sharing flag set", inChannel("CEXTERNAL"), false],
    ["a channel whose answer lacks is_pending_ext_shared", inChannel("CUNFLAGGED"), false],
    ["a channel Slack can't find", inChannel("CMISSING"), false],
    ["a rate-limited lookup, without waiting out Retry-After", inChannel("CTHROTTLED"), false],
  ]

  for (const [name, thread, expected] of cases)
    it.effect(`${expected ? "allows" : "denies"} private servers in ${name}`, () =>
      Effect.gen(function* () {
        const http = new FakeHttp(credentialsFor())
        const allowed = yield* Effect.gen(function* () {
          const service = yield* ChatMcpServers
          return yield* service.internal(thread)
        }).pipe(Effect.provide(mcpServers(http)))
        assert.strictEqual(allowed, expected)
        assert.deepStrictEqual(http.mcp, [], "deciding never reaches an MCP server")
      }),
    )
})

/** The deployment's environment; the bot is on while the API URL and key are set. */
const Services = NodeServices.layer.pipe(
  Layer.provideMerge(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CHAT_AI_API_URL: "https://ai.test/v1",
        CHAT_AI_API_KEY: "test-key",
      }),
    ),
  ),
)

layer(Services, { timeout: "2 minutes" })("MCP servers in a chat session", (it) => {
  /**
   * One turn in `thread` whose scripts call `whoami` on each of `servers`, in
   * order, before replying, with the logs it wrote.
   */
  const whoamiTurn = (
    thread: ChatThread,
    servers: ReadonlyArray<string>,
    options: {
      readonly credentials?: Credentials
      readonly stored?: Stored
      readonly rejectCallsWith?: string
      readonly failCrm?: FakeHttp["failCrm"]
    } = {},
  ) => {
    const http = new FakeHttp(options.credentials ?? credentialsFor())
    http.rejectCallsWith = options.rejectCallsWith
    http.failCrm = options.failCrm
    const logs: Array<string> = []
    const capture = Logger.layer([
      Logger.make((options) => {
        logs.push(Logger.formatJson.log(options))
      }),
    ])
    return Effect.gen(function* () {
      const harness: SessionHarness = yield* makeSessionHarnessWith(
        mcpServers(http, options.stored),
      )
      const message = yield* harness.message("Who is janitor in each tool?", { mention: true })
      yield* harness.deliver(thread, message)
      yield* harness.until(
        Effect.sync(() => harness.model.prompts.length >= 1),
        "the first model call",
      )
      harness.model.answer(
        ...servers.map((name) => callTool(`mcp.${name}.whoami`, {})),
        say("Done."),
      )
      yield* harness.until(
        Effect.sync(() => harness.platform.replies.length > 0),
        "the reply",
      )
      return { harness, http, logs }
    }).pipe(Effect.scoped, Effect.provide(capture))
  }

  const toolCalls = (http: FakeHttp, server: string) =>
    http.mcp.filter((request) => request.server === server && request.rpc === "tools/call")

  /** Asserts none of `credentials`' tokens reached the model, the sandbox or the logs. */
  const assertNoTokenLeft = (
    { harness, logs }: { readonly harness: SessionHarness; readonly logs: ReadonlyArray<string> },
    credentials: Credentials,
  ) => {
    const exposed = [
      ...harness.model.prompts.map(seen),
      ...harness.sandboxes.scripts,
      ...harness.sandboxes.written.map((file) => new TextDecoder().decode(file.content)),
      ...harness.sandboxes.toolOutcomes,
      ...logs,
    ]
    const tokens = [...credentials.crm.issued, ...credentials.docs.issued]
    assert.isNotEmpty(credentials.crm.issued)
    for (const text of exposed) for (const token of tokens) assert.notInclude(text, token)
  }

  const outcome = (name: string, offered: boolean) =>
    offered ? "ok" : `failed: no loop-side tool ${name}.whoami`

  /** Which servers a turn is offered, and never reaches the others. */
  const choices: ReadonlyArray<
    readonly [
      string,
      ChatThread,
      { readonly stored?: Stored; readonly crm?: FakeCredential["mode"] },
      ReadonlyArray<string>,
    ]
  > = [
    ["an internal channel", inChannel("CPUBLIC"), {}, ["crm", "docs", "open"]],
    ["a Discord thread", discordThread, {}, ["docs", "open"]],
    ["a shared channel", inChannel("C-is_ext_shared"), {}, ["docs", "open"]],
    ["a channel that couldn't be classified", inChannel("CMISSING"), {}, ["docs", "open"]],
    [
      "an internal channel, while crm has no usable credential",
      inChannel("CPUBLIC"),
      { crm: "unavailable" },
      ["docs", "open"],
    ],
    ["a turn whose server list can't be read", inChannel("CPUBLIC"), { stored: "failing" }, []],
  ]
  for (const [name, thread, options, offered] of choices)
    it.effect(`${name} is offered ${offered.length === 0 ? "no server" : offered.join(", ")}`, () =>
      Effect.gen(function* () {
        const names = configured.map((server) => server.name)
        const { harness, http } = yield* whoamiTurn(thread, names, {
          credentials: credentialsFor({ crm: options.crm }),
          ...(options.stored === undefined ? {} : { stored: options.stored }),
        })

        assert.deepStrictEqual(
          harness.sandboxes.toolOutcomes,
          names.map((name) => outcome(name, offered.includes(name))),
        )
        assert.deepStrictEqual(
          [...new Set(http.mcp.map((request) => request.server))].sort(),
          [...offered].sort(),
          "a server not offered is never reached",
        )
      }),
    )

  it.effect(
    "each request carries a token fetched for it from its own server's credential, and none leaves the Worker",
    () =>
      Effect.gen(function* () {
        const credentials = credentialsFor()
        const { harness, http, logs } = yield* whoamiTurn(
          inChannel("CPUBLIC"),
          ["crm", "docs", "crm", "open"],
          { credentials },
        )

        assert.deepStrictEqual(harness.sandboxes.toolOutcomes, ["ok", "ok", "ok", "ok"])
        for (const name of ["crm", "docs"] as const) {
          const requests = http.mcp.filter((request) => request.server === name)
          for (const request of requests)
            assert.match(request.authorization ?? "", new RegExp(`^Bearer ${name}-access-\\d+$`))
          const initialize = requests.find((request) => request.rpc === "initialize")
          assert.notStrictEqual(
            toolCalls(http, name)[0]!.authorization,
            initialize?.authorization,
            "a token that changed after initialize is the one tools/call sends",
          )
        }
        const [first, second] = toolCalls(http, "crm")
        assert.notStrictEqual(first!.authorization, second!.authorization)
        assert.deepStrictEqual(
          toolCalls(http, "open").map((request) => [request.authorization, request.params]),
          [[null, { name: "whoami", arguments: {} }]],
          "auth: none sends no credential",
        )
        assert.isNotEmpty(credentials.docs.issued)
        assertNoTokenLeft({ harness, logs }, credentials)
      }),
  )

  it.effect(
    "a rejected token fails that tool call once, without a retry or a leak, and the next call uses a new token",
    () =>
      Effect.gen(function* () {
        const credentials = credentialsFor({ crm: "stable" })
        const { harness, http, logs } = yield* whoamiTurn(inChannel("CPUBLIC"), ["crm", "crm"], {
          credentials,
          rejectCallsWith: "crm-access-1",
        })

        assert.strictEqual(harness.sandboxes.toolOutcomes.length, 2)
        assert.match(harness.sandboxes.toolOutcomes[0]!, /^failed: /)
        assert.strictEqual(harness.sandboxes.toolOutcomes[1], "ok")
        assert.deepStrictEqual(
          toolCalls(http, "crm").map((request) => request.authorization),
          ["Bearer crm-access-1", "Bearer crm-access-2"],
        )
        assert.deepStrictEqual(credentials.crm.rejected, ["crm-access-1"])
        assert.deepStrictEqual(credentials.docs.rejected, [])
        assertNoTokenLeft({ harness, logs }, credentials)
      }),
  )

  /** crm failing with an error body that echoes its token; docs still answers. */
  const failures: ReadonlyArray<readonly [string, NonNullable<FakeHttp["failCrm"]>]> = [
    ["a tool call answered 500", { rpc: "tools/call", status: 500 }],
    ["a connection answered 500", { rpc: "initialize", status: 500 }],
  ]
  for (const [name, failCrm] of failures)
    it.effect(
      `${name} fails crm's call without a retry, and its body never leaves the Worker`,
      () =>
        Effect.gen(function* () {
          const credentials = credentialsFor()
          const turn = yield* whoamiTurn(inChannel("CPUBLIC"), ["crm", "docs"], {
            credentials,
            failCrm,
          })

          assert.match(turn.harness.sandboxes.toolOutcomes[0]!, /^failed: /)
          assert.strictEqual(turn.harness.sandboxes.toolOutcomes[1], "ok")
          assert.isAtMost(toolCalls(turn.http, "crm").length, 1)
          assert.deepStrictEqual(credentials.crm.rejected, [], "only a 401 rejects a token")
          assertNoTokenLeft(turn, credentials)
        }),
    )
})
