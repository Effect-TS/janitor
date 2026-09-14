import { expect, it } from "vitest"
import { writeFileSync } from "node:fs"
import deployment from "../model-configurations/openrouter-llama-3.1-8b.json"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"
import { modelRepository } from "./support/ModelRepository.ts"

const authorized = process.env.JANITOR_ALLOW_MODEL_SMOKE === deployment.default

const validate = async (live: boolean) => {
  const secret = live ? process.env.JANITOR_AGENT_RUNNER_MODEL_API_KEY : "controlled-smoke-key"
  if (!secret) throw new Error("Provide the team model credential through the runner environment")
  const reportPath = live ? process.env.JANITOR_MODEL_SMOKE_REPORT : undefined
  if (live && !reportPath)
    throw new Error("Set JANITOR_MODEL_SMOKE_REPORT to a credential-free evidence file")
  const repository = modelRepository()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  const traces: Array<{
    status: number
    toolFragments: Record<string, number>
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
      completion_tokens_details?: { reasoning_tokens?: number }
    }
  }> = []
  let requests = 0
  let passed = false
  let harness: Harness | undefined
  try {
    harness = await Harness.start({
      bindings: {
        ...repository.bindings,
        JANITOR_AGENT_RUNNER_MODEL_API_KEY: secret,
        JANITOR_TEST_LIVE_MODEL: "true",
        JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify(deployment),
      },
      serviceBindings: repository.serviceBindings,
      outboundService: async (request) => {
        const body = await request.text()
        const parsed = JSON.parse(body)
        // OpenRouter strict routing must not exclude Groq with OpenAI-only options.
        expect(parsed).not.toHaveProperty("store")
        expect(parsed).not.toHaveProperty("prompt_cache_key")
        expect(parsed).not.toHaveProperty("max_completion_tokens")
        expect(parsed.max_tokens).toBe(2048)
        // Every retry and compaction request spends this same allowance. No body rewrite.
        if (
          ++requests > 8 ||
          controller.signal.aborted ||
          request.url !== "https://openrouter.ai/api/v1/chat/completions" ||
          parsed.model !== "meta-llama/llama-3.1-8b-instruct" ||
          JSON.stringify(parsed.provider?.only) !== JSON.stringify(["groq"]) ||
          parsed.provider?.allow_fallbacks !== false ||
          parsed.provider?.require_parameters !== true ||
          parsed.stream !== true ||
          (parsed.max_completion_tokens ?? parsed.max_tokens) !== 2048 ||
          new TextEncoder().encode(body).byteLength > 131072
        )
          return Response.json(
            { error: { message: "Live model validation request ceiling reached" } },
            { status: 400 },
          )
        const response = live
          ? await fetch(request.url, {
              method: "POST",
              headers: request.headers,
              body,
              signal: controller.signal,
            })
          : scriptedResponse(requests, body)
        const trace: (typeof traces)[number] = { status: response.status, toolFragments: {} }
        traces.push(trace)
        let pending = ""
        const decoder = new TextDecoder()
        return new Response(
          response.body?.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, output) {
                pending += decoder.decode(chunk, { stream: true })
                const lines = pending.split("\n")
                pending = lines.pop()!
                for (const line of lines) {
                  if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") continue
                  const event = JSON.parse(line.slice(6))
                  if (event.usage) {
                    const raw = event.usage
                    const count = (value: unknown) =>
                      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
                    trace.usage = {
                      prompt_tokens: count(raw.prompt_tokens),
                      completion_tokens: count(raw.completion_tokens),
                      prompt_tokens_details: {
                        cached_tokens: count(raw.prompt_tokens_details?.cached_tokens),
                        cache_write_tokens: count(raw.prompt_tokens_details?.cache_write_tokens),
                      },
                      completion_tokens_details: {
                        reasoning_tokens: count(raw.completion_tokens_details?.reasoning_tokens),
                      },
                    }
                  }
                  for (const call of event.choices?.[0]?.delta?.tool_calls ?? [])
                    if (call.function?.arguments)
                      trace.toolFragments[String(call.index)] =
                        (trace.toolFragments[String(call.index)] ?? 0) + 1
                }
                output.enqueue(chunk)
              },
            }),
          ),
          { status: response.status, headers: response.headers },
        )
      },
    })
    const session = harness.session(uniqueSessionId("live-model"))
    await session.faults({ intervalMs: 400 })
    await session.create({ repositoryId: "123" })
    const idle = async () => {
      const state = await waitFor(
        () => session.inspect(),
        (value) => value.execution === "idle" || value.execution === "failed",
        {
          label: "bounded live model turn",
          timeoutMs: 60_000,
        },
      )
      expect(state.lastOutcome).toBe("succeeded")
    }
    await session.admit({ inputId: "msg_live_seed", text: "Reply ready. Do not use tools yet." })
    await idle()
    await session.admit({
      inputId: "msg_live_tools",
      text: "Call read twice in the same response, once for README.md and once for NOTES.md. Then report both validation codes. Do not write files, run shell commands, or publish.",
    })
    await idle()
    const before = await session.allEvents()
    expect(
      before.events.filter((event: any) => event.type === "session.tool.success").length,
    ).toBeGreaterThanOrEqual(2)
    await harness.call("POST", `/__test/sessions/${session.id}/compact`)
    await waitFor(
      () => session.allEvents(),
      (value) => value.events.some((event: any) => event.type === "session.compaction.ended"),
      {
        label: "native live compaction",
        timeoutMs: 60_000,
      },
    )
    await session.admit({
      inputId: "msg_live_continue",
      text: "Use retained tool history to repeat both validation codes. Do not call tools.",
    })
    await idle()
    const after = await session.allEvents()
    const summary = after.events.find((event: any) => event.type === "session.compaction.ended")
    expect(JSON.stringify(summary.data)).toContain("apricot-47")
    expect(JSON.stringify(summary.data)).toContain("cobalt-29")
    const text = after.events.filter((event: any) => event.type === "session.text.ended").at(-1)
      ?.data.text
    expect(text).toContain("apricot-47")
    expect(text).toContain("cobalt-29")
    expect(traces.some((trace) => Object.keys(trace.toolFragments).length >= 2)).toBe(true)
    expect(
      traces.some((trace) => Object.values(trace.toolFragments).some((count) => count > 1)),
    ).toBe(true)
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    for (const trace of traces) {
      expect(trace.usage).toBeDefined()
      const raw = trace.usage!
      const read = raw.prompt_tokens_details?.cached_tokens ?? 0
      const write = raw.prompt_tokens_details?.cache_write_tokens ?? 0
      const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? 0
      usage.input += (raw.prompt_tokens ?? 0) - read - write
      usage.output += (raw.completion_tokens ?? 0) - reasoning
      usage.reasoning += reasoning
      usage.cacheRead += read
      usage.cacheWrite += write
    }
    expect(usage.input).toBeGreaterThan(0)
    expect(after.usage).toMatchObject(usage)
    expect(JSON.stringify(after).includes(secret)).toBe(false)
    passed = true
  } finally {
    controller.abort()
    clearTimeout(timer)
    try {
      await harness?.dispose()
    } finally {
      repository.dispose()
    }
    if (reportPath)
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            modelConfiguration: deployment.default,
            time: new Date().toISOString(),
            passed,
            requests,
            traces,
          },
          null,
          2,
        ) + "\n",
      )
  }
}

