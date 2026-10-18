import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import type * as AgentOutput from "clanka/AgentOutput"
import * as AgentSkills from "clanka/AgentSkills"
import type * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import type * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as References from "effect/References"
import { RpcClientError } from "effect/rpc/RpcClientError"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  type LineAnchor,
  parseTrustedDiff,
  type TrustedDiff,
  validateAnchor,
} from "@janitor/domain/PullRequestReview/Diff"
import { Finding, ThreadJudgement } from "@janitor/domain/PullRequestReview/Finding"
import { fingerprint } from "@janitor/domain/PullRequestReview/Fingerprint"
import { parseInvocation } from "@janitor/domain/PullRequestReview/Invocation"
import {
  firstMessage,
  type StandardsFile,
  systemPrompt,
  type ThreadContext,
} from "@janitor/domain/PullRequestReview/Prompt"
import { checkDuplicate, type EarlierThread } from "@janitor/domain/PullRequestReview/Threads"
import {
  type HistoryChange,
  type LoopEnd,
  type LoopRecord,
  ReviewAgent,
  ReviewInputError,
  type StartOptions,
} from "./Agent.ts"
import { pullRequestReviewConfig } from "./Config.ts"
import { earlierThread, makeActors, rootComment } from "./EarlierThreads.ts"
import { type TailnetEgressNamespace, tailnetFetch } from "./TailnetEgress/TailnetEgressClient.ts"
import type * as ReviewGitHub from "./GitHub.ts"

/**
 * The PR review agent on clanka (EFF-1996): the run entity's `ReviewAgent`.
 * Each loop reads its inputs through the GitHub client, offers the model the
 * sandbox's tools plus the loop-side `reportFinding` and `updateThread`, and
 * hands every history event to the run entity with the records its scripts
 * made since the last one.
 */

/** Model calls retried in a row before the run ends unfinished. */
const MAX_RETRIES = 3

export { executorOptions } from "./Sandbox/ExecutorOptions.ts"

/**
 * The PR review model through an OpenAI-compatible chat completions endpoint
 * (EFF-1929), with its own HTTP client: the executor's is pinned to the
 * sandbox. With `PR_REVIEW_AI_VIA_TAILNET` its requests go through the
 * tailnet egress DO instead of the open internet. Without the endpoint's URL
 * and key PR review is off, so no run ever calls it. Invalid PR review
 * settings fail the model's calls, never the cluster labeling shares.
 */
export const ReviewModelLayer = (
  egress: TailnetEgressNamespace,
): Layer.Layer<LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName> =>
  Layer.unwrap(
    Effect.match(pullRequestReviewConfig, {
      onFailure: (error) =>
        Layer.mergeAll(
          Layer.effect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.die(error),
              streamText: () => Stream.die(error),
            }),
          ),
          Layer.succeed(Model.ProviderName, "openai"),
          Layer.succeed(Model.ModelName, "invalid PR review settings"),
        ),
      onSuccess: (config) =>
        OpenAiLanguageModel.model(config.model, { reasoning_effort: config.reasoningEffort }).pipe(
          Layer.provide(
            OpenAiClient.layer({
              apiUrl: Option.getOrUndefined(config.apiUrl),
              apiKey: Option.getOrUndefined(config.apiKey),
            }),
          ),
          Layer.provide(config.viaTailnet ? tailnetHttpClient(egress) : FetchHttpClient.layer),
        ),
    }),
  )

/**
 * The fetch client with each request's `fetch` pinned to the tailnet egress
 * DO, as `WorkspaceClient` pins the executor's. Providing `FetchHttpClient.Fetch`
 * to the layer instead isn't enough: the Worker shares `FetchHttpClient.layer`
 * across its layers, so its client is built once with the global fetch.
 */
const tailnetHttpClient = (egress: TailnetEgressNamespace): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.transform((effect) =>
        Effect.provideService(effect, FetchHttpClient.Fetch, tailnetFetch(egress)),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer))

