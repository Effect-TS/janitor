import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Inspectable from "effect/Inspectable"
import type * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as TestClock from "effect/testing/TestClock"
import type * as HttpClient from "effect/http/HttpClient"
import {
  type McpCredential,
  type McpCredentialOptions,
  makeMcpCredential,
} from "../../src/Chat/McpCredential.ts"
import {
  type Answer,
  CLIENT_SECRET,
  type Endpoints,
  FakeAuthorizationServer,
  TOKEN_URL,
} from "../support/OAuthServer.ts"
import { fetchClient } from "../support/Fetch.ts"

/**
 * An MCP server's credential (EFF-3443), one per configured server: what
 * **Connect** got from the server's authorisation server, kept up to date in
 * the server's own storage, and swapped for short-lived access tokens. The
 * authorisation server is a fake behind the `HttpClient`, the storage is in
 * memory and time is the test clock. Every credential is synthetic.
 */

const MCP_URL = "https://mcp.crm.test/mcp"
const REDIRECT_URI = "https://janitor.test/api/v1/chat/mcp-servers/srv-1/oauth/callback"
/** The refresh token the first consent hands out. */
const CONSENTED = "refresh-code-1"

/** A server's Durable Object storage, which outlives the credential: `make` again is a restart. */
class MemoryStorage {
  value: unknown = undefined
  /** While set, every write fails, as a Durable Object `put` can. */
  failing = false

  readonly storage: McpCredentialOptions["storage"] = {
    load: Effect.sync(() => this.value),
    save: (value) =>
      Effect.suspend(() => {
        if (this.failing) return Effect.fail("rejected" as const)
        this.value = value
        return Effect.void
      }),
    clear: Effect.sync(() => {
      this.value = undefined
    }),
  }
}

const make = (
  auth: FakeAuthorizationServer,
  storage: MemoryStorage,
  http: Layer.Layer<HttpClient.HttpClient> = auth.layer,
) => makeMcpCredential({ url: MCP_URL, storage: storage.storage }).pipe(Effect.provide(http))

/** **Connect**: start, the user's consent at the authorisation server, then the callback. */
const connect = (auth: FakeAuthorizationServer, credential: McpCredential) =>
  Effect.gen(function* () {
    const authorizationUrl = yield* credential.startOAuth({ redirectUri: REDIRECT_URI })
    yield* credential.finishOAuth(auth.approve(authorizationUrl))
  })

/** A credential connected with an hour-long access token, `access-1`. */
const connected = (auth: FakeAuthorizationServer, storage = new MemoryStorage()) =>
  Effect.gen(function* () {
    const credential = yield* make(auth, storage)
    yield* connect(auth, credential)
    return credential
  })

/** Lets forked calls reach their next wait before the test goes on. */
const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
})

const value = <E, R>(self: Effect.Effect<Redacted.Redacted<string>, E, R>) =>
  Effect.map(self, Redacted.value)

/** What `self` gave, or the tag of its failure. */
const outcome = <A, R>(self: Effect.Effect<A, { readonly _tag: string }, R>) =>
  Effect.catch(self, (error) => Effect.succeed(error._tag))

const unavailable = <A, R>(self: Effect.Effect<A, { readonly _tag: string }, R>) =>
  Effect.map(Effect.flip(self), (error) => error._tag)

/** Until the connected token has five minutes left, when it's refreshed. */
const STALE = "3300 seconds"

