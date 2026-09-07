import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
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
