import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { assert, expect, it } from "vite-plus/test"
import { Effect } from "effect"
import {
  inferRepository,
  readInferenceRequest,
  repositorySelectionPrompt,
} from "../src/RepositoryInference.ts"

const input = {
  preferredOrganization: "Effect-TS",
  instructions: ["Fix the library mentioned above"],
  discussion: "We are discussing the Effect library",
  repositories: [
    { repositoryId: "1", owner: "Effect-TS", repo: "effect" },
    { repositoryId: "2", owner: "other", repo: "effect" },
  ],
}
const env = {
  JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify({
    default: "agent",
    records: [
      {
        id: "agent",
        provider: "test",
        apiModelId: "agent-model",
        route: "openai-chat",
        endpoint: "https://inference.test/v1",
        secretBinding: "TEST_MODEL_SECRET",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 100000, output: 1000 },
      },
    ],
  }),
  TEST_MODEL_SECRET: "test-private-credential",
}

it("uses the agent configuration and selection prompt, validating the returned ID", async () => {
  let decision: unknown = {
    kind: "selected",
    repositoryId: "1",
    reason: "The thread identifies the library.",
  }
  const requests: Record<string, unknown>[] = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      ) as Record<string, unknown>
      requests.push(body)
      assert.include(request.url, "inference.test")
      assert.strictEqual(request.headers.authorization, "Bearer test-private-credential")
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: JSON.stringify(decision) },
                  finish_reason: null,
                },
              ],
            }) +
            "\n\n" +
            "data: " +
            JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
            }) +
            "\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }),
  )
  const run = () =>
    inferRepository(input, env).pipe(Effect.provideService(HttpClient.HttpClient, client))
  const selected = await Effect.runPromise(run())
  assert.deepEqual(selected, decision)
  assert.strictEqual(requests[0]!.model, "agent-model")
  assert.include(JSON.stringify(requests[0]!.messages), "assume Effect-TS")
  assert.include(JSON.stringify(requests[0]!.messages), "We are discussing the Effect library")
  decision = { kind: "clarification", question: "Which of these repositories?" }
  assert.deepEqual(await Effect.runPromise(run()), decision)
  decision = { kind: "selected", repositoryId: "999", reason: "An invented repository" }
  const failure = await Effect.runPromise(run().pipe(Effect.flip))
  assert.strictEqual(failure.code, "transport")
  assert.notInclude(failure.message, env.TEST_MODEL_SECRET)
  decision = "malformed output"
  assert.strictEqual((await Effect.runPromise(run().pipe(Effect.flip))).code, "transport")
})

it("validates the inference request and makes the organization preference overridable", async () => {
  assert.include(repositorySelectionPrompt("acme"), "assume acme")
  assert.deepEqual(
    await readInferenceRequest(
      new Request("https://runner/v1/repository-inference", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    ),
    input,
  )
  await expect(
    readInferenceRequest(
      new Request("https://runner/v1/repository-inference", {
        method: "POST",
        body: '{"instructions":[]}',
      }),
    ),
  ).rejects.toThrow("Invalid repository inference request")
})
