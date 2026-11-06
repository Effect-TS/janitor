import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it, layer } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { attioSettings, ChatAttio } from "../../src/Chat/Attio.ts"
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
 * The Attio MCP integration (EFF-3443): Attio's hosted MCP server, with all
 * of its tools, in Slack channels that hold no one from outside the
 * workspace. Slack and Attio are one fake behind the `HttpClient` the
 * integration is given, so the bearer header is checked on the HTTP requests
 * themselves. Every fixture is synthetic.
 */

const TOKEN = "attio-synthetic-token-7f3a"
const MCP_URL = "https://mcp.attio.test/mcp"

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

/** One request the fake Attio MCP server received. */
interface McpRequest {
  readonly method: string
  readonly authorization: string | null
  /** The JSON-RPC method, for a POST. */
  readonly rpc: string | undefined
  readonly params: unknown
}

/**
 * Slack's Web API and Attio's MCP server over streamable HTTP, answering
 * JSON. The MCP server lists one tool, `whoami`.
 */
class FakeHttp {
  readonly mcp: Array<McpRequest> = []
  readonly lookups: Array<string> = []

  private answerMcp(method: string, authorization: string | null, body: string): Response {
    if (method !== "POST") {
      this.mcp.push({ method, authorization, rpc: undefined, params: undefined })
      return new Response(null, { status: 405 })
    }
    const message = JSON.parse(body) as {
      readonly id?: number | string
      readonly method: string
      readonly params?: { readonly protocolVersion?: string }
    }
    this.mcp.push({ method, authorization, rpc: message.method, params: message.params })
    if (authorization !== `Bearer ${TOKEN}`)
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer scope="mcp"' },
      })
    if (message.id === undefined) return new Response(null, { status: 202 })
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "attio-fake", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "whoami",
                  description: "The Attio member the token belongs to.",
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
          if (url.href === MCP_URL)
            return HttpClientResponse.fromWeb(
              request,
              this.answerMcp(web.method, web.headers.get("authorization"), body),
            )
          if (url.hostname === "slack.com" && url.pathname === "/api/conversations.info") {
            const channel = new URLSearchParams(body).get("channel") ?? ""
            this.lookups.push(channel)
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

/** The integration on `http`, as the Worker builds it once Slack and Attio are both set. */
const attio = (http: FakeHttp) =>
  ChatAttio.layer({ token: Redacted.make(TOKEN), url: MCP_URL }).pipe(
    Layer.provide([slackConfig, http.layer]),
  )

const inChannel = (channel: string): ChatThread => ({
  _tag: "Slack",
  team: "T1",
  channel,
  threadTs: "1700000000.000100",
})

describe("attioSettings", () => {
  it.effect("is off without ATTIO_MCP_TOKEN, and defaults ATTIO_MCP_URL to Attio's server", () =>
    Effect.gen(function* () {
      const read = (env: Record<string, string>) =>
        attioSettings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))

      assert.isTrue(Option.isNone(yield* read({})))
      assert.isTrue(Option.isNone(yield* read({ ATTIO_MCP_URL: "https://mcp.attio.test/mcp" })))

      const settings = Option.getOrThrow(yield* read({ ATTIO_MCP_TOKEN: TOKEN }))
      assert.strictEqual(Redacted.value(settings.token), TOKEN)
      assert.strictEqual(settings.url, "https://mcp.attio.com/mcp")
    }),
  )
})

describe("ChatAttio.allowed", () => {
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
    it.effect(`${expected ? "allows" : "denies"} ${name}`, () =>
      Effect.gen(function* () {
        const http = new FakeHttp()
        const allowed = yield* Effect.gen(function* () {
          const service = yield* ChatAttio
          return yield* service.allowed(thread)
        }).pipe(Effect.provide(attio(http)))
        assert.strictEqual(allowed, expected)
        assert.deepStrictEqual(http.mcp, [], "deciding never reaches Attio")
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

layer(Services, { timeout: "2 minutes" })("Attio in a chat session", (it) => {
  /** One turn in `thread` whose script calls Attio's `whoami`, with the logs it wrote. */
  const whoamiTurn = (thread: ChatThread) => {
    const http = new FakeHttp()
    const logs: Array<string> = []
    const capture = Logger.layer([
      Logger.make((options) => {
        logs.push(Logger.formatJson.log(options))
      }),
    ])
    return Effect.gen(function* () {
      const harness: SessionHarness = yield* makeSessionHarnessWith(attio(http))
      const message = yield* harness.message("Who is janitor in Attio?", { mention: true })
      yield* harness.deliver(thread, message)
      yield* harness.until(
        Effect.sync(() => harness.model.prompts.length >= 1),
        "the first model call",
      )
      harness.model.answer(callTool("mcp.attio.whoami", {}), say("Done."))
      yield* harness.until(
        Effect.sync(() => harness.platform.replies.length > 0),
        "the reply",
      )
      return { harness, http, logs }
    }).pipe(Effect.scoped, Effect.provide(capture))
  }

  it.effect(
    "an internal channel's turn calls Attio's tools with the bearer token, which stays in the Worker",
    () =>
      Effect.gen(function* () {
        const { harness, http, logs } = yield* whoamiTurn(inChannel("CPUBLIC"))

        assert.deepStrictEqual(harness.sandboxes.toolOutcomes, ["ok"])
        const calls = http.mcp.filter((request) => request.rpc === "tools/call")
        assert.deepStrictEqual(
          calls.map((request) => request.params),
          [{ name: "whoami", arguments: {} }],
        )
        for (const request of http.mcp)
          assert.strictEqual(
            request.authorization,
            `Bearer ${TOKEN}`,
            request.rpc ?? request.method,
          )

        const exposed = [
          ...harness.model.prompts.map(seen),
          ...harness.sandboxes.scripts,
          ...harness.sandboxes.written.map((file) => new TextDecoder().decode(file.content)),
          ...logs,
        ]
        for (const text of exposed) assert.notInclude(text, TOKEN)
      }),
  )

  it.effect("a shared channel's turn has no Attio tools and never reaches Attio", () =>
    Effect.gen(function* () {
      const { harness, http } = yield* whoamiTurn(inChannel("C-is_ext_shared"))

      assert.deepStrictEqual(harness.sandboxes.toolOutcomes, [
        "failed: no loop-side tool attio.whoami",
      ])
      assert.deepStrictEqual(http.mcp, [])
    }),
  )
})
