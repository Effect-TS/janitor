import { assert, describe, it } from "@effect/vitest"
import * as Cloudflare from "alchemy/Cloudflare"
import * as RuntimeContext from "alchemy/RuntimeContext"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import {
  type AccessIdentity,
  AccessAssertionRejected,
  AccessKeysUnavailable,
  AccessVerifier,
} from "../../src/Ingress/AccessJwt.ts"
import {
  AccessMiddlewareLayer,
  CurrentAccessIdentity,
  LOCAL_DEV_ISSUER,
  makeAccessMiddlewareLayer,
  RateLimitMiddlewareLayer,
} from "../../src/Ingress/Middleware.ts"

const runtimeContext = RuntimeContext.RuntimeContext.of({
  Type: "Test",
  id: "test",
  env: {},
  get: <A>() => Effect.succeed<A | undefined>(undefined),
  set: (id) => Effect.succeed(id),
})

type TestRouterRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"GlobalError", Cloudflare.RateLimitError | Schema.SchemaError>
  | HttpRouter.Request<"GlobalRequires", RuntimeContext.RuntimeContext>

const withHandler = <A, E, R>(
  layer: Layer.Layer<never, never, TestRouterRequirements>,
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(layer, {
        disableLogger: true,
        middleware: (app) =>
          app.pipe(
            Effect.orDie,
            Effect.provideService(RuntimeContext.RuntimeContext, runtimeContext),
          ),
      }),
    ),
    ({ handler }) => use(handler),
    ({ dispose }) => Effect.promise(dispose),
  )

const makeLayer = (limit: Cloudflare.RateLimitClient["limit"]) =>
  HttpRouter.add(
    "POST",
    "/probe",
    Effect.succeed(HttpServerResponse.text("Accepted", { status: 202 })),
  ).pipe(
    Layer.provide(RateLimitMiddlewareLayer),
    Layer.provide(
      Layer.succeed(Cloudflare.RateLimit, () =>
        Effect.succeed({
          raw: Effect.die("unused"),
          limit,
        }),
      ),
    ),
  )

describe("RateLimitMiddlewareLayer", () => {
  it.effect("bypasses the limiter without cf-connecting-ip", () => {
    const keys: Array<string> = []

    return withHandler(
      makeLayer(({ key }) =>
        Effect.sync(() => {
          keys.push(key)
          return { success: false }
        }),
      ),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(new Request("https://example.com/probe", { method: "POST" })),
          )

          assert.strictEqual(response.status, 202)
          assert.strictEqual(yield* Effect.promise(() => response.text()), "Accepted")
          assert.deepStrictEqual(keys, [])
        }),
    )
  })

  it.effect("continues with the exact IP key when allowed", () => {
    const keys: Array<string> = []

    return withHandler(
      makeLayer(({ key }) =>
        Effect.sync(() => {
          keys.push(key)
          return { success: true }
        }),
      ),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/probe", {
                method: "POST",
                headers: { "cf-connecting-ip": "203.0.113.10" },
              }),
            ),
          )

          assert.strictEqual(response.status, 202)
          assert.strictEqual(yield* Effect.promise(() => response.text()), "Accepted")
          assert.deepStrictEqual(keys, ["203.0.113.10"])
        }),
    )
  })

  it.effect("returns 429 when denied", () =>
    withHandler(
      makeLayer(() => Effect.succeed({ success: false })),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/probe", {
                method: "POST",
                headers: { "cf-connecting-ip": "203.0.113.11" },
              }),
            ),
          )

          assert.strictEqual(response.status, 429)
          assert.strictEqual(response.headers.get("retry-after"), "60")
          assert.strictEqual(yield* Effect.promise(() => response.text()), "Too Many Requests")
        }),
    ),
  )

  it.effect("returns a safe 500 when the limiter fails", () =>
    withHandler(
      makeLayer(() =>
        Effect.fail(
          new Cloudflare.RateLimitError({
            message: "Rate limiter unavailable",
            cause: new Error("Rate limiter unavailable"),
          }),
        ),
      ),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/probe", {
                method: "POST",
                headers: { "cf-connecting-ip": "203.0.113.12" },
              }),
            ),
          )

          assert.strictEqual(response.status, 500)
          assert.strictEqual(yield* Effect.promise(() => response.text()), "")
        }),
    ),
  )

  it.effect("limits an unmatched path because the middleware is global", () =>
    withHandler(
      makeLayer(() => Effect.succeed({ success: false })),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/missing", {
                method: "POST",
                headers: { "cf-connecting-ip": "203.0.113.13" },
              }),
            ),
          )

          assert.strictEqual(response.status, 429)
          assert.strictEqual(response.headers.get("retry-after"), "60")
          assert.strictEqual(yield* Effect.promise(() => response.text()), "Too Many Requests")
        }),
    ),
  )
})

