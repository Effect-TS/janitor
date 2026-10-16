import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, layer } from "@effect/vitest"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpEffect from "effect/http/HttpEffect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Path from "effect/Path"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { parseTrustedDiff, validateAnchor } from "@janitor/domain/PullRequestReview/Diff"
import type { Finding } from "@janitor/domain/PullRequestReview/Finding"
import { fingerprint } from "@janitor/domain/PullRequestReview/Fingerprint"
import { resumeMessage, wrapUpMessage } from "@janitor/domain/PullRequestReview/Prompt"
import { inlineComment } from "@janitor/domain/PullRequestReview/Render"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { ReviewAgent, type StartOptions } from "../../src/PullRequestReview/Agent.ts"
import * as ReviewGitHub from "../../src/PullRequestReview/GitHub.ts"
import { executorOptions, ReviewAgentLayer } from "../../src/PullRequestReview/ReviewAgent.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { APP_LOGIN, FakeReviewGitHub } from "./fakeGitHub.ts"
import { HEAD, makeRunHarnessWith, type RunHarness } from "./runHarness.ts"
import { repositoryId, seedRepositories } from "./support.ts"

/**
 * The clanka agent behind the run entity: a scripted language model drives
 * the real loop, its scripts run on a real executor in a scratch checkout, and
 * the run entity harness stands in for the cluster, GitHub and the sandbox.
 */

/** The deployment's environment; the gate is on while the API URL and key are set. */
const env: Record<string, string> = {
  PR_REVIEW_AI_API_URL: "https://ai.test/v1",
  PR_REVIEW_AI_API_KEY: "test-key",
}

const Services = Layer.mergeAll(PullRequestReviewStore.layer, NodeServices.layer).pipe(
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(MigratedPostgresLayer),
)

const newRunId = () => RunId.make(crypto.randomUUID())

/** `src/a.ts` at the head: line 2 is the added line, and the one hunk covers lines 1 to 4. */
const lines = [
  "export const a = 1",
  "export const b = a + 1",
  "export const c = 3",
  "export { a, b, c }",
]
const files = [
  {
    filename: "src/a.ts",
    status: "modified" as const,
    patch:
      "@@ -1,3 +1,4 @@\n export const a = 1\n+export const b = a + 1\n export const c = 3\n export { a, b, c }",
    additions: 1,
    deletions: 0,
  },
]
const diff = parseTrustedDiff(files)

const finding = (line: number): Finding => ({
  path: "src/a.ts",
  startLine: line,
  endLine: line,
  severity: "blocking",
  comment: "Off by one.",
})

/** The model-facing message `validateAnchor` gives for a line outside the diff. */
const notInDiff = (line: number) => {
  const result = validateAnchor(diff, { path: "src/a.ts", startLine: line, endLine: line })
  if (result._tag !== "Invalid") throw new Error(`line ${line} is in the diff`)
  return result.message
}

/** Pull request 7 changing `src/a.ts`, with janitor's open thread `PRRT_open` on line 2 from an earlier run. */
const putPullRequest = (github: FakeReviewGitHub) =>
  Effect.gen(function* () {
    github.put({
      number: 7,
      title: "Change",
      state: "open",
      labels: [],
      pullRequest: { headSha: HEAD, files },
    })
    github.threads.push({
      id: "PRRT_open",
      path: "src/a.ts",
      line: 2,
      startLine: null,
      side: "RIGHT",
      isResolved: false,
      isOutdated: false,
      resolvedBy: null,
      comments: [
        {
          id: "PRRT_open_root",
          author: APP_LOGIN,
          byApp: true,
          body: inlineComment({
            comment: "`b` is off by one.",
            fingerprint: yield* fingerprint("src/a.ts", [lines[1]!]),
            severity: "blocking",
          }),
          createdAt: "2026-10-13T10:00:00Z",
        },
      ],
    })
  })

/** What one model call answers, given the prompt it was sent. */
type Turn = (prompt: Prompt.Prompt) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>

/**
 * A language model that answers its calls in order, one `Turn` each, and
 * keeps every prompt it was sent. A call past the last turn is a defect.
 */
class ScriptedModel {
  readonly prompts: Array<Prompt.Prompt> = []

  constructor(private readonly turns: ReadonlyArray<Turn>) {}

  get layer() {
    return Layer.mergeAll(
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die("unexpected generateText call"),
          streamText: ({ prompt }) =>
            Stream.suspend(() => {
              const turn = this.turns[this.prompts.length]
              this.prompts.push(prompt)
              return turn === undefined
                ? Stream.die(`unexpected model call ${this.prompts.length}`)
                : turn(prompt)
            }),
        }),
      ),
      Layer.succeed(Model.ProviderName, "test-provider"),
      Layer.succeed(Model.ModelName, "test-model"),
    )
  }
}

