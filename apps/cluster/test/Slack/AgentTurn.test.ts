import { assert, it } from "@effect/vitest"
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import { Sandbox } from "@janitor/alchemy/AI/Sandbox"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { runAgentTurn } from "../../src/Slack/AgentTurn.ts"
import { Repositories } from "../../src/Slack/Repositories.ts"
import type { SessionState } from "../../src/Slack/Session.ts"
import { TurnEvents, type TurnEvent } from "../../src/Slack/TurnEvents.ts"

it.effect("logs provider failure category and status without sensitive data", () =>
  Effect.gen(function* () {
    const logs: unknown[] = []
    const model = OpenAiLanguageModel.layer({ model: "test" }).pipe(
      Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make("secret-api-key") })),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ error: { message: "private-provider-body" } }, { status: 401 }),
              ),
            ),
          ),
        ),
      ),
    )
    const unavailable = () => Effect.die("Unexpected repository operation")
    const home = {
      workspace: "T1",
      channel: "C1",
      thread: "1.0",
      timestamp: "1.0",
      user: "U1",
      text: "private-conversation",
      mentioned: true,
    }
    const result = yield* runAgentTurn(
      home,
      {
        home,
        history: null,
        repository: null,
        pending: [],
        seen: [],
        turn: { _tag: "Idle" },
      },
      unavailable,
    ).pipe(
      Effect.result,
      Effect.provide(model),
      Effect.provideService(Sandbox, {
        exec: unavailable,
        readFile: unavailable,
        writeFile: unavailable,
        deleteFile: unavailable,
        mkdir: unavailable,
        listFiles: unavailable,
        exists: unavailable,
      }),
      Effect.provideService(Repositories, {
        list: Effect.succeed([]),
        get: unavailable,
        credentials: unavailable,
      }),
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(options.message)
          }),
        ]),
      ),
    )
    assert.strictEqual(result._tag, "Failure")
    const output = JSON.stringify(logs)
    assert.include(output, "AuthenticationError")
    assert.include(output, "401")
    for (const sensitive of ["secret-api-key", "private-provider-body", "private-conversation"]) {
      assert.notInclude(output, sensitive)
    }
  }),
)

it.effect(
  "lists repositories, asks for clarification, and continues without starting a sandbox",
  () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const observations: TurnEvent[] = []
      const commentarySent = yield* Deferred.make<void>()
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag === "Uint8Array")
            requests.push(new TextDecoder().decode(request.body.body))
          const first = requests.length === 1
          const message = first
            ? {
                role: "assistant",
                content: "I'll check the connected repositories.",
                reasoning_content: "Private reasoning must never be posted.",
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
            new Response(
              `data: ${JSON.stringify({
                id: "completion",
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                service_tier: null,
                choices: [
                  {
                    index: 0,
                    delta: {
                      ...message,
                      ...(message.tool_calls === undefined
                        ? {}
                        : {
                            tool_calls: message.tool_calls.map((call, index) => ({
                              ...call,
                              index,
                            })),
                          }),
                    },
                    finish_reason: first ? "tool_calls" : "stop",
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
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
        assert.deepStrictEqual(observations, [
          { type: "commentary", text: "I'll check the connected repositories." },
          { type: "tool-call", id: "call-1", name: "listRepositories" },
          { type: "tool-result", id: "call-1" },
        ])
        assert.include(requests[1] ?? "", "effect/effect")
        const second = yield* runAgentTurn(
          { ...home, user: "U2", timestamp: "2.0", text: "First, tell me how you work" },
          { ...state, history: first.history },
          unavailable,
        )
        assert.strictEqual(second.text, "What would you like to know?")
        assert.include(requests[2] ?? "", "Which repository should I inspect?")
        assert.include(requests[2] ?? "", "First, tell me how you work")
        assert.include(requests[2] ?? "", "U2: First, tell me how you work")
      }).pipe(
        Effect.provide(model),
        Effect.provideService(TurnEvents, {
          emit: Effect.fnUntraced(function* (event) {
            observations.push(event)
            if (event.type === "commentary") yield* Deferred.succeed(commentarySent, undefined)
          }),
        }),
        Effect.provideService(Sandbox, sandbox),
        Effect.provideService(Repositories, {
          // The tool cannot finish until its introductory commentary is delivered.
          list: Deferred.await(commentarySent).pipe(Effect.as([repository])),
          get: () => Effect.succeed(repository),
          credentials: unavailable,
        }),
      )
    }),
)
