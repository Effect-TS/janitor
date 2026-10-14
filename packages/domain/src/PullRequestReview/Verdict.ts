import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { matchesGlob } from "../Labeling/Policy/Evaluate.ts"
import type { PullRequestFile } from "./Diff.ts"
import type { Severity } from "./Finding.ts"
import type { SkipReason, Verdict } from "./Run.ts"
import type { ThreadState } from "./Threads.ts"

/**
 * How the agent loop ended: `taskComplete` unprompted, `taskComplete` after the
 * wrap-up message, the deadline without `taskComplete`, or a provider failure.
 * The last two are unfinished and publish a partial review.
 */
export type RunOutcome = "completed" | "steered" | "interrupted" | "errored"

/** The deployment-wide sensitive path settings from `PullRequestReviewConfig`. */
export interface SensitivePaths {
  readonly globs: ReadonlyArray<string>
  readonly lockfiles: ReadonlyArray<string>
  readonly manifests: ReadonlyArray<string>
}

/** A changed manifest's base and head contents; absent when the file doesn't exist on that side. */
export interface ManifestChange {
  readonly path: string
  readonly base?: string
  readonly head?: string
}

export interface ReviewInput {
  readonly reviewedSha: string
  readonly baseRefAtStart: string
  readonly outcome: RunOutcome
  readonly forced: boolean
  readonly authorCanWrite: boolean
  readonly pullRequest: {
    readonly state: "open" | "closed"
    readonly draft: boolean
    readonly headSha: string
    readonly baseRef: string
  }
  /** Findings reported in this run, anchored or not. */
  readonly findings: ReadonlyArray<{ readonly severity: Severity }>
  readonly threads: ReadonlyArray<ThreadState>
  /** From the GitHub API, never the sandbox. */
  readonly changedFiles: ReadonlyArray<PullRequestFile>
  readonly manifests: ReadonlyArray<ManifestChange>
  readonly sensitive: SensitivePaths
  /** Janitor has an earlier `REQUEST_CHANGES` review on the PR that isn't dismissed. */
  readonly earlierChangesRequested: boolean
}

export type GateFailure =
  | { readonly _tag: "HeadMoved" }
  | { readonly _tag: "Unfinished"; readonly outcome: Exclude<RunOutcome, "completed"> }
  | { readonly _tag: "BlockingFindings" }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Draft" }
  | { readonly _tag: "BaseChanged" }
  | { readonly _tag: "Forced" }
  | { readonly _tag: "SensitivePaths"; readonly paths: ReadonlyArray<string> }

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1)

const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeManifest = Schema.decodeUnknownOption(Manifest)

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Key order doesn't matter; a nested or malformed entry only matches itself. */
const sameSection = (base: unknown, head: unknown) => {
  if (!isRecord(base) || !isRecord(head)) return base === head
  const names = Object.keys(base)
  return (
    names.length === Object.keys(head).length &&
    names.every((name) => Object.hasOwn(head, name) && base[name] === head[name])
  )
}

/** A manifest janitor can't read on either side counts as a dependency change. */
const changesDependencies = (change: ManifestChange | undefined) => {
  if (change === undefined) return true
  const side = (text: string | undefined): Option.Option<Readonly<Record<string, unknown>>> =>
    text === undefined ? Option.some({}) : decodeManifest(text)
  const base = side(change.base)
  const head = side(change.head)
  if (Option.isNone(base) || Option.isNone(head)) return true
  return DEPENDENCY_SECTIONS.some(
    (section) => !sameSection(base.value[section], head.value[section]),
  )
}

const isSensitive = (
  path: string,
  sensitive: SensitivePaths,
  manifests: ReadonlyArray<ManifestChange>,
) =>
  sensitive.globs.some((glob) => matchesGlob(glob, path)) ||
  sensitive.lockfiles.includes(fileName(path)) ||
  (sensitive.manifests.includes(fileName(path)) &&
    changesDependencies(manifests.find((manifest) => manifest.path === path)))

const sensitivePaths = (input: ReviewInput) => {
  const touched = input.changedFiles.flatMap((file) =>
    file.previous_filename === undefined
      ? [file.filename]
      : [file.filename, file.previous_filename],
  )
  return [...new Set(touched)].filter((path) => isSensitive(path, input.sensitive, input.manifests))
}

/**
 * Whether a blocking finding stands at a clearing level. This run's findings
 * always stand; a thread stands until it is cleared at that level.
 */