const ReportFinding = Tool.make("reportFinding", {
  description:
    "Report one confirmed problem, anchored to lines of the pull request's version of a file that the diff changes.",
  parameters: Finding,
  success: Schema.String,
  failure: Schema.String,
})

const UpdateThread = Tool.make("updateThread", {
  description:
    "Judge one of your earlier threads, by the thread id from the first message. Only `still_applies` takes a new anchor.",
  parameters: Schema.Struct({ threadId: Schema.String, ...ThreadJudgement.fields }),
  success: Schema.String,
  failure: Schema.String,
})

const ReviewTools = Toolkit.make(ReportFinding, UpdateThread)

/** The base-branch files that hold a repository's review standards, in layer order. */
const STANDARDS_FILES = ["AGENTS.md", ".github/janitor/review.md"]

const SKILLS_DIRECTORY = ".agents/skills"
const skillPath = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/

const singleLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** A `SKILL.md` as clanka offers it: its frontmatter name and description, and its full text. */
const parseSkill = (
  directory: string,
  content: string,
): Option.Option<AgentSkills.ProvidedSkill> => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1]
  if (frontmatter === undefined) return Option.none()
  const field = (name: string) =>
    singleLine(
      new RegExp(`^${name}:\\s*(.*)$`, "m")
        .exec(frontmatter)?.[1]
        ?.replace(/^(["'])(.*)\1$/, "$2") ?? "",
    )
  const description = field("description")
  if (description === "") return Option.none()
  return Option.some(
    new AgentSkills.ProvidedSkill({ name: field("name") || directory, description, content }),
  )
}

/** The base branch's skills; a skills directory too large to read is left out. */
const readSkills = (client: ReviewGitHub.PullRequestGitHub, baseSha: string) =>
  client.readDirectory(baseSha, SKILLS_DIRECTORY).pipe(
    Effect.map((files) =>
      files.flatMap((file) => {
        const directory = skillPath.exec(file.path)?.[1]
        if (directory === undefined || file.blob._tag !== "Read") return []
        return Option.toArray(parseSkill(directory, file.blob.text))
      }),
    ),
    Effect.catchTag("PullRequestGitHubDirectoryTooLarge", (error) =>
      Effect.as(
        Effect.logWarning("PR review skills directory is too large; reviewing without skills").pipe(
          Effect.annotateLogs({ path: error.path, limit: error.limit }),
        ),
        [],
      ),
    ),
  )

/** What the loop is given at start, read from GitHub and rendered. */
interface Inputs {
  readonly instructions: string
  readonly standardsSources: ReadonlyArray<string>
  readonly skills: ReadonlyArray<AgentSkills.ProvidedSkill>
  readonly firstMessage: string
  readonly diff: TrustedDiff
  readonly threads: ReadonlyArray<EarlierThread>
}

const readInputs = (options: StartOptions) =>
  Effect.gen(function* () {
    const { github: client, pullRequest: run } = options
    const config = yield* Effect.orDie(pullRequestReviewConfig)
    const pull = yield* client.pullRequest
    const changed = yield* client.changedFiles({
      baseSha: run.baseSha,
      lockfiles: config.lockfiles,
    })
    const history = yield* client.janitorHistory
    const { actor } = makeActors(client, pull)
    const threads = yield* Effect.forEach(history.threads, (thread) =>
      Effect.map(earlierThread(thread, actor), (earlier) => ({ thread, earlier })),
    )

    const standards: Array<StandardsFile> = []
    for (const path of STANDARDS_FILES) {
      const blob = yield* client.readFile(run.baseSha, path)
      if (blob._tag === "Read") standards.push({ path, content: blob.text })
    }
    const skills = yield* readSkills(client, run.baseSha)
    // Read by id from the `/janitor` comment, never carried in a message payload.
    const invokerGuidance =
      run.trigger._tag === "Automatic"
        ? undefined
        : Option.getOrUndefined(
            parseInvocation((yield* client.issueComment(run.trigger.commentId)).body),
          )?.guidance
    const system = systemPrompt({
      baseSha: run.baseSha,
      standards,
      ...(invokerGuidance === undefined ? {} : { invokerGuidance }),
    })

    // `earlier.replies` attributes the same human comments, in order.
    const contexts = threads.map(({ thread, earlier }): ThreadContext => ({
      id: earlier.id,
      path: earlier.path,
      anchor: earlier.anchor,
      severity: earlier.severity,
      comment: rootComment(thread.comments[0]!.body),
      outdated: earlier.outdated,
      ...(earlier.resolvedBy === undefined ? {} : { resolvedBy: earlier.resolvedBy }),
      replies: thread.comments
        .filter((comment) => !comment.byJanitor)
        .map((comment, index) => ({ by: earlier.replies[index]!.by, body: comment.body })),
    }))

    return {
      instructions: system.prompt,
      standardsSources: [
        "protocol",
        "rubric",
        ...system.sources.files.map((file) => file.path),
        ...(system.sources.invokerGuidance.present ? ["invoker"] : []),
      ],
      skills,
      firstMessage: firstMessage({
        pullRequest: {
          title: pull.title,
          body: pull.body,
          baseSha: run.baseSha,
          headSha: run.headSha,
        },
        threads: contexts,
      }),
      diff: parseTrustedDiff(changed.files),
      threads: threads.map(({ earlier }) => earlier),
    } satisfies Inputs
  }).pipe(Effect.mapError((error) => new ReviewInputError({ operation: error.operation })))

/**
 * The loop-side tools' state for one loop: what it reported and withdrew,
 * seeded from the records earlier steps committed, and the records made
 * since the last history event.
 */
const makeTools = (options: StartOptions, inputs: Inputs) => {
  const reported: Array<LineAnchor> = []
  const withdrawn = new Set<string>()
  const pending: Array<LoopRecord> = []
  const remember = (record: LoopRecord) => {
    if (record._tag === "FindingReported") reported.push(record.finding)
    else if (record.judgement.judgement === "withdrawn") withdrawn.add(record.threadId)
    else withdrawn.delete(record.threadId)
  }
  for (const record of options.records) remember(record)
  const add = (record: LoopRecord) => {
    remember(record)
    pending.push(record)
  }

  /** The lines a finding covers, for its fingerprint; a file outside the patch is read at the head. */
  const linesOf = (finding: Finding, anchored: ReadonlyArray<string> | undefined) =>
    anchored !== undefined
      ? Effect.succeed(anchored)
      : options.github.readFile(options.pullRequest.headSha, finding.path).pipe(
          Effect.map((blob) =>
            blob._tag === "Read"
              ? blob.text.split("\n").slice(finding.startLine - 1, finding.endLine)
              : [],
          ),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        )

  const handlers = ReviewTools.toLayer({
    reportFinding: (finding) =>
      Effect.gen(function* () {
        const anchor = validateAnchor(inputs.diff, finding)
        if (anchor._tag === "Invalid") return yield* Effect.fail(anchor.message)
        const lines = yield* linesOf(finding, anchor._tag === "Anchored" ? anchor.lines : undefined)
        const duplicate = checkDuplicate(
          { ...finding, fingerprint: yield* fingerprint(finding.path, lines) },
          { threads: inputs.threads, withdrawn: [...withdrawn], reported },
        )
        if (Option.isSome(duplicate)) return yield* Effect.fail(duplicate.value)
        add({ _tag: "FindingReported", finding })
        return "Reported."
      }),
    updateThread: ({ threadId, judgement, note, anchor }) =>
      Effect.gen(function* () {
        const thread = inputs.threads.find((candidate) => candidate.id === threadId)
        if (thread === undefined)
          return yield* Effect.fail(
            `\`${threadId}\` is not one of your earlier threads; use a thread id from the first message`,
          )
        const moved = judgement === "still_applies" ? anchor : undefined
        if (moved !== undefined) {
          const validated = validateAnchor(inputs.diff, { path: thread.path, ...moved })
          if (validated._tag === "Invalid") return yield* Effect.fail(validated.message)
          if (validated._tag === "Unanchorable")
            return yield* Effect.fail(`\`${thread.path}\` has no changed lines to anchor to`)
        }
        add({
          _tag: "ThreadUpdated",
          threadId,
          judgement: {
            judgement,
            ...(note === undefined ? {} : { note }),
            ...(moved === undefined ? {} : { anchor: moved }),
          },
        })
        return "Recorded."
      }),
  })

  return { handlers, takePending: () => pending.splice(0) }
}

/**
 * The executor without its environment updates. Those come from the head
 * checkout, which the pull request controls: its `AGENTS.md` files and skills
 * are evidence, and the loop's instructions and skills come from the base
 * branch only.
 */
const baseOnly = (executor: Layer.Layer<AgentExecutor.AgentExecutor>) =>
  Layer.effect(
    AgentExecutor.AgentExecutor,
    Effect.gen(function* () {
      const sandbox = yield* AgentExecutor.AgentExecutor
      return AgentExecutor.AgentExecutor.of({ ...sandbox, renderEnvironment: undefined })
    }),
  ).pipe(Layer.provide(executor))

/** A defect from the executor's transport: its container or the connection to it is gone. */
const isSandboxLoss = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && Schema.is(RpcClientError)(reason.defect),
  )

/** How a loop's exit ends it. Provider failures are logged by category and HTTP status only, never with a body. */
const loopEnd = (
  exit: Exit.Exit<void, AgentOutput.AgentFinished | AgentOutput.RetriesExhausted | AiError.AiError>,
): Effect.Effect<LoopEnd> => {
  if (exit._tag === "Success")
    return Effect.succeed({ _tag: "Failed", message: "The loop ended without taskComplete" })
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error)) {
    const failure = error.value
    if (failure._tag === "AgentFinished")
      return Effect.succeed({ _tag: "Completed", summary: failure.summary })
    const reason = failure._tag === "RetriesExhausted" ? failure.error.reason : failure.reason
    const status = "http" in reason ? reason.http?.response?.status : undefined
    const message = `The PR review model failed: ${reason._tag}${status === undefined ? "" : ` (HTTP ${status})`}`
    return Effect.as(Effect.logWarning(message), { _tag: "Failed", message })
  }
  if (isSandboxLoss(exit.cause)) return Effect.succeed({ _tag: "SandboxLost" })
  if (Cause.hasInterruptsOnly(exit.cause)) return Effect.succeed({ _tag: "Interrupted" })
  const defect = Cause.squash(exit.cause)
  const kind = defect instanceof Error ? defect.name : typeof defect
  const message = `The PR review loop failed: ${kind}`
  return Effect.as(Effect.logError(message), { _tag: "Failed", message })
}

