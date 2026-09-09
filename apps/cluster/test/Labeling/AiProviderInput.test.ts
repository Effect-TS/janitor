import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import { prepareClassifierInput } from "@janitor/domain/Labeling/Policy/AiInput"
import { snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import { ClassifierProvider } from "../../src/Labeling/Classifier.ts"

it.effect("keeps the serialized provider request within the prepared byte budget", () =>
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
        return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 400 }))
      }),
    )
    const Provider = ClassifierProvider.fromLanguageModel({
      provider: "openai",
      model: "gpt-5.6-luna",
    }).pipe(
      Layer.provide(
        OpenAiLanguageModel.layer({
          model: "gpt-5.6-luna",
          config: { max_completion_tokens: 1000 },
        }),
      ),
      Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make("test") })),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    )
    yield* Effect.gen(function* () {
      yield* (yield* ClassifierProvider).ask(prepared.text).pipe(Effect.flip)
    }).pipe(Effect.provide(Provider))
    assert.strictEqual(calls, 1)
    assert.isAbove(requestBytes, 0)
    assert.isAtMost(requestBytes, prepared.report.suppliedBytes)
    assert.isAtMost(requestBytes, prepared.report.budgetBytes)
  }),
)

const failingProvider = (http: HttpClient.HttpClient) =>
  ClassifierProvider.fromLanguageModel({ provider: "openai", model: "test-model" }).pipe(
    Layer.provide(OpenAiLanguageModel.layer({ model: "test-model" })),
    Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make("test") })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  )

it.effect("reports actionable provider errors without exposing response bodies", () =>
  Effect.gen(function* () {
    for (const [status, guidance] of [
      [401, "API key"],
      [400, "model"],
      [429, "rate limit"],
      [500, "Try again"],
    ] as const) {
      const provider = failingProvider(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ error: { message: "sensitive provider detail" } }), {
                status,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
      )
      const error = yield* Effect.gen(function* () {
        return yield* (yield* ClassifierProvider).ask("test").pipe(Effect.flip)
      }).pipe(Effect.provide(provider))
      assert.include(error.message, guidance)
      assert.notInclude(error.message, "sensitive provider detail")
    }
  }),
)

it.effect("times out a stalled provider request with actionable guidance", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const provider = failingProvider(
      HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    )
    const fiber = yield* Effect.gen(function* () {
      return yield* (yield* ClassifierProvider).ask("test").pipe(Effect.flip)
    }).pipe(Effect.provide(provider), Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust("61 seconds")
    const error = yield* Fiber.join(fiber)
    assert.include(error.message, "timed out")
    assert.include(error.message, "Try again")
  }),
)