const blockingStands = (
  findings: ReadonlyArray<{ readonly severity: Severity }>,
  threads: ReadonlyArray<ThreadState>,
  level: "dismissal" | "approval",
) =>
  findings.some((finding) => finding.severity === "blocking") ||
  threads.some(
    (thread) =>
      thread.severity === "blocking" &&
      (level === "approval" ? thread.clearing !== "approval" : thread.clearing === "standing"),
  )

/** Every failed approval gate (EFF-1650 point 2), in gate order; empty means approve. */
export const approvalGates = (input: ReviewInput): ReadonlyArray<GateFailure> => {
  const failures: Array<GateFailure> = []
  const { pullRequest } = input
  if (pullRequest.headSha !== input.reviewedSha) failures.push({ _tag: "HeadMoved" })
  if (input.outcome !== "completed") failures.push({ _tag: "Unfinished", outcome: input.outcome })
  if (blockingStands(input.findings, input.threads, "approval")) {
    failures.push({ _tag: "BlockingFindings" })
  }
  if (pullRequest.state !== "open") failures.push({ _tag: "Closed" })
  if (pullRequest.draft) failures.push({ _tag: "Draft" })
  if (pullRequest.baseRef !== input.baseRefAtStart) failures.push({ _tag: "BaseChanged" })
  if (input.forced) failures.push({ _tag: "Forced" })
  if (!input.authorCanWrite) {
    const paths = sensitivePaths(input)
    if (paths.length > 0) failures.push({ _tag: "SensitivePaths", paths })
  }
  return failures
}

export interface ReviewDecision {
  /** The review to post, or `null` for no review. */
  readonly event: Verdict | null
  /** Dismiss janitor's earlier `REQUEST_CHANGES` reviews. */
  readonly dismissEarlier: boolean
  readonly gateFailures: ReadonlyArray<GateFailure>
}

/**
 * An unfinished run fails the gates, so it requests changes or comments and
 * never approves. A run with nothing new, no thread state change and no
 * dismissal or approval posts no review (EFF-1649 rule 17).
 */
export const decideReview = (input: ReviewInput): ReviewDecision => {
  const gateFailures = approvalGates(input)
  const blocking = blockingStands(input.findings, input.threads, "dismissal")
  const dismissEarlier = input.earlierChangesRequested && !blocking
  const changed =
    input.findings.length > 0 || input.threads.some((thread) => thread.changed) || dismissEarlier
  const nits =
    input.findings.some((finding) => finding.severity === "nit") ||
    input.threads.some((thread) => thread.severity === "nit" && thread.clearing === "standing")
  const event: Verdict | null = blocking
    ? changed
      ? "request_changes"
      : null
    : gateFailures.length === 0
      ? "approve"
      : nits && changed
        ? "comment"
        : null
  return { event, dismissEarlier, gateFailures }
}

export type CheckRunInput =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Skipped"; readonly reason: SkipReason }
  | {
      readonly _tag: "Ended"
      readonly outcome: RunOutcome
      readonly findings: ReadonlyArray<{ readonly severity: Severity }>
      readonly threads: ReadonlyArray<ThreadState>
    }

/** The `janitor/review` check run (EFF-1648 point 11). */
export type CheckRun =
  | { readonly status: "in_progress" }
  | { readonly status: "completed"; readonly conclusion: "success" | "failure" | "cancelled" }
  | {
      readonly status: "completed"
      readonly conclusion: "neutral"
      readonly reason: SkipReason | "interrupted" | "errored"
    }

export const checkRun = (input: CheckRunInput): CheckRun => {
  switch (input._tag) {
    case "Running":
      return { status: "in_progress" }
    case "Cancelled":
      return { status: "completed", conclusion: "cancelled" }
    case "Skipped":
      return { status: "completed", conclusion: "neutral", reason: input.reason }
    case "Ended":
      if (input.outcome === "interrupted" || input.outcome === "errored") {
        return { status: "completed", conclusion: "neutral", reason: input.outcome }
      }
      return {
        status: "completed",
        conclusion: blockingStands(input.findings, input.threads, "dismissal")
          ? "failure"
          : "success",
      }
  }
}

/**
 * Splits accepted findings into inline comments and the body list: blocking
 * findings take slots first, and overflow and unanchored findings go to the body.
 */
export const allocateInline = <
  A extends { readonly severity: Severity; readonly anchored: boolean },
>(
  findings: ReadonlyArray<A>,
  limit: number,
): { readonly inline: ReadonlyArray<A>; readonly body: ReadonlyArray<A> } => {
  const anchored = (severity: Severity) =>
    findings.filter((finding) => finding.anchored && finding.severity === severity)
  const inline = [...anchored("blocking"), ...anchored("nit")].slice(0, Math.max(0, limit))
  return { inline, body: findings.filter((finding) => !inline.includes(finding)) }
}