let calls = 0

/** A turn that runs `script` through clanka's `execute` tool. */
const execute =
  (script: string, options: { readonly contextTokens?: number } = {}): Turn =>
  () =>
    Stream.fromIterable<Response.StreamPartEncoded>([
      { type: "tool-call", id: `call-${++calls}`, name: "execute", params: { script } },
      ...(options.contextTokens === undefined
        ? []
        : [
            {
              type: "finish" as const,
              reason: "tool-calls" as const,
              usage: { inputTokens: { total: options.contextTokens }, outputTokens: { total: 1 } },
            },
          ]),
    ])

/** A turn that answers with plain text, as the compaction summarizer does. */
const say =
  (text: string): Turn =>
  () =>
    Stream.fromIterable<Response.StreamPartEncoded>([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: text },
      { type: "text-end", id: "text" },
    ])

/** Everything messages show the model: their text, the scripts it ran and their results. */
const seen = (messages: ReadonlyArray<Prompt.Message>) =>
  messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.map((part) =>
            part.type === "text"
              ? part.text
              : part.type === "tool-call"
                ? JSON.stringify(part.params)
                : part.type === "tool-result"
                  ? JSON.stringify(part.result)
                  : "",
          ),
    )
    .join("\n")

const systemText = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n")

/** The executor janitor's sandbox runs, in a scratch checkout of its own holding `files`. */
const localExecutor = (files: Record<string, string> = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-review-checkout-" })
      for (const [name, content] of Object.entries(files)) {
        yield* fs.makeDirectory(path.dirname(path.join(directory, name)), { recursive: true })
        yield* fs.writeFileString(path.join(directory, name), content)
      }
      return AgentExecutor.layerLocal({ directory, ...executorOptions(Duration.minutes(3)) })
    }),
  ).pipe(Layer.orDie, Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)))

/**
 * The executor over RPC, as the run reaches its sandbox container: HTTP
 * streaming through a pinned `fetch`, here into an in-memory server. Once
 * `lost` is set, every request fails as it does when the container is gone.
 */
const rpcExecutor = (connection: { lost: boolean }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-review-checkout-" })
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffect()
      yield* Layer.build(
        AgentExecutor.layerRpcServer({ directory, ...executorOptions(Duration.minutes(3)) }).pipe(
          Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
        ),
      )
      const handler = HttpEffect.toWebHandler(httpEffect)
      const fetch: typeof globalThis.fetch = (input, init) =>
        connection.lost
          ? Promise.reject(new TypeError("fetch failed"))
          : handler(new Request(input, init))
      return AgentExecutor.layerRpc.pipe(
        Layer.provide(
          RpcClient.layerProtocolHttp({
            url: "http://workspace/rpc",
            transformClient: HttpClient.transform((effect) =>
              Effect.provideService(effect, FetchHttpClient.Fetch, fetch),
            ),
          }),
        ),
      )
    }),
  ).pipe(
    Layer.orDie,
    Layer.provide(
      Layer.mergeAll(RpcSerialization.layerNdjson, NodeServices.layer, FetchHttpClient.layer),
    ),
  )

const run = <A, E, R>(
  model: ScriptedModel,
  test: (harness: RunHarness) => Effect.Effect<A, E, R>,
  executor: (acquire: number) => Layer.Layer<AgentExecutor.AgentExecutor> = () => localExecutor(),
) =>
  Effect.gen(function* () {
    yield* seedRepositories(repositoryId)
    const harness = yield* makeRunHarnessWith({
      agent: ReviewAgentLayer.pipe(Layer.provide(model.layer)),
      executor,
    })
    yield* putPullRequest(harness.github)
    return yield* test(harness)
  }).pipe(Effect.scoped)

/** Starts a run and waits until the loop's outcome reached `Publish`. */
const review = (harness: RunHarness) =>
  Effect.gen(function* () {
    const runId = newRunId()
    yield* harness.start(runId)
    yield* harness.until(
      Effect.sync(() => harness.published.some((run) => run.runId === runId)),
      "Publish",
    )
    return harness.published.find((run) => run.runId === runId)!.outcome
  })

/** What a script passed to `taskComplete` as a JSON list of strings. */
const answers = (summary: string | null) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(summary)

/**
 * Starts the agent straight on the fake GitHub's pull request, outside the run
 * entity, so a test controls how the run entity commits each step.
 */
