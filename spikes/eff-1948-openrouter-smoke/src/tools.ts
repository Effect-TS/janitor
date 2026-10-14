// Stub loop-side tools standing in for janitor's `reportFinding` and
// `updateThread`. Their handlers run next to the Agent, not in the executor.
// `reportFinding` rejects anchors outside the diff with a model-facing error,
// so the runs show whether the model reads the error and corrects the call.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import { type DiffIndex, formatRanges, inRanges } from "./diff.ts"

export const ReviewTools = Toolkit.make(
  Tool.make("reportFinding", {
    description:
      "Report one review finding on the pull request. `path` is a file the PR changes and `line` (optionally through `endLine`) are new-side line numbers that lie inside the PR diff hunks; anchors outside the diff are rejected. Returns the finding id, which `updateThread` takes.",
    parameters: Schema.Struct({
      path: Schema.String,
      line: Schema.Int,
      endLine: Schema.optionalKey(Schema.Int),
      severity: Schema.Literals(["blocking", "suggestion", "nit", "question"]),
      title: Schema.String,
      body: Schema.String,
    }),
    success: Schema.Struct({ id: Schema.String }),
    failure: Schema.String,
  }),
  Tool.make("updateThread", {
    description:
      "Append a comment to the thread of a finding reported earlier in this review, for example a test or probe result that confirms or withdraws it. Returns the thread's comment count.",
    parameters: Schema.Struct({
      id: Schema.String,
      body: Schema.String,
      resolve: Schema.optionalKey(Schema.Boolean),
    }),
    success: Schema.Struct({ id: Schema.String, comments: Schema.Int }),
    failure: Schema.String,
  }),
)

export interface ToolCall {
  readonly at: number
  readonly tool: "reportFinding" | "updateThread"
  readonly params: unknown
  readonly outcome: "ok" | "rejected"
  readonly result: unknown
}

export interface Finding {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly endLine: number | undefined
  readonly severity: string
  readonly title: string
  readonly body: string
  readonly thread: Array<{ body: string; resolve: boolean | undefined }>
}

export interface ReviewState {
  readonly calls: Array<ToolCall>
  readonly findings: Array<Finding>
}

export const makeReviewState = (): ReviewState => ({ calls: [], findings: [] })

export const reviewHandlers = (index: DiffIndex, state: ReviewState) => {
  const record = <A>(
    tool: ToolCall["tool"],
    params: unknown,
    result: Effect.Effect<A, string>,
  ): Effect.Effect<A, string> =>
    result.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          state.calls.push({ at: Date.now(), tool, params, outcome: "ok", result: value })
        }),
      ),
      Effect.tapError((message) =>
        Effect.sync(() => {
          state.calls.push({ at: Date.now(), tool, params, outcome: "rejected", result: message })
        }),
      ),
    )

  return ReviewTools.toLayer({
    reportFinding: (params) =>
      record(
        "reportFinding",
        params,
        Effect.suspend(() => {
          const ranges = index.hunks.get(params.path)
          if (ranges === undefined) {
            return Effect.fail(
              `reportFinding rejected: "${params.path}" is not a file this pull request changes. Changed files: ${index.files.join(", ")}.`,
            )
          }
          const endLine = params.endLine ?? params.line
          if (endLine < params.line) {
            return Effect.fail(
              `reportFinding rejected: endLine ${endLine} is before line ${params.line}.`,
            )
          }
          for (const line of [params.line, endLine]) {
            if (!inRanges(ranges, line)) {
              return Effect.fail(
                `reportFinding rejected: line ${line} of ${params.path} is outside the pull request diff. A finding must be anchored on a new-side line inside the diff hunks of ${params.path}: lines ${formatRanges(ranges)}. Pick a line inside those ranges, or drop the finding if it is about unchanged code.`,
              )
            }
          }
          const duplicate = state.findings.find(
            (f) => f.path === params.path && f.line === params.line,
          )
          if (duplicate !== undefined) {
            return Effect.fail(
              `reportFinding rejected: finding ${duplicate.id} is already anchored on ${params.path}:${params.line} ("${duplicate.title}"). Use updateThread({ id: "${duplicate.id}", body }) to add to it instead.`,
            )
          }
          const id = `f${state.findings.length + 1}`
          state.findings.push({
            id,
            path: params.path,
            line: params.line,
            endLine: params.endLine,
            severity: params.severity,
            title: params.title,
            body: params.body,
            thread: [],
          })
          return Effect.succeed({ id })
        }),
      ),
    updateThread: (params) =>
      record(
        "updateThread",
        params,
        Effect.suspend(() => {
          const finding = state.findings.find((f) => f.id === params.id)
          if (finding === undefined) {
            const known = state.findings.map((f) => f.id)
            return Effect.fail(
              `updateThread rejected: no finding with id "${params.id}". ${known.length === 0 ? "No findings have been reported yet; call reportFinding first." : `Known ids: ${known.join(", ")}.`}`,
            )
          }
          finding.thread.push({ body: params.body, resolve: params.resolve })
          return Effect.succeed({ id: finding.id, comments: finding.thread.length })
        }),
      ),
  })
}
