import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { GitHubAppAuth, GitHubAppAuthError } from "../../src/GitHub/AppAuth.ts"
import {
  type AcquireDecision,
  type CooldownRequest,
  GitHubBudget,
  type RateObservation,
} from "../../src/GitHub/RateBudget.ts"
import { GitHubTransport } from "../../src/GitHub/Transport.ts"

interface Recorder {
  readonly requests: Array<{ url: string; headers: Record<string, string | undefined> }>
  readonly leases: Array<string>
  readonly released: Array<string>
  readonly recorded: Array<RateObservation>
  readonly cooldowns: Array<CooldownRequest>
  readonly invalidated: Array<string>
}

const makeRecorder = (): Recorder => ({
  requests: [],
  leases: [],
  released: [],
  recorded: [],
  cooldowns: [],
  invalidated: [],
})

type Responder = (index: number) => Response

const run = <A, E>(
  recorder: Recorder,
  responder: Responder,
  use: Effect.Effect<A, E, GitHubTransport>,
  decision: AcquireDecision | ((token: string) => AcquireDecision) = (token) => ({
    _tag: "Granted",
    leaseToken: token,
  }),
  failCredentials = false,
) => {
  let tokenIssue = 0
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      recorder.requests.push({ url: request.url, headers: request.headers })
      return HttpClientResponse.fromWeb(request, responder(recorder.requests.length - 1))
    }),
  )
  return use.pipe(
    Effect.provide(
      GitHubTransport.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(
          Layer.succeed(GitHubAppAuth, {
            appJwt: Effect.succeed(Redacted.make("app-jwt")),
            installationToken: () =>
              failCredentials
                ? Effect.fail(
                    new GitHubAppAuthError({
                      operation: "installationToken",
                      message: "token unavailable",
                    }),
                  )
                : Effect.sync(() => Redacted.make(`ghs_${++tokenIssue}`)),
            invalidateInstallationToken: (id) =>
              Effect.sync(() => void recorder.invalidated.push(id)),
          }),
        ),
        Layer.provide(
          Layer.succeed(GitHubBudget, {
            acquire: (request) =>
              Effect.sync(() => {
                recorder.leases.push(request.leaseToken)
                return typeof decision === "function" ? decision(request.leaseToken) : decision
              }),
            release: (token) => Effect.sync(() => void recorder.released.push(token)),
            record: (observation) =>
              Effect.sync(() => {
                recorder.recorded.push(observation)
                if (observation.cooldown !== undefined)
                  recorder.cooldowns.push({ ...observation, ...observation.cooldown })
              }),
            cooldown: (request) => Effect.sync(() => void recorder.cooldowns.push(request)),
          }),
        ),
      ),
    ),
  )
}

const installation = GitHubInstallationId.make("789")
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  })

