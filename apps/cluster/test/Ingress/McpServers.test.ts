import { assert, layer } from "@effect/vitest"
import type { McpServer } from "@janitor/domain/Chat/McpServer"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as TestClock from "effect/testing/TestClock"
import {
  type McpCredential,
  type McpCredentialOptions,
  McpCredentials,
  makeMcpCredential,
} from "../../src/Chat/McpCredential.ts"
import { McpServerStore } from "../../src/Chat/McpServerStore.ts"
import { McpServersGroupLayer } from "../../src/Ingress/McpServers.ts"
import { makeClient } from "../support/Api.ts"
import { CLIENT_SECRET, FakeAuthorizationServer } from "../support/OAuthServer.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

/**
 * The dashboard's MCP servers (EFF-3443), behind Access like the kill switch:
 * their configuration in Postgres, each one's credential in its own storage,
 * and **Connect** against a fake authorisation server. Every value is
 * synthetic.
 */

const ORIGIN = "https://janitor.test"
const MCP_URL = "https://mcp.crm.test/mcp"
const BEARER = "docs-bearer-5f1a"

const callback = (id: string) => `${ORIGIN}/api/v1/chat/mcp-servers/${id}/oauth/callback`

/** A server's Durable Object storage, kept apart from its credential. */
class MemoryStorage {
  value: unknown = undefined
  readonly storage: McpCredentialOptions["storage"] = {
    load: Effect.sync(() => this.value),
    save: (value) =>
      Effect.sync(() => {
        this.value = value
      }),
    clear: Effect.sync(() => {
      this.value = undefined
    }),
  }
}

const auth = new FakeAuthorizationServer(MCP_URL)
/** Each server's storage, by id. */
const storages = new Map<string, MemoryStorage>()
const live = new Map<string, McpCredential>()

/** One credential per server, as its Durable Object is, over the storage that outlives it. */
const credentials = McpCredentials.of({
  forServer: (server) =>
    Effect.suspend(() => {
      const known = live.get(server.id)
      if (known !== undefined) return Effect.succeed(known)
      const storage = storages.get(server.id) ?? new MemoryStorage()
      storages.set(server.id, storage)
      return makeMcpCredential({ url: server.url, storage: storage.storage }).pipe(
        Effect.provide(auth.layer),
        Effect.tap((credential) => Effect.sync(() => live.set(server.id, credential))),
      )
    }),
})

const client = Effect.gen(function* () {
  const services = yield* Effect.context<McpServerStore>()
  return yield* makeClient(
    ["mcpServers"],
    McpServersGroupLayer,
    services.pipe(Context.add(McpCredentials, credentials)),
  )
})

/** What the handlers logged while `effect` ran. */
const logged = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const logs: Array<string> = []
  const capture = Logger.layer([
    Logger.make((options) => {
      logs.push(Logger.formatJson.log(options))
    }),
  ])
  return effect.pipe(
    Effect.map((value) => ({ value, logs })),
    Effect.provide(capture),
  )
}

const Services = McpServerStore.layer.pipe(
  Layer.provideMerge(MigratedPostgresLayer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ PUBLIC_ORIGIN: ORIGIN }))),
)

