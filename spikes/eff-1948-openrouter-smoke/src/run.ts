// One review run of clanka's loop, configured the way janitor's PR review
// (EFF-1996) will configure it:
//
// - executor in RPC mode behind a local HTTP server, on a scratch checkout of
//   a merged Effect-TS/effect PR;
// - `gh`, `webSearch`, `fetchMarkdown` and `delegate` left out; commands capped
//   at 3 minutes; model-call retries bounded;
// - instructions from the base branch, no skills;
// - stub `reportFinding` / `updateThread` loop-side tools;
// - the model from EFF-1929 through `@effect/ai-openrouter` (or, with
//   `--provider openai`, clanka's `@effect/ai-openai` Responses path).
//
// Every model request and streamed response is written to
// `<out>/http/`, with credentials redacted, and the Agent's output events to
// `<out>/events.ndjson`. `<out>/summary.json` has the per-turn numbers.
//
//   node src/run.ts --pr 9161 --run 1 [--provider openrouter|openai]
//     [--model openai/gpt-6.1-sol] [--effort medium] [--max-turns N]

import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import type * as AgentOutput from "clanka/AgentOutput"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServer from "effect/http/HttpServer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"

import { type CaptureRecord, makeCapturingFetch } from "./capture.ts"
import { indexDiff } from "./diff.ts"
import { ReviewTools, makeReviewState, reviewHandlers } from "./tools.ts"
import { type TurnEvent, deriveTurns } from "./turns.ts"

// ---------------------------------------------------------------------------
// Arguments and inputs
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    pr: { type: "string" },
    run: { type: "string" },
    provider: { type: "string", default: "openrouter" },
    model: { type: "string", default: "openai/gpt-6.1-sol" },
    effort: { type: "string", default: "medium" },
    "max-turns": { type: "string" },
    out: { type: "string" },
  },
})

if (args.pr === undefined || args.run === undefined) {
  console.error("usage: node src/run.ts --pr <number> --run <n> [--provider openrouter|openai]")
  process.exit(2)
}

const pr = Number(args.pr)
const runNumber = Number(args.run)
const provider = args.provider as "openrouter" | "openai"
const modelName = args.model!
const effort = args.effort as "low" | "medium" | "high"
const maxTurns = args["max-turns"] === undefined ? Infinity : Number(args["max-turns"])

