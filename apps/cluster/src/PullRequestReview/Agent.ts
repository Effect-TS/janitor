import type * as AgentExecutor from "clanka/AgentExecutor"
import type * as Prompt from "effect/ai/Prompt"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { Finding, ThreadJudgement } from "@janitor/domain/PullRequestReview/Finding"
import type { RunId, Trigger } from "@janitor/domain/PullRequestReview/Run"
import type { PullRequestGitHub } from "./GitHub.ts"

/**
 * The part of a PR review run's agent loop the run entity talks to
 * (EFF-1651). The entity owns the loop's lifecycle: where its history lives,
 * the deadline, cancellation and resumes. The agent behind this interface
 * owns the model, the tools and the prompts. "PR review: clanka agent wiring,
 * loop-side tools and sandbox loss" (EFF-1996) implements it with clanka.
 */

/** What a loop-side tool decided in a step, kept with the step's history for `Publish`. */
export const LoopRecord = Schema.TaggedUnion({
  /** A `reportFinding` call the loop accepted. */
  FindingReported: { finding: Finding },
  /** An `updateThread` call: the agent's judgement on one of janitor's earlier threads. */
  ThreadUpdated: { threadId: Schema.String, judgement: ThreadJudgement },
}).annotate({ identifier: "PullRequestReviewLoopRecord" })
export type LoopRecord = typeof LoopRecord.Type

/**
 * How a step changed the loop's history: messages added to the end, or the
 * whole history replaced, as compaction does. Either may include the system
 * message, which the run entity never stores.
 */
export type HistoryChange =
  | { readonly _tag: "Appended"; readonly messages: ReadonlyArray<Prompt.Message> }
  | { readonly _tag: "Replaced"; readonly messages: ReadonlyArray<Prompt.Message> }

/** One step of the loop, committed in one transaction. */
export interface AgentStep {
  readonly history: HistoryChange
  readonly records: ReadonlyArray<LoopRecord>
}

/**
 * How the loop ended. `SandboxLost` means the executor's transport or its
 * container went away: the run re-acquires a sandbox and resumes.
 */
export type LoopEnd =
  | { readonly _tag: "Completed"; readonly summary: string }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "SandboxLost" }

/**
 * What a finished loop hands to `Publish`: the `taskComplete` summary, whether
 * the agent was told to wrap up or interrupted at the deadline (both approval
 * gate inputs), why an unfinished run is unfinished, and every record from
 * every step, across resumes.
 */
export const LoopOutcome = Schema.Struct({
  /** The `taskComplete` summary; absent when the loop never called it. */
  summary: Schema.NullOr(Schema.String),
  steered: Schema.Boolean,
  interrupted: Schema.Boolean,
  unfinished: Schema.NullOr(Schema.Literals(["deadline", "provider_failure"])),
  records: Schema.Array(LoopRecord),
}).annotate({ identifier: "PullRequestReviewLoopOutcome" })
export type LoopOutcome = typeof LoopOutcome.Type

/** A running loop. */
export interface ReviewSession {
  /**
   * The review standards sources the loop's instructions were built from
   * (EFF-1647), such as the fixed protocol, the default rubric, `AGENTS.md`
   * and invoker guidance. The run record lists them.
   */
  readonly standardsSources: ReadonlyArray<string>
  /** Sends the agent a message between its steps, such as the wrap-up message. */
  readonly steer: (message: string) => Effect.Effect<void>
  /** Stops the loop; `result` then ends as `Interrupted`. */
  readonly interrupt: Effect.Effect<void>
  /** Waits for the loop to end. */
  readonly result: Effect.Effect<LoopEnd>
}

export interface StartOptions {
  readonly runId: RunId
  /** The pull request, read through the run's GitHub client. */
  readonly github: PullRequestGitHub
  /** What the run reviews: the pinned head, the base it started from and what started it. */
  readonly pullRequest: {
    readonly headSha: string
    readonly baseSha: string
    readonly trigger: Trigger
  }
  /** The run's sandbox, provisioned at the pinned head SHA. */
  readonly executor: Layer.Layer<AgentExecutor.AgentExecutor>
  /**
   * The history to continue from, without the system message. Empty on a
   * run's first acquire, when the agent opens the review with its own first
   * message.
   */
  readonly history: ReadonlyArray<Prompt.Message>
  /** The message a resumed loop continues from; absent on the first acquire. */
  readonly prompt: string | undefined
  /** The records earlier steps committed, so a resumed loop knows what it already reported. */
  readonly records: ReadonlyArray<LoopRecord>
  /**
   * Commits a step. The loop waits for it before its next step, so a step
   * the entity hasn't committed is one a resume redoes.
   */
  readonly onStep: (step: AgentStep) => Effect.Effect<void>
}

/** The loop's inputs couldn't be read from GitHub, so it never started. */
export class ReviewInputError extends Data.TaggedError("ReviewInputError")<{
  readonly operation: string
}> {}

export class ReviewAgent extends Context.Service<
  ReviewAgent,
  {
    /** Starts a loop that runs until it ends or `scope` closes. */
    readonly start: (
      options: StartOptions,
    ) => Effect.Effect<ReviewSession, ReviewInputError, Scope.Scope>
  }
>()("@janitor/cluster/PullRequestReview/Agent/ReviewAgent") {}