const startAgent = (
  model: ScriptedModel,
  onStep: StartOptions["onStep"],
  options: { readonly body?: string } = {},
) =>
  Effect.gen(function* () {
    const github = new FakeReviewGitHub(7)
    yield* putPullRequest(github)
    if (options.body !== undefined) github.issues.get(7)!.body = options.body
    const client = yield* ReviewGitHub.make({
      installationId: GitHubInstallationId.make("77"),
      owner: "effect",
      repo: "one",
      number: 7,
    }).pipe(Effect.provide(github.layer))
    const pull = yield* client.pullRequest
    const agent = yield* Effect.gen(function* () {
      return yield* ReviewAgent
    }).pipe(Effect.provide(ReviewAgentLayer.pipe(Layer.provide(model.layer))))
    return yield* agent.start({
      runId: newRunId(),
      github: client,
      pullRequest: { headSha: HEAD, baseSha: pull.baseSha, trigger: { _tag: "Automatic" } },
      executor: localExecutor(),
      history: [],
      prompt: undefined,
      records: [],
      onStep,
    })
  })

/** Script lines that report how a loop-side call ended: `stored`, or its error message. */
const outcomeOf = `const outcome = (call) => call.then(() => "stored", (error) => error.message)`

layer(Services, { timeout: "2 minutes" })("PR review agent", (it) => {
  it.effect(
    "offers the model the loop-side tools, without gh, webSearch, fetchMarkdown or delegate",
    () => {
      const model = new ScriptedModel([execute(`await taskComplete("Nothing to report.")`)])
      return run(model, (harness) =>
        Effect.gen(function* () {
          const outcome = yield* review(harness)

          assert.strictEqual(outcome.summary, "Nothing to report.")
          const system = systemText(model.prompts[0]!)
          assert.include(system, "declare function reportFinding(")
          assert.include(system, "declare function updateThread(")
          assert.notMatch(system, /\b(gh|webSearch|fetchMarkdown|delegate)\b/)
        }),
      )
    },
  )

  it.effect(
    "reportFinding stores a valid finding and answers every rejection with its rule's message",
    () => {
      const model = new ScriptedModel([
        execute(`${outcomeOf}
await taskComplete(JSON.stringify([
  await outcome(reportFinding(${JSON.stringify(finding(4))})),
  await outcome(reportFinding(${JSON.stringify(finding(9))})),
  await outcome(reportFinding(${JSON.stringify(finding(2))})),
  await outcome(reportFinding(${JSON.stringify(finding(4))})),
  await outcome(reportFinding({ path: "src/a.ts", startLine: 4 })),
]))`),
      ])
      return run(model, (harness) =>
        Effect.gen(function* () {
          const outcome = yield* review(harness)

          const [valid, outside, covered, repeated, malformed] = answers(outcome.summary)
          assert.strictEqual(valid, "stored")
          assert.strictEqual(outside, notInDiff(9))
          assert.strictEqual(covered, "already covered by thread PRRT_open, use updateThread")
          assert.strictEqual(repeated, "overlaps a finding already reported in this run")
          assert.include(malformed, "reportFinding")
          assert.deepStrictEqual(outcome.records, [
            { _tag: "FindingReported", finding: finding(4) },
          ])
        }),
      )
    },
  )

  it.effect(
    "updateThread rejects threads that aren't janitor's and new anchors outside the diff",
    () => {
      const model = new ScriptedModel([
        execute(`${outcomeOf}
await taskComplete(JSON.stringify([
  await outcome(updateThread({ threadId: "PRRT_other", judgement: "addressed" })),
  await outcome(updateThread({ threadId: "PRRT_open", judgement: "still_applies", anchor: { startLine: 9, endLine: 9 } })),
  await outcome(updateThread({ threadId: "PRRT_open", judgement: "addressed", note: "Fixed." })),
]))`),
      ])
      return run(model, (harness) =>
        Effect.gen(function* () {
          const outcome = yield* review(harness)

          const [unknown, outside, valid] = answers(outcome.summary)
          assert.include(unknown, "PRRT_other")
          assert.strictEqual(outside, notInDiff(9))
          assert.strictEqual(valid, "stored")
          assert.deepStrictEqual(outcome.records, [
            {
              _tag: "ThreadUpdated",
              threadId: "PRRT_open",
              judgement: { judgement: "addressed", note: "Fixed." },
            },
          ])
        }),
      )
    },
  )

  it.effect("persists the loop's history, and a compaction replaces the rows", () => {
    // Three large script outputs, then a context over the threshold: the next
    // call compacts everything before the newest outputs into a summary.
    const large = `console.log("x".repeat(40000))`
    const model = new ScriptedModel([
      execute(large),
      execute(large),
      execute(large, { contextTokens: 230_000 }),
      say("Summary of the review so far."),
      execute(`await taskComplete("Compacted.")`),
    ])
    return run(model, (harness) =>
      Effect.gen(function* () {
        const runId = newRunId()
        yield* harness.start(runId)
        yield* harness.until(
          Effect.sync(() => harness.published.length > 0),
          "Publish",
        )

        const history = yield* harness.history(runId)
        const stored = history.map((message) => seen([message]))
        assert.strictEqual(harness.published[0]!.outcome.summary, "Compacted.")
        assert.include(stored[0]!, "Summary of the review so far.")
        assert.isFalse(stored.some((text) => text.includes("Review this pull request.")))
      }),
    )
  })

  it.effect("a lost sandbox is re-acquired and the loop resumes from its history", () => {
    const connections: Array<{ lost: boolean }> = []
    const model = new ScriptedModel([
      execute(
        `await reportFinding(${JSON.stringify(finding(4))}); console.log("reported before the loss")`,
      ),
      // The container goes away before the next script reaches it.
      (prompt) => {
        connections[0]!.lost = true
        return execute(`console.log("never runs")`)(prompt)
      },
      execute(`await taskComplete("Resumed.")`),
    ])
    return run(
      model,
      (harness) =>
        Effect.gen(function* () {
          const outcome = yield* review(harness)

          assert.strictEqual(harness.workspaces.acquires.length, 2)
          assert.strictEqual(outcome.summary, "Resumed.")
          assert.isNull(outcome.unfinished)
          assert.deepStrictEqual(outcome.records, [
            { _tag: "FindingReported", finding: finding(4) },
          ])
          const resumed = seen(model.prompts[2]!.content)
          assert.include(resumed, resumeMessage)
          assert.include(resumed, "reported before the loss")
        }),
      () => {
        const connection = { lost: false }
        connections.push(connection)
        return rpcExecutor(connection)
      },
    )
  })

  it.effect(
    "exhausted retries end the run unfinished, keeping its findings and logging only the category and status",
    () => {
      const logs: Array<string> = []
      const providerDown: Turn = () =>
        Stream.fail(
          AiError.make({
            module: "OpenAiLanguageModel",
            method: "streamText",
            reason: new AiError.InternalProviderError({
              description: "upstream said: secret-body",
              http: {
                request: {
                  method: "POST",
                  url: "https://proxy.test/v1/chat/completions",
                  urlParams: [],
                  headers: {},
                },
                response: { status: 530, headers: {} },
                body: "secret-body",
              },
            }),
          }),
        )
      const model = new ScriptedModel([
        execute(`await reportFinding(${JSON.stringify(finding(4))})`),
        ...Array.from({ length: 20 }, () => providerDown),
      ])
      return run(model, (harness) =>
        Effect.gen(function* () {
          const outcome = yield* review(harness)

          assert.strictEqual(outcome.unfinished, "provider_failure")
          assert.isNull(outcome.summary)
          assert.deepStrictEqual(outcome.records, [
            { _tag: "FindingReported", finding: finding(4) },
          ])
          // A small bound: the model was called once, then retried a few times.
          assert.isBelow(model.prompts.length, 10)
          assert.isTrue(logs.some((line) => line.includes("InternalProviderError (HTTP 530)")))
          assert.isFalse(logs.some((line) => line.includes("secret-body")))
        }),
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ message, cause }) => {
              logs.push(JSON.stringify({ message, cause: String(cause) }))
            }),
          ]),
        ),
      )
    },
  )

  it.effect("the wrap-up message reaches the agent between its steps", () => {
    // Two slow model calls take the run past minute 7, when the run entity steers.
    const slow =
      (script: string): Turn =>
      (prompt) =>
        Stream.unwrap(Effect.as(Effect.sleep("4 minutes"), execute(script)(prompt)))
    const model = new ScriptedModel([
      slow(`console.log("reading")`),
      slow(`console.log("still reading")`),
      execute(`await taskComplete("Wrapped up.")`),
    ])
    return run(model, (harness) =>
      Effect.gen(function* () {
        const runId = newRunId()
        yield* harness.start(runId)
        yield* harness.wait("8 minutes", "1 second")
        yield* harness.until(
          Effect.sync(() => harness.published.length > 0),
          "Publish",
        )

        const outcome = harness.published[0]!.outcome
        assert.strictEqual(outcome.summary, "Wrapped up.")
        assert.isTrue(outcome.steered)
        assert.isFalse(outcome.interrupted)
        assert.include(seen(model.prompts[2]!.content), wrapUpMessage)
      }),
    )
  })

  it.effect("the first message carries the trusted diff", () => {
    const model = new ScriptedModel([execute(`await taskComplete("Read the diff.")`)])
    return run(model, (harness) =>
      Effect.gen(function* () {
        yield* review(harness)

        const first = seen(model.prompts[0]!.content.filter((message) => message.role === "user"))
        assert.include(first, files[0]!.patch)
      }),
    )
  })

  it.effect("never sends the model AGENTS.md files or skills from the head checkout", () => {
    // The checkout is the pull request's head: its instructions and skills are
    // evidence, not standards, wherever the agent moves to.
    const checkout = {
      "AGENTS.md": "HEAD-ROOT-INSTRUCTIONS",
      "pkg/AGENTS.md": "HEAD-NESTED-INSTRUCTIONS",
      "pkg/.agents/skills/head-skill/SKILL.md":
        "---\nname: head-skill\ndescription: HEAD-SKILL-DESCRIPTION\n---\nHEAD-SKILL-CONTENT",
    }
    const model = new ScriptedModel([
      execute(`await changeDirectory("pkg"); console.log("moved")`),
      execute(`await taskComplete("Done.")`),
    ])
    return run(
      model,
      (harness) =>
        Effect.gen(function* () {
          yield* review(harness)

          const everything = model.prompts.map((prompt) => seen(prompt.content)).join("\n")
          assert.include(everything, "moved")
          assert.notMatch(everything, /HEAD-(ROOT|NESTED)-INSTRUCTIONS|HEAD-SKILL|head-skill/)
        }),
      () => localExecutor(checkout),
    )
  })

  it.effect("a history event is committed before the loop takes its next step", () =>
    Effect.gen(function* () {
      const model = new ScriptedModel([execute(`await taskComplete("Done.")`)])
      // The run entity's commit of the first step, the opening message, never finishes.
      const commits: Array<string> = []
      const session = yield* startAgent(model, (step) =>
        Effect.suspend(() => {
          commits.push(step.history._tag)
          return Effect.never
        }),
      )
      yield* TestClock.withLive(Effect.sleep("500 millis"))

      assert.deepStrictEqual(commits, ["Appended"])
      assert.strictEqual(model.prompts.length, 0)
      yield* session.interrupt
    }).pipe(Effect.scoped),
  )

  it.effect("a compaction that keeps the history's length is committed before the next step", () =>
    Effect.gen(function* () {
      // A large opening message and a context over the threshold: the compaction
      // summarizes the opening message alone, so [opening, script, result]
      // becomes [summary, script, result].
      const model = new ScriptedModel([
        execute(`console.log("read")`, { contextTokens: 230_000 }),
        say("Summary of the review so far."),
        execute(`await taskComplete("Done.")`),
      ])
      // The run entity's commit of the replacement never finishes.
      const commits: Array<string> = []
      const session = yield* startAgent(
        model,
        (step) =>
          Effect.suspend(() => {
            commits.push(step.history._tag)
            return step.history._tag === "Replaced" ? Effect.never : Effect.void
          }),
        { body: "x".repeat(120_000) },
      )
      yield* TestClock.withLive(Effect.sleep("500 millis"))

      assert.deepStrictEqual(commits, ["Appended", "Appended", "Replaced"])
      // The script's call and the summarizer's; the next step waits for the replacement.
      assert.strictEqual(model.prompts.length, 2)
      yield* session.interrupt
    }).pipe(Effect.scoped),
  )

  it.effect(
    "a GitHub read that never answers can't keep the run past its deadline",
    () => {
      const model = new ScriptedModel([])
      return run(model, (harness) =>
        Effect.gen(function* () {
          // The base branch's AGENTS.md, one of the loop's inputs, doesn't
          // arrive until the test ends.
          const stalled = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(stalled, undefined))
          harness.github.intercept = (request) =>
            request.url.includes("/contents/AGENTS.md")
              ? Effect.as(Deferred.await(stalled), undefined)
              : Effect.succeed(undefined)
          const runId = newRunId()
          yield* harness.send(runId)
          // Past the deadline, without draining: the stalled read leaves work pending.
          for (let elapsed = 0; elapsed < 11 * 60; elapsed += 10) {
            yield* TestClock.adjust("10 seconds")
            yield* TestClock.withLive(Effect.sleep("1 millis"))
          }
          yield* harness.waitFor(
            Effect.sync(() => harness.finishedCount(runId) > 0),
            "RunFinished after the deadline",
          )

          assert.strictEqual(harness.finishedCount(runId), 1)
          assert.include(harness.workspaces.releases, runId)
          assert.strictEqual(model.prompts.length, 0)
        }),
      )
    },
    60_000,
  )
})