it(
  "exercises the bounded driver through the production HTTP transport with controlled responses",
  () => validate(false),
  120_000,
)
it.skipIf(!authorized)(
  "validates live native streaming, tools, usage and local compaction",
  () => validate(true),
  240_000,
)

function scriptedResponse(request: number, body: string) {
  const frame = (delta: unknown, finish: string | null = null, usage: unknown = undefined) =>
    "data: " +
    JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], usage }) +
    "\n\n"
  const usage = {
    prompt_tokens: 11,
    completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 18,
  }
  const data =
    request === 2
      ? frame({
          role: "assistant",
          tool_calls: [0, 1].map((index) => ({
            index,
            id: `call_smoke_${index}`,
            type: "function",
            function: { name: "read", arguments: '{"path":' },
          })),
        }) +
        frame({
          tool_calls: [0, 1].map((index) => ({
            index,
            function: {
              arguments: JSON.stringify(index === 0 ? "README.md" : "NOTES.md") + "}",
            },
          })),
        }) +
        frame({}, "tool_calls", usage)
      : frame({
          role: "assistant",
          content: body.includes("Return only the structured summary")
            ? "## Objective\nValidate the model.\n## Work state\nRead files.\n## Next move\nUse retained tool results."
            : request === 1
              ? "Ready."
              : "apricot-47 and cobalt-29",
        }) + frame({}, "stop", usage)
  return new Response(data + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}
