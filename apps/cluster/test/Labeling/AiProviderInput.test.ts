import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient"
import * as OpenRouterDecisionModel from "@effect/ai-openrouter/OpenRouterDecisionModel"
import { prepareClassifierInput } from "@janitor/domain/Labeling/Policy/AiInput"
import { snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import { ClassifierProvider, type ClassifierQuery } from "../../src/Labeling/Classifier.ts"

const provider = (http: HttpClient.HttpClient) =>
  ClassifierProvider.fromDecisionModel({ provider: "openrouter", model: "typesafe/jev-1.13" }).pipe(
    Layer.provide(OpenRouterDecisionModel.layer({ model: "typesafe/jev-1.13" })),
    Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make("test-key") })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  )

const decide = (http: HttpClient.HttpClient, queries: ReadonlyArray<ClassifierQuery>) =>
  Effect.gen(function* () {
    return yield* (yield* ClassifierProvider).decide(queries)
  }).pipe(Effect.provide(provider(http)))

const respond = (request: HttpClientRequest.HttpClientRequest, status: number, body: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const requestJson = (request: HttpClientRequest.HttpClientRequest): any =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : null

const query = (instructions: string, title: string): ClassifierQuery => ({
  instructions,
  state: { evidence: { title }, omissions: [] },
})

const noul = (probability: number) => ({ type: "noul", noul: probability })

it.effect("keeps the serialized decision request within the prepared byte budget", () =>
  Effect.gen(function* () {
    const prepared = prepareClassifierInput(
      "Classify {{fact:body}}",
      ["body"],
      snapshotFacts({
        kind: "issue",
        title: "Title",
        body: '🔥 code "quoted" \\n'.repeat(2000),
        authorLogin: "author",
        state: "open",
        labels: [],
        pullRequest: null,
      }),
    )
    assert.strictEqual(prepared._tag, "Prepared")
    if (prepared._tag !== "Prepared") return
    let requestBytes = 0
    let calls = 0
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++
        assert.strictEqual(request.body._tag, "Uint8Array")
        if (request.body._tag === "Uint8Array") requestBytes = request.body.body.byteLength
        return respond(request, 400, { error: { message: "unavailable" } })
      }),
    )
    yield* decide(http, [{ instructions: "Classify {{fact:body}}", state: prepared.state }]).pipe(
      Effect.flip,
    )
    assert.strictEqual(calls, 1)
    assert.isAbove(requestBytes, 0)
    assert.isAtMost(requestBytes, prepared.report.suppliedBytes)
    assert.isAtMost(requestBytes, prepared.report.budgetBytes)
  }),
)

it.effect("asks two questions per rule in one request and answers in rule order", () =>
  Effect.gen(function* () {
    const sent: Array<{ url: string; authorization: string | undefined; body: any }> = []
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        sent.push({
          url: request.url,
          authorization: request.headers["authorization"],
          body: requestJson(request),
        })
        // Jev rounds to two decimals; the answers arrive keyed, not ordered.
        return respond(request, 200, {
          model: "typesafe/jev-1.13-20260917",
          answers: {
            r1_sufficient: noul(0.4),
            r0_matches: noul(0.93),
            r1_matches: noul(0.07),
            r0_sufficient: noul(0.98),
          },
          usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 },
        })
      }),
    )
    const answers = yield* decide(http, [
      query("Is {{fact:title}} a bug?", "Crash on start"),
      query("Is {{fact:title}} a question?", "Docs"),
    ])
    assert.deepStrictEqual(answers, [
      { matches: 0.93, sufficient: 0.98 },
      { matches: 0.07, sufficient: 0.4 },
    ])
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0]!.url, "https://openrouter.ai/api/alpha/decisions")
    assert.strictEqual(sent[0]!.authorization, "Bearer test-key")
    const body = sent[0]!.body
    assert.strictEqual(body.model, "typesafe/jev-1.13")
    assert.deepStrictEqual(body.state, {
      r0: { evidence: { title: "Crash on start" }, omissions: [] },
      r1: { evidence: { title: "Docs" }, omissions: [] },
    })
    assert.deepStrictEqual(Object.keys(body.questions).sort(), [
      "r0_matches",
      "r0_sufficient",
      "r1_matches",
      "r1_sufficient",
    ])
    assert.strictEqual(body.questions.r1_matches.type, "noul")
    assert.include(body.questions.r1_matches.instructions, "Is state.r1.evidence.title a question?")
    assert.include(body.questions.r1_matches.instructions, "Use only state.r1.")
    assert.include(body.questions.r0_sufficient.instructions, "Is state.r0.evidence.title a bug?")
  }),
)

it.effect("rejects an answer set that misses a rule's question as retryable", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        respond(request, 200, {
          model: "typesafe/jev-1.13",
          answers: { r0_matches: noul(0.9) },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      ),
    )
    const error = yield* decide(http, [query("{{fact:title}}?", "Title")]).pipe(Effect.flip)
    assert.include(error.message, "invalid answer")
    assert.strictEqual(error.retryable, true)
  }),
)

it.effect("reports actionable provider errors without exposing response bodies", () =>
  Effect.gen(function* () {
    for (const [status, guidance, retryable] of [
      [401, "OPENROUTER_API_KEY", false],
      [400, "LABELING_AI_MODEL", false],
      [402, "credit", false],
      [429, "rate limit", true],
      [500, "Try again", true],
    ] as const) {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          respond(request, status, { error: { message: "sensitive provider detail" } }),
        ),
      )
      const error = yield* decide(http, [query("{{fact:title}}?", "Title")]).pipe(Effect.flip)
      assert.strictEqual(error.retryable, retryable, `status ${status}`)
      assert.include(error.message, guidance)
      assert.notInclude(error.message, "sensitive provider detail")
    }
  }),
)

it.effect("times out a stalled provider request with actionable guidance", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const http = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    )
    const fiber = yield* decide(http, [query("{{fact:title}}?", "Title")]).pipe(
      Effect.flip,
      Effect.forkChild,
    )
    yield* Deferred.await(started)
    yield* TestClock.adjust("16 seconds")
    const error = yield* Fiber.join(fiber)
    assert.strictEqual(error.retryable, true)
    assert.include(error.message, "timed out")
    assert.include(error.message, "Try again")
  }),
)

it.effect("honors Retry-After seconds and dates on rate limits and server errors", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    for (const status of [429, 503])
      for (const value of ["7", "Thu, 01 Jan 1970 00:00:07 GMT"]) {
        const http = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ error: { message: "unavailable" } }), {
                status,
                headers: { "content-type": "application/json", "retry-after": value },
              }),
            ),
          ),
        )
        const error = yield* decide(http, [query("{{fact:title}}?", "Title")]).pipe(Effect.flip)
        assert.strictEqual(error.retryable, true)
        assert.strictEqual(error.retryAfterMs, 7000)
      }
  }),
)
