import { assert, it } from "@effect/vitest"
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import { Sandbox } from "@janitor/alchemy/AI/Sandbox"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { runAgentTurn } from "../../src/Slack/AgentTurn.ts"
import { Repositories } from "../../src/Slack/Repositories.ts"
import type { SessionState } from "../../src/Slack/Session.ts"

it.effect(
  "lists repositories, asks for clarification, and continues without starting a sandbox",
  () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag === "Uint8Array")
            requests.push(new TextDecoder().decode(request.body.body))
          const first = requests.length === 1
          const message = first
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "listRepositories", arguments: "{}" },
                  },
                ],
              }
            : {
                role: "assistant",
                content:
                  requests.length === 2
                    ? "Which repository should I inspect?"
                    : "What would you like to know?",
              }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: "completion",
              object: "chat.completion",
              created: 1,
              model: "test",
              choices: [{ index: 0, message, finish_reason: first ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            }),
          )
        }),
      )
      const model = OpenAiLanguageModel.layer({ model: "test" }).pipe(
        Layer.provide(
          OpenAiClient.layer({
            apiKey: Redacted.make("test"),
            apiUrl: "https://openrouter.ai/api/v1",
          }),
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      )
      const unavailable = () => Effect.die("Conversation must not access the sandbox")
      const sandbox = Sandbox.of({
        exec: unavailable,
        readFile: unavailable,
        writeFile: unavailable,
        deleteFile: unavailable,
        mkdir: unavailable,
        listFiles: unavailable,
        exists: unavailable,
      })
      const repository = { id: "42", name: "effect/effect", installation: "7" }
      const home = {
        workspace: "T1",
        channel: "C1",
        thread: "1.0",
        timestamp: "1.0",
        user: "U1",
        text: "Can you help?",
        mentioned: true,
      }
      const state: SessionState = {
        home,
        history: null,
        repository: null,
        pending: [],
        seen: [],
        turn: { _tag: "Idle" },
      }
      yield* Effect.gen(function* () {
        const first = yield* runAgentTurn(home, state, unavailable)
        assert.strictEqual(first.text, "Which repository should I inspect?")
        assert.include(requests[1] ?? "", "effect/effect")
        const second = yield* runAgentTurn(
          { ...home, timestamp: "2.0", text: "First, tell me how you work" },
          { ...state, history: first.history },
          unavailable,
        )
        assert.strictEqual(second.text, "What would you like to know?")
        assert.include(requests[2] ?? "", "Which repository should I inspect?")
        assert.include(requests[2] ?? "", "First, tell me how you work")
      }).pipe(
        Effect.provide(model),
        Effect.provideService(Sandbox, sandbox),
        Effect.provideService(Repositories, {
          list: Effect.succeed([repository]),
          get: () => Effect.succeed(repository),
          credentials: unavailable,
        }),
      )
    }),
)