describe("an MCP server's credential", () => {
  it.effect("has none until Connect, which stores what consent gave, across a restart", () =>
    Effect.gen(function* () {
      const auth = new FakeAuthorizationServer(MCP_URL)
      const storage = new MemoryStorage()
      const credential = yield* make(auth, storage)
      assert.strictEqual(yield* credential.status, "no-credential")
      assert.strictEqual(yield* unavailable(credential.token()), "McpUnavailable")
      assert.deepStrictEqual(auth.tokenRequests, [])

      yield* connect(auth, credential)
      assert.strictEqual(yield* credential.status, "connected")
      assert.strictEqual(yield* value(credential.token()), "access-1")
      assert.deepStrictEqual(auth.refreshes, [])

      const restarted = yield* make(auth, storage)
      assert.strictEqual(yield* restarted.status, "connected")
      yield* restarted.token()
    }),
  )

  /** Endpoints the authorisation server's metadata can name that Connect must never use. */
  const unsafe: ReadonlyArray<readonly [string, Endpoints]> = [
    [
      "an http authorisation endpoint",
      { authorization_endpoint: "http://auth.mcp.test/authorize" },
    ],
    ["an http token endpoint", { token_endpoint: "http://auth.mcp.test/token" }],
    ["an http registration endpoint", { registration_endpoint: "http://auth.mcp.test/register" }],
    ["a javascript: authorisation endpoint", { authorization_endpoint: "javascript:alert(1)//" }],
  ]
  for (const [name, endpoints] of unsafe)
    it.effect(`Connect refuses ${name}, sending nothing to it and storing nothing`, () =>
      Effect.gen(function* () {
        const auth = new FakeAuthorizationServer(MCP_URL)
        auth.endpoints = endpoints
        const storage = new MemoryStorage()
        const credential = yield* make(auth, storage)

        const started = yield* credential.startOAuth({ redirectUri: REDIRECT_URI }).pipe(
          Effect.map((url) => `started, at ${url}`),
          Effect.catch((error) => Effect.succeed(error._tag)),
        )
        assert.strictEqual(started, "McpOAuthUnavailable")
        assert.deepStrictEqual(
          auth.seen.filter((request) => !request.includes(" https://")),
          [],
          "every request went over https",
        )
        assert.deepStrictEqual(auth.tokenRequests, [])
        assert.isUndefined(storage.value, "no pending Connect to finish")
        assert.strictEqual(yield* credential.status, "no-credential")
      }),
    )

  /**
   * Where the token endpoint redirects, and whether that may be followed:
   * only within its origin, as the SDK allows, on the Worker's real
   * `FetchHttpClient`.
   */
  const redirects: ReadonlyArray<readonly [string, string, boolean]> = [
    ["plain http on its host", "http://auth.mcp.test/token", false],
    ["another origin", "https://elsewhere.test/token", false],
    ["its own origin", `${TOKEN_URL}?moved=1`, true],
  ]
  for (const [name, target, followed] of redirects)
    it.effect(
      `a token endpoint redirecting to ${name} is ${followed ? "followed" : "sent nothing"}, on refresh and on Connect`,
      () =>
        Effect.gen(function* () {
          const auth = new FakeAuthorizationServer(MCP_URL)
          const client = yield* fetchClient(auth.fetch)
          const credential = yield* make(auth, new MemoryStorage(), client.layer)
          yield* connect(auth, credential)
          auth.tokenRedirect = target

          yield* TestClock.adjust(STALE)
          const refreshed = yield* outcome(value(credential.token()))
          const reconnected = yield* outcome(Effect.as(connect(auth, credential), "connected"))
          assert.deepStrictEqual(
            [refreshed, reconnected],
            followed ? ["access-2", "connected"] : ["McpUnavailable", "McpOAuthRefused"],
          )
          assert.strictEqual(
            auth.seen.some((request) => request.endsWith(` ${target}`)),
            followed,
            "the redirect target got a request",
          )
          assert.deepStrictEqual(client.escaped, [], "every request went through the given fetch")
        }),
    )

  const clients: ReadonlyArray<readonly [string, boolean]> = [
    ["a public client", false],
    ["a confidential client", true],
  ]
  for (const [name, confidential] of clients)
    it.effect(`refreshes with the refresh token consent gave, for ${name}`, () =>
      Effect.gen(function* () {
        const auth = new FakeAuthorizationServer(MCP_URL)
        auth.confidential = confidential
        const credential = yield* connected(auth)
        yield* TestClock.adjust(STALE)

        assert.strictEqual(yield* value(credential.token()), "access-2")
        assert.strictEqual(auth.refreshes.length, 1)
        const request = auth.refreshes[0]!
        assert.strictEqual(request.url, TOKEN_URL)
        assert.strictEqual(request.method, "POST")
        assert.match(request.contentType ?? "", /^application\/x-www-form-urlencoded/)
        assert.deepStrictEqual(request.params, {
          grant_type: "refresh_token",
          refresh_token: CONSENTED,
          client_id: "client-1",
          resource: MCP_URL,
          ...(confidential ? { client_secret: CLIENT_SECRET } : {}),
        })
      }),
    )

  /**
   * A token is reused while more than five minutes of it are left. One that
   * lives five minutes or less, which an answer without `expires_in` is
   * taken to, is refreshed on every call.
   */
  const windows: ReadonlyArray<readonly [string, number | undefined, number]> = [
    ["an hour", 3600, 3300],
    ["five minutes and a second", 301, 1],
    ["five minutes", 300, 0],
    ["an unstated time", undefined, 0],
  ]
  for (const [name, expiresIn, reusedFor] of windows)
    it.effect(`a token that lives ${name} is reused for ${reusedFor} seconds, then refreshed`, () =>
      Effect.gen(function* () {
        const auth = new FakeAuthorizationServer(MCP_URL)
        const credential = yield* connected(auth)
        auth.answerRefresh = () =>
          Effect.succeed(auth.grant(expiresIn === undefined ? {} : { expires_in: expiresIn }))
        yield* TestClock.adjust(STALE)
        assert.strictEqual(yield* value(credential.token()), "access-2")

        if (reusedFor > 0) {
          yield* TestClock.adjust(`${reusedFor - 1} seconds`)
          assert.strictEqual(yield* value(credential.token()), "access-2")
          assert.strictEqual(auth.refreshes.length, 1)
          yield* TestClock.adjust("1 second")
        }
        assert.strictEqual(yield* value(credential.token()), "access-3")
        assert.strictEqual(auth.refreshes.length, 2)
      }),
    )

  it.effect(
    "concurrent calls, and callers reporting the same rejected token, share one refresh",
    () =>
      Effect.gen(function* () {
        const auth = new FakeAuthorizationServer(MCP_URL)
        const credential = yield* connected(auth)
        let gate = yield* Deferred.make<void>()
        auth.answerRefresh = () =>
          Effect.map(Deferred.await(gate), () => auth.grant({ expires_in: 3600 }))
        yield* TestClock.adjust(STALE)

        const first = yield* Effect.forkChild(
          Effect.all([credential.token(), credential.token()], { concurrency: "unbounded" }),
        )
        yield* settle
        assert.strictEqual(auth.refreshes.length, 1)
        yield* Deferred.succeed(gate, undefined)
        const tokens = (yield* Fiber.join(first)).map(Redacted.value)
        assert.deepStrictEqual(tokens, ["access-2", "access-2"])

        gate = yield* Deferred.make<void>()
        const rejected = Redacted.make("access-2")
        const second = yield* Effect.forkChild(
          Effect.all([credential.token(rejected), credential.token(rejected)], {
            concurrency: "unbounded",
          }),
        )
        yield* settle
        yield* Deferred.succeed(gate, undefined)
        const refreshed = (yield* Fiber.join(second)).map(Redacted.value)
        assert.deepStrictEqual(refreshed, ["access-3", "access-3"])
        assert.strictEqual(auth.refreshes.length, 2)

        // A rejection of a token already replaced asks for nothing.
        assert.strictEqual(yield* value(credential.token(rejected)), "access-3")
        assert.strictEqual(auth.refreshes.length, 2)
      }),
  )

  it.effect(
    "a rotated refresh token is stored before the access token is handed out, and used after a restart",
    () =>
      Effect.gen(function* () {
        const auth = new FakeAuthorizationServer(MCP_URL)
        const storage = new MemoryStorage()
        const credential = yield* connected(auth, storage)
        let rotations = 0
        auth.answerRefresh = () =>
          Effect.sync(() => {
            rotations += 1
            return auth.grant({ expires_in: 3600, refresh_token: `rotated-${rotations}` })
          })
        yield* TestClock.adjust(STALE)
        yield* credential.token()

        const restarted = yield* make(auth, storage)
        yield* TestClock.adjust(STALE)
        yield* restarted.token()
        assert.strictEqual(auth.refreshes[1]?.params.refresh_token, "rotated-1")

        storage.failing = true
        const unsaved = yield* make(auth, storage)
        yield* TestClock.adjust(STALE)
        assert.strictEqual(yield* unavailable(unsaved.token()), "McpUnavailable")
        assert.strictEqual(auth.refreshes[2]?.params.refresh_token, "rotated-2")
      }),
  )

  /** How the token endpoint fails a refresh, and whether that takes a new consent. */
  const failures: ReadonlyArray<readonly [string, Answer, "consent" | "transient"]> = [
    [
      "invalid_grant",
      () => Effect.succeed(Response.json({ error: "invalid_grant" }, { status: 400 })),
      "consent",
    ],
    [
      "invalid_client",
      () => Effect.succeed(Response.json({ error: "invalid_client" }, { status: 401 })),
      "consent",
    ],
    [
      "a server error that echoes the request",
      (params) =>
        Effect.succeed(
          new Response(`upstream failed for ${new URLSearchParams(params).toString()}`, {
            status: 500,
          }),
        ),
      "transient",
    ],
    [
      "a rate limit",
      () => Effect.succeed(new Response("", { status: 429, headers: { "retry-after": "1" } })),
      "transient",
    ],
    [
      "an answer without an access token",
      () => Effect.succeed(Response.json({ token_type: "Bearer", expires_in: 3600 })),
      "transient",
    ],
    ["a network failure", () => Effect.fail("network" as const), "transient"],
    ["no answer within 15 seconds", () => Effect.never, "transient"],
  ]
  for (const [name, answer, kind] of failures)
    it.effect(
      kind === "consent"
        ? `${name} needs consent, and stops refreshing until Connect runs again`
        : `${name} is unavailable, and nothing is asked for 30 seconds`,
      () => {
        const logs: Array<string> = []
        const capture = Logger.layer([
          Logger.make((options) => {
            logs.push(Logger.formatJson.log(options))
          }),
        ])
        return Effect.gen(function* () {
          const auth = new FakeAuthorizationServer(MCP_URL)
          auth.confidential = true
          const storage = new MemoryStorage()
          const credential = yield* connected(auth, storage)
          auth.answerRefresh = answer
          yield* TestClock.adjust(STALE)

          const failing = yield* Effect.forkChild(Effect.flip(credential.token()))
          yield* settle
          // Only the answer that never comes takes time to fail; the 30 seconds count from then.
          if (failing.pollUnsafe() === undefined) yield* TestClock.adjust("15 seconds")
          const error = yield* Fiber.join(failing)
          assert.strictEqual(error._tag, "McpUnavailable")
          assert.strictEqual(auth.refreshes.length, 1)
          auth.answerRefresh = () => Effect.succeed(auth.grant({ expires_in: 3600 }))

          if (kind === "consent") {
            assert.strictEqual(yield* credential.status, "needs-consent")
            yield* TestClock.adjust("1 hour")
            assert.strictEqual(yield* unavailable(credential.token()), "McpUnavailable")
            const restarted = yield* make(auth, storage)
            assert.strictEqual(yield* restarted.status, "needs-consent")
            assert.strictEqual(yield* unavailable(restarted.token()), "McpUnavailable")
            assert.strictEqual(auth.refreshes.length, 1)

            yield* connect(auth, restarted)
            assert.strictEqual(yield* restarted.status, "connected")
            assert.strictEqual(yield* value(restarted.token()), "access-2")
          } else {
            assert.strictEqual(yield* credential.status, "unavailable")
            yield* TestClock.adjust("29 seconds")
            assert.strictEqual(yield* unavailable(credential.token()), "McpUnavailable")
            assert.strictEqual(auth.refreshes.length, 1)

            yield* TestClock.adjust("1 second")
            assert.strictEqual(yield* value(credential.token()), "access-2")
            assert.strictEqual(auth.refreshes.length, 2)
            assert.strictEqual(yield* credential.status, "connected")
          }

          for (const text of [...logs, String(error), Inspectable.toStringUnknown(error)])
            for (const secret of [CONSENTED, CLIENT_SECRET]) assert.notInclude(text, secret)
        }).pipe(Effect.provide(capture))
      },
    )

  it.effect("wiping one server's credential empties its storage and leaves another's", () =>
    Effect.gen(function* () {
      const auth = new FakeAuthorizationServer(MCP_URL)
      const storages = [new MemoryStorage(), new MemoryStorage()] as const
      const kept = yield* connected(auth, storages[0])
      const wiped = yield* make(auth, storages[1])
      assert.strictEqual(yield* wiped.status, "no-credential", "Connect is per server")
      yield* connect(auth, wiped)

      yield* wiped.wipe
      assert.isUndefined(storages[1].value)
      assert.strictEqual(yield* wiped.status, "no-credential")
      assert.strictEqual(yield* unavailable(wiped.token()), "McpUnavailable")
      assert.strictEqual(yield* (yield* make(auth, storages[1])).status, "no-credential")

      assert.strictEqual(yield* kept.status, "connected")
      assert.strictEqual(yield* value(kept.token()), "access-1")
    }),
  )

  /**
   * Holds a refresh of a connected credential at the token endpoint.
   * `release` lets it through, answered with `access-stale` and a
   * rotated refresh token, and waits for the caller that started it.
   */
  const holdRefresh = (auth: FakeAuthorizationServer, credential: McpCredential) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      auth.answerRefresh = () =>
        Effect.as(
          Deferred.await(gate),
          Response.json({
            access_token: "access-stale",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rotated-stale",
          }),
        )
      yield* TestClock.adjust(STALE)
      const caller = yield* Effect.forkChild(Effect.exit(credential.token()))
      yield* settle
      assert.strictEqual(auth.refreshes.length, 1, "the refresh is under way")
      const release = Effect.gen(function* () {
        auth.answerRefresh = () => Effect.succeed(auth.grant({ expires_in: 3600 }))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(caller)
        yield* settle
      })
      return { release }
    })

  it.effect("a refresh under way when the credential is wiped doesn't bring it back", () =>
    Effect.gen(function* () {
      const auth = new FakeAuthorizationServer(MCP_URL)
      const storage = new MemoryStorage()
      const credential = yield* connected(auth, storage)
      const { release } = yield* holdRefresh(auth, credential)

      const wiping = yield* Effect.forkChild(credential.wipe)
      yield* settle
      yield* release
      yield* Fiber.join(wiping)

      assert.isUndefined(storage.value)
      assert.strictEqual(yield* credential.status, "no-credential")
      assert.strictEqual(yield* unavailable(credential.token()), "McpUnavailable")
      assert.strictEqual(yield* (yield* make(auth, storage)).status, "no-credential")
    }),
  )

  it.effect("a refresh under way when Connect runs again doesn't replace the new consent", () =>
    Effect.gen(function* () {
      const auth = new FakeAuthorizationServer(MCP_URL)
      const storage = new MemoryStorage()
      const credential = yield* connected(auth, storage)
      const { release } = yield* holdRefresh(auth, credential)

      const reconnecting = yield* Effect.forkChild(connect(auth, credential))
      yield* settle
      yield* release
      yield* Fiber.join(reconnecting)

      assert.strictEqual(yield* credential.status, "connected")
      assert.notStrictEqual(yield* value(credential.token()), "access-stale")
      // A restart has no access token, so it refreshes with what's stored.
      yield* (yield* make(auth, storage)).token()
      assert.strictEqual(auth.refreshes.at(-1)?.params.refresh_token, "refresh-code-2")
    }),
  )

  /** What replaces a credential while a Connect callback waits on its code exchange. */
  const replacements: ReadonlyArray<
    readonly [
      string,
      (credential: McpCredential) => Effect.Effect<void>,
      { readonly status: string; readonly token: string },
    ]
  > = [
    [
      "wiped",
      (credential) => credential.wipe,
      { status: "no-credential", token: "McpUnavailable" },
    ],
    [
      "given a bearer token",
      (credential) => credential.setBearer(Redacted.make("bearer-replacement")),
      { status: "connected", token: "bearer-replacement" },
    ],
  ]
  for (const [name, replace, expected] of replacements)
    it.effect(`a Connect callback under way when the credential is ${name} is refused`, () =>
      Effect.gen(function* () {
        const auth = new FakeAuthorizationServer(MCP_URL)
        const storage = new MemoryStorage()
        const credential = yield* make(auth, storage)
        const gate = yield* Deferred.make<void>()
        auth.beforeExchange = Deferred.await(gate)
        const authorizationUrl = yield* credential.startOAuth({ redirectUri: REDIRECT_URI })
        const finishing = yield* Effect.forkChild(
          outcome(Effect.as(credential.finishOAuth(auth.approve(authorizationUrl)), "finished")),
        )
        yield* settle
        assert.strictEqual(auth.exchanges.length, 1, "the exchange is under way")

        const replacing = yield* Effect.forkChild(replace(credential))
        yield* settle
        yield* Deferred.succeed(gate, undefined)
        assert.strictEqual(yield* Fiber.join(finishing), "McpOAuthRefused")
        yield* Fiber.join(replacing)

        for (const current of [credential, yield* make(auth, storage)]) {
          assert.strictEqual(yield* current.status, expected.status)
          assert.strictEqual(yield* outcome(value(current.token())), expected.token)
        }
      }),
    )
})