const make = Effect.gen(function* () {
  const model = yield* Effect.context<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
  >()

  const start = Effect.fnUntraced(function* (options: StartOptions) {
    const inputs = yield* readInputs(options)
    const tools = makeTools(options, inputs)
    const ready = yield* Deferred.make<Agent.Agent>()
    const ended = yield* Deferred.make<LoopEnd>()

    /**
     * The history messages the run entity holds, and a signal for each commit.
     * A resumed loop starts from the rows it was given.
     */
    let committed: ReadonlyArray<Prompt.Message> = options.history
    let commitDone = Deferred.makeUnsafe<void>()

    /** Commits a history event with the records made since the last one. */
    const commit = (history: HistoryChange) =>
      Effect.suspend(() => options.onStep({ history, records: tools.takePending() })).pipe(
        Effect.andThen(
          Effect.sync(() => {
            committed =
              history._tag === "Appended" ? [...committed, ...history.messages] : history.messages
            const done = commitDone
            commitDone = Deferred.makeUnsafe<void>()
            Deferred.doneUnsafe(done, Effect.void)
          }),
        ),
      )

    /**
     * Waits until every change to the loop's history is committed. clanka
     * doesn't wait for its history events, so the model calls do: a step the
     * run entity hasn't committed never has a next step, and records made in
     * a script belong to the commit of that script's step.
     */
    const caughtUp = (agent: Agent.Agent) =>
      Effect.suspend(function wait(): Effect.Effect<void> {
        // Compared by content: a compaction can keep the length, and clanka's
        // events carry copies of its history's messages.
        const current = agent.history.current.content.filter((message) => message.role !== "system")
        return current.length === committed.length &&
          current.every((message, index) => Equal.equals(message, committed[index]))
          ? Effect.void
          : Effect.andThen(Deferred.await(commitDone), Effect.suspend(wait))
      })

    /** The model behind the commit boundary. clanka only streams, for its steps and compaction alike. */
    const committedModel = (agent: Agent.Agent) =>
      Effect.gen(function* () {
        const ai = yield* LanguageModel.LanguageModel
        // The method is generic over the toolkit; this only adds the wait.
        const streamText = (options: Parameters<typeof ai.streamText>[0]) =>
          Stream.unwrap(Effect.as(caughtUp(agent), ai.streamText(options)))
        return LanguageModel.LanguageModel.of({
          ...ai,
          streamText: streamText as typeof ai.streamText,
        })
      })

    const loop = Effect.gen(function* () {
      const agent = yield* Agent.makeWith({
        instructions: Option.some(inputs.instructions),
        skills: inputs.skills,
        loopTools: ReviewTools,
      })
      if (options.history.length > 0)
        MutableRef.set(agent.history, Prompt.fromMessages(options.history))
      yield* Deferred.succeed(ready, agent)
      const output = yield* agent
        .send({ prompt: options.prompt ?? inputs.firstMessage })
        .pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, committedModel(agent)))
      yield* Stream.runForEach(output, (part) =>
        part._tag === "HistoryAppended"
          ? commit({ _tag: "Appended", messages: part.messages })
          : part._tag === "HistoryReplaced"
            ? commit({ _tag: "Replaced", messages: part.messages })
            : Effect.void,
      )
    }).pipe(
      // Records whose script never reached the history are kept: the loop did report them.
      Effect.ensuring(
        Effect.suspend(() => {
          const records = tools.takePending()
          return records.length === 0
            ? Effect.void
            : options.onStep({ history: { _tag: "Appended", messages: [] }, records })
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(tools.handlers, baseOnly(options.executor))),
      Effect.provideContext(model),
      Effect.provideService(Agent.MaxRetries, MAX_RETRIES),
      // clanka's compaction warning logs the raw provider error, body included.
      // `loopEnd` logs the loop's own failures, by category.
      Effect.provideService(References.MinimumLogLevel, "Error"),
    )

    const fiber = yield* Effect.forkScoped(
      Effect.flatMap(Effect.exit(loop), (exit) =>
        Effect.flatMap(loopEnd(exit), (end) => Deferred.succeed(ended, end)),
      ),
    )
    const scope = yield* Effect.scope

    return {
      standardsSources: inputs.standardsSources,
      // Delivered between steps; the run entity's timers don't wait for it.
      steer: (message: string) =>
        Effect.asVoid(
          Effect.forkIn(
            Effect.flatMap(Deferred.await(ready), (agent) => agent.steer(message)),
            scope,
          ),
        ),
      interrupt: Effect.andThen(
        Fiber.interrupt(fiber),
        Deferred.succeed(ended, { _tag: "Interrupted" }),
      ).pipe(Effect.asVoid),
      result: Deferred.await(ended),
    }
  })

  return ReviewAgent.of({ start })
})

/** The run entity's agent on clanka, over the model it is given. */
export const ReviewAgentLayer: Layer.Layer<
  ReviewAgent,
  never,
  LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
> = Layer.effect(ReviewAgent, make)
