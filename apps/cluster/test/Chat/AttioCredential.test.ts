import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Inspectable from "effect/Inspectable"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { type AttioCredentialOptions, makeAttioCredential } from "../../src/Chat/AttioCredential.ts"

/**
 * Attio's OAuth credential (EFF-3443): one refresh token, kept up to date in
 * storage, swapped for short-lived access tokens. Attio's token endpoint is a
 * fake behind the `HttpClient`, the storage is in memory and time is the
 * test clock. Every credential is synthetic.
 */

const SEED = "attio-seed-refresh-3c1d"
const SECRET = "attio-client-secret-9b2e"
const CLIENT_ID = "attio-client-synthetic"
const TOKEN_URL = "https://app.attio.test/oidc/token"
const MCP_URL = "https://mcp.attio.test/mcp"

/** One request the fake token endpoint received. */
interface TokenRequest {
  readonly url: string
  readonly method: string
  readonly contentType: string | null
  readonly params: Record<string, string>
}

type Answer = (params: Record<string, string>) => Effect.Effect<Response, "network">

/**
 * Attio's token endpoint. By default each request gets `attio-access-<n>`,
 * valid for an hour, and keeps the refresh token as it is.
 */
class TokenEndpoint {
  readonly requests: Array<TokenRequest> = []
  private issued = 0
  answer: Answer = () => Effect.succeed(this.grant({ expires_in: 3600 }))

  /** A successful refresh, with the next access token and `fields`. */
  grant(fields: { readonly expires_in?: number; readonly refresh_token?: string }) {
    this.issued += 1
    return Response.json({
      access_token: `attio-access-${this.issued}`,
      token_type: "Bearer",
      ...fields,
    })
  }

  get layer() {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen({ self: this }, function* () {
          const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
          const params = Object.fromEntries(
            new URLSearchParams(yield* Effect.promise(() => web.text())),
          )
          this.requests.push({
            url: web.url,
            method: web.method,
            contentType: web.headers.get("content-type"),
            params,
          })
          const response = yield* this.answer(params).pipe(
            Effect.mapError(
              () =>
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
            ),
          )
          return HttpClientResponse.fromWeb(request, response)
        }),
      ),
    )
  }
}

/** The Durable Object's storage, which survives the credential: `make` again is a restart. */
class MemoryStorage {
  private value: unknown = undefined
  /** While set, every write fails, as a Durable Object `put` can. */
  failing = false

  readonly storage: AttioCredentialOptions["storage"] = {
    load: Effect.sync(() => this.value),
    save: (value) =>
      Effect.suspend(() => {
        if (this.failing) return Effect.fail("rejected" as const)
        this.value = value
        return Effect.void
      }),
  }
}

const make = (
  endpoint: TokenEndpoint,
  storage: MemoryStorage,
  options: { readonly seed?: string | undefined; readonly clientSecret?: string | undefined } = {},
) =>
  makeAttioCredential({
    clientId: CLIENT_ID,
    clientSecret: Option.map(Option.fromUndefinedOr(options.clientSecret), Redacted.make),
    refreshToken: Redacted.make(options.seed ?? SEED),
    tokenUrl: TOKEN_URL,
    resource: MCP_URL,
    storage: storage.storage,
  }).pipe(Effect.provide(endpoint.layer))

/** Lets forked calls reach their next wait before the test goes on. */
const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
})

const value = <E, R>(self: Effect.Effect<Redacted.Redacted<string>, E, R>) =>
  Effect.map(self, Redacted.value)