describe("GitHubTransport", () => {
  it.effect("attaches installation credentials, records rate headers, and releases the lease", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const response = yield* run(
        recorder,
        () =>
          json(
            { ok: true },
            {
              headers: {
                etag: 'W/"abc"',
                link: '<https://api.github.com/next>; rel="next"',
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4999",
                "x-ratelimit-used": "1",
                "x-ratelimit-reset": "1700000000",
                "x-ratelimit-resource": "core",
                "x-github-request-id": "REQ-1",
              },
            },
          ),
        Effect.flatMap(GitHubTransport, (transport) =>
          transport.request({
            scope: { _tag: "Installation", installationId: installation },
            priority: "background",
            method: "GET",
            url: "/installation/repositories?per_page=100",
            etag: 'W/"old"',
          }),
        ),
      )

      assert.deepStrictEqual(response, {
        _tag: "Ok",
        status: 200,
        body: { ok: true },
        etag: Option.some('W/"abc"'),
        link: Option.some('<https://api.github.com/next>; rel="next"'),
        requestId: Option.some("REQ-1"),
      })
      const sent = recorder.requests[0]
      assert.strictEqual(sent?.url, "https://api.github.com/installation/repositories?per_page=100")
      assert.strictEqual(sent?.headers["authorization"], "Bearer ghs_1")
      assert.strictEqual(sent?.headers["if-none-match"], 'W/"old"')
      assert.strictEqual(sent?.headers["x-github-api-version"], "2022-11-28")
      assert.strictEqual(sent?.headers["user-agent"], "janitor")
      assert.deepStrictEqual(recorder.released, recorder.leases)
      assert.strictEqual(recorder.recorded[0]?.scopeKey, "installation:789")
      assert.strictEqual(recorder.recorded[0]?.headers["x-ratelimit-remaining"], 4999)
    }),
  )

  it.effect("returns NotModified for a 304 and uses the App JWT for App scope", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const response = yield* run(
        recorder,
        () => new Response(null, { status: 304, headers: { "x-github-request-id": "REQ-2" } }),
        Effect.flatMap(GitHubTransport, (transport) =>
          transport.request({
            scope: { _tag: "App" },
            priority: "background",
            method: "GET",
            url: "/app/installations",
          }),
        ),
      )

      assert.deepStrictEqual(response, { _tag: "NotModified", requestId: Option.some("REQ-2") })
      assert.strictEqual(recorder.requests[0]?.headers["authorization"], "Bearer app-jwt")
    }),
  )

  it.effect("refreshes an installation token once after a 401", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const response = yield* run(
        recorder,
        (index) =>
          index === 0 ? json({ message: "Bad credentials" }, { status: 401 }) : json({ id: 1 }),
        Effect.flatMap(GitHubTransport, (transport) =>
          transport.request({
            scope: { _tag: "Installation", installationId: installation },
            priority: "foreground",
            method: "GET",
            url: "/repos/effect/janitor",
          }),
        ),
      )

      assert.strictEqual(response._tag, "Ok")
      assert.deepStrictEqual(recorder.invalidated, ["789"])
      assert.deepStrictEqual(
        recorder.requests.map((request) => request.headers["authorization"]),
        ["Bearer ghs_1", "Bearer ghs_2"],
      )
      assert.strictEqual(recorder.released.length, 2)
    }),
  )

  it.effect("records a retry-after cooldown and fails as rate limited", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const exit = yield* run(
        recorder,
        () =>
          json({ message: "secondary limit" }, { status: 403, headers: { "retry-after": "60" } }),
        Effect.flatMap(GitHubTransport, (transport) =>
          transport.request({
            scope: { _tag: "App" },
            priority: "background",
            method: "GET",
            url: "/x",
          }),
        ),
      ).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.include(String(exit.cause), "GitHubRateLimited")
      assert.strictEqual(recorder.cooldowns[0]?.kind, "secondary")
      assert.strictEqual(recorder.cooldowns[0]?.scopeKey, "app")
      assert.strictEqual(recorder.released.length, 1)
    }),
  )

  it.effect("does not call GitHub when the budget says to wait", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      const until = DateTime.makeUnsafe("2026-09-02T18:00:00.000Z")

      const exit = yield* run(
        recorder,
        () => json({}),
        Effect.flatMap(GitHubTransport, (transport) =>
          transport.request({
            scope: { _tag: "App" },
            priority: "background",
            method: "GET",
            url: "/x",
          }),
        ),
        { _tag: "Wait", until, reason: "reserve" },
      ).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(recorder.requests, [])
    }),
  )

  it.effect("returns Failed for other non-2xx statuses with the decoded body", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const response = yield* run(
        recorder,
        () => json({ message: "Not Found" }, { status: 404 }),
        Effect.flatMap(GitHubTransport, (transport) =>
          transport.request({
            scope: { _tag: "App" },
            priority: "background",
            method: "GET",
            url: "/missing",
          }),
        ),
      )

      assert.deepStrictEqual(response, {
        _tag: "Failed",
        status: 404,
        body: { message: "Not Found" },
        requestId: Option.none(),
      })
    }),
  )
  it.effect("recognizes a secondary limit without rate-limit headers", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      const exit = yield* run(
        recorder,
        () => json({ message: "You have exceeded a secondary rate limit" }, { status: 403 }),
        Effect.flatMap(GitHubTransport, (transport) =>
          transport.request({
            scope: { _tag: "App" },
            priority: "background",
            method: "GET",
            url: "/items",
          }),
        ),
      ).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(recorder.cooldowns[0]?.kind, "secondary")
      assert.strictEqual(recorder.released.length, 1)
    }),
  )

  it.effect("releases the reservation when acquiring credentials fails", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      const exit = yield* run(
        recorder,
        () => json({}),
        Effect.flatMap(GitHubTransport, (transport) =>
          transport.request({
            scope: { _tag: "Installation", installationId: installation },
            priority: "foreground",
            method: "GET",
            url: "/items",
          }),
        ),
        (leaseToken) => ({ _tag: "Granted", leaseToken }),
        true,
      ).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(recorder.released, recorder.leases)
      assert.strictEqual(recorder.requests.length, 0)
    }),
  )
})
