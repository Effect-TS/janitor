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
import { type AttioCredential, AttioUnavailable } from "../../src/Chat/AttioCredential.ts"
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
 * themselves. The access tokens come from a fake credential, which
 * `AttioCredential.test.ts` stands in for. Every fixture is synthetic.
 */

const MCP_URL = "https://mcp.attio.test/mcp"

/**
 * Hands out `attio-access-<n>`. `fresh` issues a new token on every call, as
 * a refresh between two requests would; otherwise the token changes only when
 * the current one is reported rejected. `unavailable` fails every call.
 */
class FakeCredential implements AttioCredential {
  readonly issued: Array<string> = []
  readonly rejected: Array<string> = []

  constructor(readonly mode: "fresh" | "stable" | "unavailable") {}

  private issue() {
    const token = `attio-access-${this.issued.length + 1}`
    this.issued.push(token)
    return token
  }

  readonly token = (rejected?: Redacted.Redacted<string>) =>
    Effect.suspend(() => {
      if (this.mode === "unavailable") return Effect.fail(new AttioUnavailable())
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
}

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
  /** A `tools/call` bearing this token is answered 401, as Attio does once it revoked it. */
  rejectCallsWith: string | undefined

  constructor(readonly credential: FakeCredential) {}

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
    const token = authorization?.match(/^Bearer (.+)$/)?.[1]
    if (
      token === undefined ||
      !this.credential.issued.includes(token) ||
      (message.method === "tools/call" && token === this.rejectCallsWith)
    )
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
  ChatAttio.layer({ url: MCP_URL, credential: http.credential }).pipe(
    Layer.provide([slackConfig, http.layer]),
  )

const inChannel = (channel: string): ChatThread => ({
  _tag: "Slack",
  team: "T1",
  channel,
  threadTs: "1700000000.000100",
})

describe("attioSettings", () => {
  const read = (env: Record<string, string>) =>
    attioSettings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
  const client = { ATTIO_MCP_CLIENT_ID: "attio-client-synthetic" }
  const seed = { ATTIO_MCP_REFRESH_TOKEN: "attio-seed-refresh-3c1d" }

  const off: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ["nothing", {}],
    ["only the client id", client],
    ["only the refresh token", seed],
    ["only the old static ATTIO_MCP_TOKEN", { ATTIO_MCP_TOKEN: "attio-static-token" }],
  ]
  for (const [name, env] of off)
    it.effect(`is off with ${name}`, () =>
      Effect.gen(function* () {
        assert.isTrue(Option.isNone(yield* read({ ...env, ATTIO_MCP_URL: MCP_URL })))
      }),
    )

  it.effect("defaults the MCP and token URLs to Attio's, and the client secret to none", () =>
    Effect.gen(function* () {
      const settings = Option.getOrThrow(yield* read({ ...client, ...seed }))
      assert.strictEqual(settings.clientId, "attio-client-synthetic")
      assert.strictEqual(Redacted.value(settings.refreshToken), "attio-seed-refresh-3c1d")
      assert.isTrue(Option.isNone(settings.clientSecret))
      assert.strictEqual(settings.url, "https://mcp.attio.com/mcp")
      assert.strictEqual(settings.tokenUrl, "https://app.attio.com/oidc/token")

      const confidential = Option.getOrThrow(
        yield* read({ ...client, ...seed, ATTIO_MCP_CLIENT_SECRET: "attio-client-secret-9b2e" }),
      )
      assert.strictEqual(
        Redacted.value(Option.getOrThrow(confidential.clientSecret)),
        "attio-client-secret-9b2e",
      )
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
        const http = new FakeHttp(new FakeCredential("fresh"))
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
  /**
   * One turn in `thread` whose scripts call Attio's `whoami` `calls` times
   * before replying, with the logs it wrote.
   */
  const whoamiTurn = (
    thread: ChatThread,
    credential: FakeCredential,
    options: { readonly calls?: number; readonly rejectCallsWith?: string } = {},
  ) => {
    const http = new FakeHttp(credential)
    http.rejectCallsWith = options.rejectCallsWith
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
      harness.model.answer(
        ...Array.from({ length: options.calls ?? 1 }, () => callTool("mcp.attio.whoami", {})),
        say("Done."),
      )
      yield* harness.until(
        Effect.sync(() => harness.platform.replies.length > 0),
        "the reply",
      )
      return { harness, http, logs }
    }).pipe(Effect.scoped, Effect.provide(capture))
  }

  const toolCalls = (http: FakeHttp) => http.mcp.filter((request) => request.rpc === "tools/call")

  it.effect(
    "an internal channel's turn calls Attio's tools with a token fetched for each request, which stays in the Worker",
    () =>
      Effect.gen(function* () {
        const credential = new FakeCredential("fresh")
        const { harness, http, logs } = yield* whoamiTurn(inChannel("CPUBLIC"), credential)

        assert.deepStrictEqual(harness.sandboxes.toolOutcomes, ["ok"])
        const calls = toolCalls(http)
        assert.deepStrictEqual(
          calls.map((request) => request.params),
          [{ name: "whoami", arguments: {} }],
        )
        const initialize = http.mcp.find((request) => request.rpc === "initialize")
        assert.notStrictEqual(
          calls[0]!.authorization,
          initialize?.authorization,
          "a token that changed after initialize is the one tools/call sends",
        )

        const exposed = [
          ...harness.model.prompts.map(seen),
          ...harness.sandboxes.scripts,
          ...harness.sandboxes.written.map((file) => new TextDecoder().decode(file.content)),
          ...logs,
        ]
        assert.isNotEmpty(credential.issued)
        for (const text of exposed)
          for (const token of credential.issued) assert.notInclude(text, token)
      }),
  )

  it.effect(
    "a rejected token fails that tool call once, without a retry, and the next call uses a new token",
    () =>
      Effect.gen(function* () {
        const credential = new FakeCredential("stable")
        const { harness, http } = yield* whoamiTurn(inChannel("CPUBLIC"), credential, {
          calls: 2,
          rejectCallsWith: "attio-access-1",
        })

        assert.strictEqual(harness.sandboxes.toolOutcomes.length, 2)
        assert.match(harness.sandboxes.toolOutcomes[0]!, /^failed: /)
        assert.strictEqual(harness.sandboxes.toolOutcomes[1], "ok")
        assert.deepStrictEqual(
          toolCalls(http).map((request) => request.authorization),
          ["Bearer attio-access-1", "Bearer attio-access-2"],
        )
        assert.deepStrictEqual(credential.rejected, ["attio-access-1"])
      }),
  )

  const withoutAttio: ReadonlyArray<readonly [string, ChatThread, FakeCredential["mode"]]> = [
    ["a shared channel's turn", inChannel("C-is_ext_shared"), "fresh"],
    ["a turn without an access token", inChannel("CPUBLIC"), "unavailable"],
  ]
  for (const [name, thread, mode] of withoutAttio)
    it.effect(`${name} has no Attio tools and never reaches Attio`, () =>
      Effect.gen(function* () {
        const { harness, http } = yield* whoamiTurn(thread, new FakeCredential(mode))

        assert.deepStrictEqual(harness.sandboxes.toolOutcomes, [
          "failed: no loop-side tool attio.whoami",
        ])
        assert.deepStrictEqual(http.mcp, [])
      }),
    )
})
