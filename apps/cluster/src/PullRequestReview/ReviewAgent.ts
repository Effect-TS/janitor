import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import type * as AgentOutput from "clanka/AgentOutput"
import * as AgentSkills from "clanka/AgentSkills"
import type * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import type * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as References from "effect/References"
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
import { loopExit, makeCommitBoundary, startLoop } from "../AgentLoop.ts"
import { invalidModel, type ModelLayer, openAiCompatibleModel } from "../AgentModel.ts"
import {
  type LoopEnd,
  type LoopRecord,
  ReviewAgent,
  ReviewInputError,
  type StartOptions,
} from "./Agent.ts"
import { pullRequestReviewConfig } from "./Config.ts"
import { earlierThread, makeActors, rootComment } from "./EarlierThreads.ts"
import type { TailnetEgressNamespace } from "./TailnetEgress/TailnetEgressClient.ts"
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
 * (EFF-1929). With `PR_REVIEW_AI_VIA_TAILNET` its requests go through the
 * tailnet egress DO instead of the open internet. Without the endpoint's URL
 * and key PR review is off, so no run ever calls it. Invalid PR review
 * settings fail the model's calls, never the cluster labeling shares.
 */
export const ReviewModelLayer = (egress: TailnetEgressNamespace): ModelLayer =>
  Layer.unwrap(
    Effect.match(pullRequestReviewConfig, {
      onFailure: (error) => invalidModel(error, "invalid PR review settings"),
      onSuccess: (config) => openAiCompatibleModel(config, egress),
    }),
  )

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

/** How a loop's exit ends it. Provider failures are logged by category and HTTP status only, never with a body. */
const loopEnd = (
  exit: Exit.Exit<void, AgentOutput.AgentFinished | AgentOutput.RetriesExhausted | AiError.AiError>,
): Effect.Effect<LoopEnd> => {
  const end = loopExit(exit)
  switch (end._tag) {
    case "Finished":
      return Effect.succeed({ _tag: "Completed", summary: end.summary })
    case "Incomplete":
      return Effect.succeed({ _tag: "Failed", message: "The loop ended without taskComplete" })
    case "ProviderFailed": {
      const message = `The PR review model failed: ${end.category}${end.status === undefined ? "" : ` (HTTP ${end.status})`}`
      return Effect.as(Effect.logWarning(message), { _tag: "Failed", message })
    }
    case "SandboxLost":
    case "Interrupted":
      return Effect.succeed(end)
    case "Crashed": {
      const message = `The PR review loop failed: ${end.defect}`
      return Effect.as(Effect.logError(message), { _tag: "Failed", message })
    }
  }
}

const make = Effect.gen(function* () {
  const model = yield* Effect.context<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
  >()

  const start = Effect.fnUntraced(function* (options: StartOptions) {
    const inputs = yield* readInputs(options)
    const tools = makeTools(options, inputs)

    // Each history event commits with the records made since the last one,
    // so records made in a script belong to the commit of that script's step.
    // A resumed loop starts from the rows it was given.
    const boundary = makeCommitBoundary({
      history: options.history,
      onStep: (history) => options.onStep({ history, records: tools.takePending() }),
    })

    const handle = yield* startLoop({
      loop: (ready) =>
        Effect.gen(function* () {
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
            .pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, boundary.model(agent)))
          yield* Stream.runForEach(output, (part) =>
            part._tag === "HistoryAppended"
              ? boundary.commit({ _tag: "Appended", messages: part.messages })
              : part._tag === "HistoryReplaced"
                ? boundary.commit({ _tag: "Replaced", messages: part.messages })
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
        ),
      onExit: loopEnd,
      interrupted: { _tag: "Interrupted" },
    })

    return { standardsSources: inputs.standardsSources, ...handle }
  })

  return ReviewAgent.of({ start })
})

/** The run entity's agent on clanka, over the model it is given. */
export const ReviewAgentLayer: Layer.Layer<
  ReviewAgent,
  never,
  LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
> = Layer.effect(ReviewAgent, make)
