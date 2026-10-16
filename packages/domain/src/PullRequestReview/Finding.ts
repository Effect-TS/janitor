import * as Schema from "effect/Schema"

/** A 1-based line on the pull request's side of the diff (GitHub's `RIGHT` side). */
export const LineNumber = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "LineNumber",
})

const orderedLines = Schema.makeFilter(
  (range: { readonly startLine: number; readonly endLine: number }) =>
    range.startLine <= range.endLine,
  { expected: "a start line at or before the end line" },
)

/** An anchor's lines; a single line has equal start and end lines. */
export const LineRange = Schema.Struct({
  startLine: LineNumber,
  endLine: LineNumber,
})
  .check(orderedLines)
  .annotate({ identifier: "LineRange" })
export type LineRange = typeof LineRange.Type

/** `blocking` withholds approval while it stands; a `nit` never does. */
export const Severity = Schema.Literals(["blocking", "nit"]).annotate({ identifier: "Severity" })
export type Severity = typeof Severity.Type

/** One problem the agent reports, anchored to lines of the pull request's version of a file. */
export const Finding = Schema.Struct({
  path: Schema.NonEmptyString,
  ...LineRange.fields,
  severity: Severity,
  comment: Schema.String,
})
  .check(orderedLines)
  .annotate({ identifier: "Finding" })
export type Finding = typeof Finding.Type

/** The agent's verdict on one of janitor's earlier review threads. */
export const Judgement = Schema.Literals(["still_applies", "addressed", "withdrawn"]).annotate({
  identifier: "Judgement",
})
export type Judgement = typeof Judgement.Type

/**
 * A thread judgement. The optional new anchor applies to `still_applies` and is
 * validated against the trusted diff like a new finding.
 */
export const ThreadJudgement = Schema.Struct({
  judgement: Judgement,
  note: Schema.optionalKey(Schema.String),
  anchor: Schema.optionalKey(LineRange),
}).annotate({ identifier: "ThreadJudgement" })
export type ThreadJudgement = typeof ThreadJudgement.Type

/**
 * What became of a finding in a run: reported in this run, an earlier finding
 * that still applies, or an earlier one judged `addressed` or `withdrawn`.
 * Janitor never resolves threads, so there is no `resolved` outcome.
 */
export const FindingOutcome = Schema.Literals([
  "new",
  "carried_over",
  "addressed",
  "withdrawn",
]).annotate({ identifier: "FindingOutcome" })
export type FindingOutcome = typeof FindingOutcome.Type