describe("AccessMiddleware", () => {
  /** The execution context a request carries; `undefined` means no Access. */
  const executionContext = (
    access: { aud: string; email?: string } | undefined,
  ): Cloudflare.Workers.WorkerExecutionContext["Service"] => ({
    raw: {} as never,
    waitUntil: () => Effect.void,
    passThroughOnException: () => Effect.void,
    cache: { purge: () => Effect.die("unused") },
    access: Effect.succeed(
      access === undefined
        ? undefined
        : {
            aud: access.aud,
            getIdentity: () =>
              Effect.succeed(access.email === undefined ? undefined : { email: access.email }),
          },
    ),
  })

  const identity: AccessIdentity = {
    issuer: "https://team.cloudflareaccess.test",
    subject: "user-123",
    email: undefined,
    expiresAt: DateTime.makeUnsafe("2026-09-03T12:00:00.000Z"),
  }

  const makeAccessLayer = (verify: AccessVerifier["Service"]["verify"]) =>
    HttpRouter.add(
      "GET",
      "/whoami",
      Effect.map(CurrentAccessIdentity, (identity) =>
        HttpServerResponse.text(`${identity.issuer} ${identity.subject}`),
      ),
    ).pipe(
      Layer.provide(AccessMiddlewareLayer),
      Layer.provide(Layer.succeed(AccessVerifier, { verify })),
      // Production never consults the context; an absent one proves it.
      Layer.provide(
        Layer.succeed(Cloudflare.Workers.WorkerExecutionContext, executionContext(undefined)),
      ),
    )

  const withAccessHandler = <A, E, R>(
    verify: AccessVerifier["Service"]["verify"],
    use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(makeAccessLayer(verify), { disableLogger: true })),
      ({ handler }) => use((request) => handler(request, Context.empty())),
      ({ dispose }) => Effect.promise(dispose),
    )

  it.effect("answers 401 with an empty body when the assertion is missing", () =>
    withAccessHandler(
      () => Effect.die("must not verify"),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(new Request("https://example.com/whoami")),
          )
          assert.strictEqual(response.status, 401)
          assert.strictEqual(yield* Effect.promise(() => response.text()), "")
        }),
    ),
  )

  it.effect("answers 401 when the verifier rejects or cannot fetch keys", () =>
    Effect.gen(function* () {
      const rejected = yield* withAccessHandler(
        () => Effect.fail(new AccessAssertionRejected({ reason: "expired" })),
        (handler) =>
          Effect.promise(() =>
            handler(
              new Request("https://example.com/whoami", {
                headers: { "cf-access-jwt-assertion": "a.b.c" },
              }),
            ),
          ),
      )
      assert.strictEqual(rejected.status, 401)

      const unavailable = yield* withAccessHandler(
        () => Effect.fail(new AccessKeysUnavailable({ cause: "down" })),
        (handler) =>
          Effect.promise(() =>
            handler(
              new Request("https://example.com/whoami", {
                headers: { "cf-access-jwt-assertion": "a.b.c" },
              }),
            ),
          ),
      )
      assert.strictEqual(unavailable.status, 401)
    }),
  )

  it.effect("passes the exact header to the verifier and gives the route the identity", () => {
    const seen: Array<string> = []
    return withAccessHandler(
      (assertion) =>
        Effect.sync(() => {
          seen.push(assertion)
          return identity
        }),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/whoami", {
                headers: { "cf-access-jwt-assertion": "h.p.s" },
              }),
            ),
          )
          assert.strictEqual(response.status, 200)
          assert.strictEqual(
            yield* Effect.promise(() => response.text()),
            "https://team.cloudflareaccess.test user-123",
          )
          assert.deepStrictEqual(seen, ["h.p.s"])
        }),
    )
  })

  describe("local development fallback", () => {
    const LOCAL_AUDIENCE = "local-dev"
    const HEX_AUDIENCE = "a".repeat(64)

    const makeLocalLayer = (
      localDevAudience: string | undefined,
      verify: AccessVerifier["Service"]["verify"],
      access: { aud: string; email?: string } | undefined,
    ) =>
      HttpRouter.add(
        "GET",
        "/whoami",
        Effect.map(CurrentAccessIdentity, (identity) =>
          HttpServerResponse.text(`${identity.issuer} ${identity.subject}`),
        ),
      ).pipe(
        Layer.provide(makeAccessMiddlewareLayer({ localDevAudience })),
        Layer.provide(Layer.succeed(AccessVerifier, { verify })),
        Layer.provide(
          Layer.succeed(Cloudflare.Workers.WorkerExecutionContext, executionContext(access)),
        ),
      )

    const request = (headers: Record<string, string> = {}) =>
      new Request("https://example.com/whoami", { headers })

    const respond = (
      localDevAudience: string | undefined,
      verify: AccessVerifier["Service"]["verify"],
      access: { aud: string; email?: string } | undefined,
      headers?: Record<string, string>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(makeLocalLayer(localDevAudience, verify, access), {
            disableLogger: true,
          }),
        ),
        ({ handler }) => Effect.promise(() => handler(request(headers), Context.empty())),
        ({ dispose }) => Effect.promise(dispose),
      )

    const mustNotVerify = () => Effect.die("must not verify")

    it.effect("answers 401 without a header and without any Access context", () =>
      Effect.gen(function* () {
        const response = yield* respond(LOCAL_AUDIENCE, mustNotVerify, undefined)
        assert.strictEqual(response.status, 401)
      }),
    )

    it.effect("admits the simulated identity when the audience matches", () =>
      Effect.gen(function* () {
        const response = yield* respond(LOCAL_AUDIENCE, mustNotVerify, {
          aud: LOCAL_AUDIENCE,
          email: "dev@janitor.local",
        })
        assert.strictEqual(response.status, 200)
        assert.strictEqual(
          yield* Effect.promise(() => response.text()),
          `${LOCAL_DEV_ISSUER} dev@janitor.local`,
        )
      }),
    )

    it.effect("ignores a simulated context when built without a local audience", () =>
      Effect.gen(function* () {
        // The deploy configuration: the bind phase leaves the audience unset.
        const unset = yield* respond(undefined, mustNotVerify, {
          aud: LOCAL_AUDIENCE,
          email: "dev@janitor.local",
        })
        assert.strictEqual(unset.status, 401)

        const empty = yield* respond("", mustNotVerify, {
          aud: LOCAL_AUDIENCE,
          email: "dev@janitor.local",
        })
        assert.strictEqual(empty.status, 401)
      }),
    )

    it.effect("answers 401 when the context carries any other audience", () =>
      Effect.gen(function* () {
        const response = yield* respond(LOCAL_AUDIENCE, mustNotVerify, {
          aud: HEX_AUDIENCE,
          email: "dev@janitor.local",
        })
        assert.strictEqual(response.status, 401)
      }),
    )

    it.effect("still verifies a supplied header while the fallback is live", () =>
      Effect.gen(function* () {
        const seen: Array<string> = []
        const rejected = yield* respond(
          LOCAL_AUDIENCE,
          (assertion) =>
            Effect.sync(() => {
              seen.push(assertion)
            }).pipe(
              Effect.andThen(Effect.fail(new AccessAssertionRejected({ reason: "expired" }))),
            ),
          { aud: LOCAL_AUDIENCE, email: "dev@janitor.local" },
          { "cf-access-jwt-assertion": "a.b.c" },
        )
        assert.strictEqual(rejected.status, 401)
        assert.deepStrictEqual(seen, ["a.b.c"])

        const accepted = yield* respond(
          LOCAL_AUDIENCE,
          () => Effect.succeed(identity),
          { aud: LOCAL_AUDIENCE, email: "dev@janitor.local" },
          { "cf-access-jwt-assertion": "a.b.c" },
        )
        assert.strictEqual(accepted.status, 200)
        assert.strictEqual(
          yield* Effect.promise(() => accepted.text()),
          "https://team.cloudflareaccess.test user-123",
        )
      }),
    )
  })
})