const harnessDir = path.resolve(import.meta.dirname, "..")
const checkout = path.join(harnessDir, "scratch", `pr-${pr}`)
const outDir = args.out ?? path.join(harnessDir, "results", provider, `run-${runNumber}-pr${pr}`)
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const git = (...argv: Array<string>) =>
  execFileSync("git", argv, { cwd: checkout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

// Fresh tree for every run: the model may write scratchpad probes.
git("checkout", "--", ".")
git("clean", "-fdq")

const headSha = git("rev-parse", "HEAD").trim()
const baseSha = git("rev-parse", "HEAD~1").trim()
const diff = git("diff", "HEAD~1")
const diffIndex = indexDiff(diff)
// Instructions from the base branch, not from the PR head the author controls.
const baseInstructions = git("show", `${baseSha}:.agents/AGENTS.md`)

const prMeta = JSON.parse(
  execFileSync("gh", ["pr", "view", String(pr), "--repo", "Effect-TS/effect", "--json", "title,body,url"], {
    encoding: "utf8",
  }),
) as { title: string; body: string; url: string }

const prompt = `Review pull request #${pr} of Effect-TS/effect: "${prMeta.title}".

The working directory is a checkout of the repository at the PR's squash-merge commit, so \`git diff HEAD~1\` is the PR diff (it is also pasted below). Dependencies are installed: \`pnpm test --run <test file>\` works from the repository root. Every command is limited to 3 minutes, so run targeted test files and small \`node\` probes; do not run \`pnpm check\`, \`pnpm lint\` or the whole suite.

Do the review in this order:
1. Read the changed code and enough of the surrounding implementation to judge it.
2. Run the test file(s) the change touches, and at least one ad-hoc probe of the new behaviour (for example a scratchpad script run with \`node\`).
3. Report each finding with \`reportFinding\`, anchored on a line of the diff. Report at least two findings; a question or a nit counts when there is nothing serious. When a call is rejected, read the error and fix the call.
4. Once you have test or probe results, append them to the relevant finding's thread with \`updateThread\`.
5. Finish with \`taskComplete\`, giving a short verdict (approve or request changes) and why.

PR description:
${prMeta.body.trim()}

Diff:
\`\`\`diff
${diff}
\`\`\`
`

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const startedAt = Date.now()
const eventsFile = path.join(outDir, "events.ndjson")
const captures: Array<CaptureRecord> = []
const reviewState = makeReviewState()

interface TurnText {
  readonly turn: number
  reasoning: string
  script: string
  scriptOutput: string | undefined
}

const events: Array<TurnEvent> = []
const texts: Array<TurnText> = []
let current: TurnText = { turn: 1, reasoning: "", script: "", scriptOutput: undefined }
texts.push(current)
let lastUsage: AgentOutput.Usage | undefined
const retries: Array<{ at: number; error: string }> = []
const history: Array<{ at: number; kind: string; roles: Array<string> }> = []
let finished: { summary: string } | undefined
let failure: string | undefined

const describeError = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

const record = (event: AgentOutput.Output) =>
  Effect.sync(() => {
    const at = Date.now()
    let logged: Record<string, unknown> = event as unknown as Record<string, unknown>
    switch (event._tag) {
      case "ReasoningDelta":
        current.reasoning += event.delta
        return
      case "ScriptDelta":
        current.script += event.delta
        return
      case "ScriptOutput":
        current.scriptOutput = event.output
        logged = { _tag: event._tag, chars: event.output.length }
        break
      case "Usage":
        lastUsage = event
        logged = {
          _tag: event._tag,
          contextTokens: event.contextTokens,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheRead: event.cacheRead,
          cacheWrite: event.cacheWrite,
        }
        break
      case "ErrorRetry":
        retries.push({ at, error: describeError(event.error) })
        logged = { _tag: event._tag, error: describeError(event.error) }
        break
      case "HistoryAppended":
      case "HistoryReplaced":
        history.push({ at, kind: event._tag, roles: event.messages.map((m) => m.role) })
        logged = { _tag: event._tag, roles: event.messages.map((m) => m.role) }
        break
      case "AgentStart":
        logged = { _tag: event._tag, provider: event.provider, model: event.model }
        break
      default:
        logged = { _tag: event._tag }
        break
    }
    const entry = { at, turn: current.turn, ...logged }
    events.push(entry as TurnEvent)
    fs.appendFileSync(eventsFile, JSON.stringify(entry) + "\n")
    // The model stream's `finish` part closes the turn; the next starts now.
    if (event._tag === "Usage") {
      current = { turn: current.turn + 1, reasoning: "", script: "", scriptOutput: undefined }
      texts.push(current)
    }
  })

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

// Every request to the model provider is recorded; executor RPC traffic to
// 127.0.0.1 is not. `FetchHttpClient.Fetch` is a reference read per request,
// so it is provided to the whole run below, not to a layer.
const capturingFetch = makeCapturingFetch(
  path.join(outDir, "http"),
  (url) => /openrouter\.ai|api\.openai\.com/.test(url),
  (r) => captures.push(r),
)

const key = (name: string) => {
  const value = process.env[name]
  if (value === undefined || value === "") {
    console.error(`${name} is not set`)
    process.exit(2)
  }
  return Redacted.make(value)
}

const ModelLayer =
  provider === "openrouter"
    ? OpenRouterLanguageModel.model(modelName, { reasoning: { effort } }).pipe(
        Layer.provide(OpenRouterClient.layer({ apiKey: key("OPENROUTER_API_KEY") })),
        Layer.provide(FetchHttpClient.layer),
      )
    : OpenAiLanguageModel.model(modelName.replace(/^openai\//, ""), {
        reasoning: { effort, summary: "auto" },
        store: false,
        include: ["reasoning.encrypted_content"],
      }).pipe(
        Layer.provide(OpenAiClient.layer({ apiKey: key("OPENAI_API_KEY") })),
        Layer.provide(FetchHttpClient.layer),
      )

// janitor's executor configuration: the four tools left out, commands capped
// at 3 minutes. The executor serves clanka's RPC protocol over a local HTTP
// server; the Agent talks to it through `AgentExecutor.layerRpc`.
const ExecutorLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffect()
    yield* Layer.build(
      AgentExecutor.layerRpcServer({
        directory: checkout,
        excludeTools: ["gh", "webSearch", "fetchMarkdown", "delegate"],
        limits: {
          commandTimeout: "3 minutes",
          scriptTimeout: "8 minutes",
          commandOutputChars: 30_000,
        },
      }).pipe(Layer.provide(Layer.succeed(RpcServer.Protocol, protocol))),
    )
    yield* HttpServer.serveEffect(httpEffect)
    const server = yield* HttpServer.HttpServer
    const address = server.address as { readonly port?: number }
    const url = `http://127.0.0.1:${address.port}/`
    fs.appendFileSync(eventsFile, JSON.stringify({ at: Date.now(), executor: url }) + "\n")
    return AgentExecutor.layerRpc.pipe(
      Layer.provide(RpcClient.layerProtocolHttp({ url })),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerNdjson),
    )
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeHttpServer.layer(() => createServer(), { port: 0 }),
      NodeServices.layer,
      FetchHttpClient.layer,
      RpcSerialization.layerNdjson,
    ),
  ),
)

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

class HarnessStop extends Error {
  readonly _tag = "HarnessStop"
}