describe("Attio's credential", () => {
  const clients: ReadonlyArray<readonly [string, string | undefined]> = [
    ["a public client", undefined],
    ["a confidential client", SECRET],
  ]
  for (const [name, clientSecret] of clients)
    it.effect(`refreshes from the configured refresh token, for ${name}`, () =>
      Effect.gen(function* () {
        const endpoint = new TokenEndpoint()
        const credential = yield* make(endpoint, new MemoryStorage(), { clientSecret })

        assert.strictEqual(yield* value(credential.token()), "attio-access-1")
        assert.strictEqual(endpoint.requests.length, 1)
        const request = endpoint.requests[0]!
        assert.strictEqual(request.url, TOKEN_URL)
        assert.strictEqual(request.method, "POST")
        assert.match(request.contentType ?? "", /^application\/x-www-form-urlencoded/)
        assert.deepStrictEqual(request.params, {
          grant_type: "refresh_token",
          refresh_token: SEED,
          client_id: CLIENT_ID,
          resource: MCP_URL,
          ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
        })
      }),
    )

  /**
   * A token is reused while more than five minutes of it are left. One that
   * lives five minutes or less, which Attio's answer without `expires_in` is
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
        const endpoint = new TokenEndpoint()
        endpoint.answer = () =>
          Effect.succeed(endpoint.grant(expiresIn === undefined ? {} : { expires_in: expiresIn }))
        const credential = yield* make(endpoint, new MemoryStorage())
        assert.strictEqual(yield* value(credential.token()), "attio-access-1")

        if (reusedFor > 0) {
          yield* TestClock.adjust(`${reusedFor - 1} seconds`)
          assert.strictEqual(yield* value(credential.token()), "attio-access-1")
          assert.strictEqual(endpoint.requests.length, 1)
          yield* TestClock.adjust("1 second")
        }
        assert.strictEqual(yield* value(credential.token()), "attio-access-2")
        assert.strictEqual(endpoint.requests.length, 2)
      }),
    )

  it.effect(
    "concurrent calls, and callers reporting the same rejected token, share one refresh",
    () =>
      Effect.gen(function* () {
        const endpoint = new TokenEndpoint()
        let gate = yield* Deferred.make<void>()
        endpoint.answer = () =>
          Effect.map(Deferred.await(gate), () => endpoint.grant({ expires_in: 3600 }))
        const credential = yield* make(endpoint, new MemoryStorage())

        const first = yield* Effect.forkChild(
          Effect.all([credential.token(), credential.token()], { concurrency: "unbounded" }),
        )
        yield* settle
        assert.strictEqual(endpoint.requests.length, 1)
        yield* Deferred.succeed(gate, undefined)
        const tokens = (yield* Fiber.join(first)).map(Redacted.value)
        assert.deepStrictEqual(tokens, ["attio-access-1", "attio-access-1"])

        gate = yield* Deferred.make<void>()
        const rejected = Redacted.make("attio-access-1")
        const second = yield* Effect.forkChild(
          Effect.all([credential.token(rejected), credential.token(rejected)], {
            concurrency: "unbounded",
          }),
        )
        yield* settle
        yield* Deferred.succeed(gate, undefined)
        const refreshed = (yield* Fiber.join(second)).map(Redacted.value)
        assert.deepStrictEqual(refreshed, ["attio-access-2", "attio-access-2"])
        assert.strictEqual(endpoint.requests.length, 2)

        // A rejection of a token already replaced asks for nothing.
        assert.strictEqual(yield* value(credential.token(rejected)), "attio-access-2")
        assert.strictEqual(endpoint.requests.length, 2)
      }),
  )

  it.effect(
    "a rotated refresh token is stored before the access token is handed out, and used after a restart",
    () =>
      Effect.gen(function* () {
        const endpoint = new TokenEndpoint()
        const storage = new MemoryStorage()
        let rotations = 0
        endpoint.answer = () =>
          Effect.sync(() => {
            rotations += 1
            return endpoint.grant({
              expires_in: 3600,
              refresh_token: `attio-rotated-${rotations}`,
            })
          })
        yield* (yield* make(endpoint, storage)).token()

        const restarted = yield* make(endpoint, storage)
        assert.strictEqual(yield* value(restarted.token()), "attio-access-2")
        assert.strictEqual(endpoint.requests[1]?.params.refresh_token, "attio-rotated-1")

        storage.failing = true
        const unsaved = yield* make(endpoint, storage)
        const error = yield* Effect.flip(unsaved.token())
        assert.strictEqual(error._tag, "AttioUnavailable")
        assert.strictEqual(endpoint.requests[2]?.params.refresh_token, "attio-rotated-2")
      }),
  )

  /** How the token endpoint fails, and whether that takes a new consent. */
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
          new Response(`upstream failed for ${JSON.stringify(params)}`, { status: 500 }),
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
        ? `${name} stops refreshing until the refresh token in the settings changes`
        : `${name} is unavailable, and nothing is asked for 30 seconds`,
      () => {
        const logs: Array<string> = []
        const capture = Logger.layer([
          Logger.make((options) => {
            logs.push(Logger.formatJson.log(options))
          }),
        ])
        return Effect.gen(function* () {
          const endpoint = new TokenEndpoint()
          const storage = new MemoryStorage()
          endpoint.answer = answer
          const credential = yield* make(endpoint, storage, { clientSecret: SECRET })

          const failing = yield* Effect.forkChild(Effect.flip(credential.token()))
          yield* settle
          // Only the answer that never comes takes time to fail; the 30 seconds count from then.
          if (failing.pollUnsafe() === undefined) yield* TestClock.adjust("15 seconds")
          const error = yield* Fiber.join(failing)
          assert.strictEqual(error._tag, "AttioUnavailable")
          assert.strictEqual(endpoint.requests.length, 1)
          endpoint.answer = () => Effect.succeed(endpoint.grant({ expires_in: 3600 }))

          if (kind === "consent") {
            yield* TestClock.adjust("1 hour")
            assert.strictEqual((yield* Effect.flip(credential.token()))._tag, "AttioUnavailable")
            const restarted = yield* make(endpoint, storage, { clientSecret: SECRET })
            assert.strictEqual((yield* Effect.flip(restarted.token()))._tag, "AttioUnavailable")
            assert.strictEqual(endpoint.requests.length, 1)

            const consented = yield* make(endpoint, storage, {
              seed: "attio-seed-refresh-new",
              clientSecret: SECRET,
            })
            assert.strictEqual(yield* value(consented.token()), "attio-access-1")
            assert.strictEqual(endpoint.requests[1]?.params.refresh_token, "attio-seed-refresh-new")
          } else {
            yield* TestClock.adjust("29 seconds")
            assert.strictEqual((yield* Effect.flip(credential.token()))._tag, "AttioUnavailable")
            assert.strictEqual(endpoint.requests.length, 1)

            yield* TestClock.adjust("1 second")
            assert.strictEqual(yield* value(credential.token()), "attio-access-1")
            assert.strictEqual(endpoint.requests.length, 2)
          }

          for (const text of [...logs, String(error), Inspectable.toStringUnknown(error)])
            for (const secret of [SEED, SECRET]) assert.notInclude(text, secret)
        }).pipe(Effect.provide(capture))
      },
    )
})