layer(Services, { timeout: "2 minutes" })("McpServersGroup", (it) => {
  it.effect("a server added without Private is private, and an edit is kept", () =>
    Effect.gen(function* () {
      const api = yield* client
      const created = yield* api.mcpServers.create({
        payload: { name: "crm_defaults", url: MCP_URL, auth: "oauth" },
      })
      const expected: McpServer = {
        id: created.id,
        name: "crm_defaults",
        url: MCP_URL,
        auth: "oauth",
        private: true,
        enabled: true,
        status: "no-credential",
      }
      assert.deepStrictEqual(created, expected)

      const edited = yield* api.mcpServers.update({
        params: { id: created.id },
        payload: { private: false, enabled: false },
      })
      assert.deepStrictEqual(edited, { ...expected, private: false, enabled: false })
      // Stored, not held by the handler: another client reads it back.
      const { servers } = yield* (yield* client).mcpServers.list()
      assert.deepStrictEqual(
        servers.find((server) => server.id === created.id),
        edited,
      )
    }),
  )

  const invalid: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ["an upper-case name", { name: "CRM" }],
    ["a name with a hyphen", { name: "crm-tools" }],
    ["an empty name", { name: "" }],
    ["an http URL", { url: "http://mcp.crm.test/mcp" }],
    ["a URL that isn't one", { url: "mcp.crm.test" }],
    ["an unknown authentication", { auth: "basic" }],
  ]
  for (const [name, change] of invalid)
    it.effect(`refuses a server with ${name}, and stores nothing`, () =>
      Effect.gen(function* () {
        const api = yield* client
        const payload = { name: "crm_refused", url: MCP_URL, auth: "oauth", ...change }
        yield* Effect.flip(api.mcpServers.create({ payload: payload as never }))
        const { servers } = yield* api.mcpServers.list()
        assert.isFalse(servers.some((server) => server.name === payload.name))
      }),
    )

  it.effect(
    "a bearer token is stored with the server's credential, and never read back or logged",
    () =>
      Effect.gen(function* () {
        const { value: server, logs } = yield* logged(
          Effect.gen(function* () {
            const api = yield* client
            const created = yield* api.mcpServers.create({
              payload: { name: "docs_bearer", url: MCP_URL, auth: "bearer", private: false },
            })
            return yield* api.mcpServers.setBearer({
              params: { id: created.id },
              payload: { token: Redacted.make(BEARER) },
            })
          }),
        )
        assert.deepStrictEqual(server, {
          id: server.id,
          name: "docs_bearer",
          url: MCP_URL,
          auth: "bearer",
          private: false,
          enabled: true,
          status: "connected",
        })
        const credential = yield* credentials.forServer(server)
        assert.strictEqual(Redacted.value(yield* credential.token()), BEARER)
        assert.deepStrictEqual(auth.tokenRequests.length, 0, "a bearer token is never refreshed")

        const { servers } = yield* (yield* client).mcpServers.list()
        assert.deepStrictEqual(
          servers.find((listed) => listed.id === server.id),
          server,
        )
        assert.isNotEmpty(logs)
        for (const line of logs) assert.notInclude(line, BEARER)
      }),
  )

  it.effect(
    "Connect registers a client, sends the browser to a PKCE authorisation URL, and the callback exchanges the code",
    () =>
      Effect.gen(function* () {
        auth.confidential = true
        const { value: server, logs } = yield* logged(
          Effect.gen(function* () {
            const api = yield* client
            const created = yield* api.mcpServers.create({
              payload: { name: "crm_connect", url: MCP_URL, auth: "oauth" },
            })
            const { authorizationUrl } = yield* api.mcpServers.startOAuth({
              params: { id: created.id },
            })
            const registration = auth.registrations.at(-1)
            assert.deepStrictEqual(registration?.redirect_uris, [callback(created.id)])
            const url = new URL(authorizationUrl)
            const clientId = `client-${auth.registrations.length}`
            assert.strictEqual(url.searchParams.get("client_id"), clientId)
            assert.strictEqual(url.searchParams.get("redirect_uri"), callback(created.id))
            assert.strictEqual(url.searchParams.get("resource"), MCP_URL)
            assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256")
            assert.isNotEmpty(url.searchParams.get("code_challenge") ?? "")
            assert.isNotEmpty(url.searchParams.get("state") ?? "")

            const exchanges = auth.exchanges.length
            yield* api.mcpServers.finishOAuth({
              params: { id: created.id },
              query: auth.approve(authorizationUrl),
            })
            assert.strictEqual(auth.exchanges.length, exchanges + 1)
            const exchange = auth.exchanges.at(-1)!.params
            assert.strictEqual(exchange.client_id, clientId)
            assert.strictEqual(exchange.redirect_uri, callback(created.id))
            assert.strictEqual(exchange.resource, MCP_URL)
            return created
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => (auth.confidential = false))))

        const { servers } = yield* (yield* client).mcpServers.list()
        assert.deepStrictEqual(
          servers.find((listed) => listed.id === server.id),
          { ...server, status: "connected" },
        )
        const secrets = [
          CLIENT_SECRET,
          ...auth.exchanges.map((request) => request.params.code_verifier!),
        ]
        for (const line of logs) for (const secret of secrets) assert.notInclude(line, secret)
      }),
  )

  type Api = Effect.Success<typeof client>
  type Consent = ReturnType<FakeAuthorizationServer["approve"]>

  /** A callback the server refuses, and never takes to the token endpoint. */
  const refused: ReadonlyArray<
    readonly [string, (api: Api, id: string, consent: Consent) => Effect.Effect<Consent>]
  > = [
    [
      "a state it never issued",
      (_api, _id, consent) => Effect.succeed({ ...consent, state: "forged" }),
    ],
    [
      "a state already used",
      (api, id, consent) =>
        api.mcpServers
          .finishOAuth({ params: { id }, query: consent })
          .pipe(Effect.as(consent), Effect.orDie),
    ],
    [
      "a state more than 10 minutes old",
      (_api, _id, consent) =>
        // Ten minutes and a second.
        Effect.as(TestClock.adjust("601 seconds"), consent),
    ],
  ]
  refused.forEach(([name, given], index) =>
    it.effect(`the callback refuses ${name}`, () =>
      Effect.gen(function* () {
        const api = yield* client
        const { id } = yield* api.mcpServers.create({
          payload: { name: `crm_refused_${index}`, url: MCP_URL, auth: "oauth" },
        })
        const { authorizationUrl } = yield* api.mcpServers.startOAuth({ params: { id } })
        const query = yield* given(api, id, auth.approve(authorizationUrl))
        const exchanges = auth.exchanges.length

        const error = yield* Effect.flip(api.mcpServers.finishOAuth({ params: { id }, query }))
        assert.strictEqual(error._tag, "McpOAuthRefused")
        assert.strictEqual(auth.exchanges.length, exchanges)
        const { servers } = yield* api.mcpServers.list()
        assert.strictEqual(
          servers.find((server) => server.id === id)?.status,
          name === "a state already used" ? "connected" : "no-credential",
        )
      }),
    ),
  )

  it.effect("deleting a server removes it and wipes its credential", () =>
    Effect.gen(function* () {
      const api = yield* client
      const { id } = yield* api.mcpServers.create({
        payload: { name: "docs_deleted", url: MCP_URL, auth: "bearer" },
      })
      yield* api.mcpServers.setBearer({ params: { id }, payload: { token: Redacted.make(BEARER) } })
      assert.isDefined(storages.get(id)?.value)

      yield* api.mcpServers.remove({ params: { id } })
      const { servers } = yield* api.mcpServers.list()
      assert.isFalse(servers.some((server) => server.id === id))
      assert.isUndefined(storages.get(id)?.value)
    }),
  )
})