const review = Effect.gen(function* () {
  const agent = yield* Agent.makeWith({
    instructions: Option.some(baseInstructions),
    skills: [],
    loopTools: ReviewTools,
  })
  const output = yield* agent.send({ prompt })
  let modelCalls = 0
  yield* output.pipe(
    Stream.tap(record),
    Stream.runForEach((event) =>
      Effect.suspend(() => {
        if (event._tag === "Usage" && ++modelCalls >= maxTurns) {
          return Effect.fail(new HarnessStop(`stopped by --max-turns ${maxTurns}`))
        }
        return Effect.void
      }),
    ),
  )
}).pipe(
  Effect.catchTag("AgentFinished", (e) =>
    Effect.sync(() => {
      finished = { summary: e.summary }
    }),
  ),
  Effect.catchTag("RetriesExhausted", (e) =>
    Effect.sync(() => {
      failure = `RetriesExhausted after ${e.retries} retries: ${describeError(e.error)}`
    }),
  ),
  Effect.catchTag("AiError", (e) =>
    Effect.sync(() => {
      failure = `AiError: ${e.message}`
    }),
  ),
  Effect.catchTag("HarnessStop", (e) =>
    Effect.sync(() => {
      failure = e.message
    }),
  ),
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      ExecutorLayer,
      ModelLayer,
      Agent.MaxRetries.layer(3),
      Agent.TurnTimeout.layer("5 minutes"),
    ),
  ),
)

const exit = await Effect.runPromiseExit(
  review.pipe(
    Effect.provide(Layer.unwrap(Effect.sync(() => reviewHandlers(diffIndex, reviewState)))),
    Effect.provideService(FetchHttpClient.Fetch, capturingFetch),
  ),
)
if (Exit.isFailure(exit)) {
  failure = (failure === undefined ? "" : failure + "\n") + Cause.pretty(exit.cause)
}

// Settle the capture of the last response.
await new Promise((resolve) => setTimeout(resolve, 500))

const endedAt = Date.now()

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const timings = deriveTurns(events, startedAt)
const completedTurns = timings.filter((t) => t.endedAt !== undefined)
const inputTokens = completedTurns.reduce((n, t) => n + (t.contextTokens ?? 0), 0)
const outputTokens = lastUsage?.outputTokens ?? 0
const cost = {
  inputUsd: (inputTokens / 1e6) * 2,
  outputUsd: (outputTokens / 1e6) * 10,
  totalUsd: (inputTokens / 1e6) * 2 + (outputTokens / 1e6) * 10,
}
const textFor = (turn: number) => texts[turn - 1]

const summary = {
  provider,
  model: modelName,
  effort,
  pr,
  prUrl: prMeta.url,
  headSha,
  baseSha,
  run: runNumber,
  startedAt: new Date(startedAt).toISOString(),
  durationMs: endedAt - startedAt,
  outcome: finished !== undefined ? "taskComplete" : "failed",
  summary: finished?.summary,
  failure,
  turns: completedTurns.length,
  modelRequests: captures.length,
  retries,
  tokens: {
    input: inputTokens,
    output: outputTokens,
    cacheRead: lastUsage?.cacheRead ?? 0,
    cacheWrite: lastUsage?.cacheWrite ?? 0,
    lastContext: lastUsage?.contextTokens ?? 0,
  },
  costUsdAt2in10out: cost,
  perTurn: timings.map((t) => ({
    ...t,
    reasoningChars: textFor(t.turn)?.reasoning.length,
    scriptChars: textFor(t.turn)?.script.length,
    scriptOutputChars: textFor(t.turn)?.scriptOutput?.length,
  })),
  http: captures.map((c) => ({
    n: c.n,
    status: c.status,
    totalMs: c.endedAt - c.startedAt,
    firstByteMs: c.headersAt - c.startedAt,
    requestBytes: c.requestBytes,
    responseBytes: c.responseBytes,
  })),
  history: history.map((h) => ({ kind: h.kind, roles: h.roles })),
  toolCalls: reviewState.calls,
  findings: reviewState.findings,
}

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2))
fs.writeFileSync(
  path.join(outDir, "turns.md"),
  texts
    .filter((t) => t.reasoning !== "" || t.script !== "" || t.scriptOutput !== undefined)
    .map((t) =>
      [
        `## Turn ${t.turn}`,
        "",
        "### Reasoning",
        "",
        t.reasoning.trim() === "" ? "_(none streamed)_" : t.reasoning.trim(),
        "",
        "### Script",
        "",
        "```ts",
        t.script.trim(),
        "```",
        "",
        "### Output",
        "",
        "```",
        (t.scriptOutput ?? "").slice(0, 6000),
        "```",
        "",
      ].join("\n"),
    )
    .join("\n"),
)

console.log(
  JSON.stringify(
    {
      outcome: summary.outcome,
      turns: summary.turns,
      durationMs: summary.durationMs,
      tokens: summary.tokens,
      cost: cost.totalUsd.toFixed(4),
      retries: retries.length,
      toolCalls: reviewState.calls.map((c) => `${c.tool}:${c.outcome}`),
      failure,
    },
    null,
    2,
  ),
)
process.exit(0)
