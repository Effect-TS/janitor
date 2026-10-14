import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import type { LineAnchor, TrustedDiff } from "./Diff.ts"
import type { Judgement, LineRange, Severity, ThreadJudgement } from "./Finding.ts"
import type { Fingerprint, HeadMatch } from "./Fingerprint.ts"

/**
 * A human in a janitor thread: a write-access user other than the PR author,
 * the PR author (whatever their permission), or anyone else.
 */
export type Actor = "maintainer" | "author" | "other"

/** One of janitor's review threads from earlier runs, as read from GitHub at run start. */
export interface EarlierThread {
  readonly id: string
  readonly path: string
  readonly anchor: LineRange
  readonly severity: Severity
  readonly fingerprint: Fingerprint
  readonly outdated: boolean
  readonly resolvedBy?: Actor
  /** Human replies; janitor's own are summarised in `janitor`. */
  readonly replies: ReadonlyArray<{ readonly by: Actor; readonly at: DateTime.Utc }>
  /** Janitor's last comment in the thread (the root or its latest reply) and what it stated then. */
  readonly janitor: {
    readonly at: DateTime.Utc
    readonly judgement: Judgement
    readonly outdated: boolean
    readonly resolved: boolean
  }
}

const overlaps = (a: LineAnchor, b: LineAnchor) =>
  a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine

/**
 * Rejects a `reportFinding` call that repeats an open thread (unless withdrawn
 * earlier in this run), a finding already reported in this run, or the code of
 * a thread a maintainer resolved. Returns the error for the model.
 */
export const checkDuplicate = (
  candidate: LineAnchor & { readonly fingerprint: Fingerprint },
  run: {
    readonly threads: ReadonlyArray<EarlierThread>
    readonly withdrawn: ReadonlyArray<string>
    readonly reported: ReadonlyArray<LineAnchor>
  },
): Option.Option<string> => {
  const covering = run.threads.find(
    (thread) =>
      thread.resolvedBy === undefined &&
      !run.withdrawn.includes(thread.id) &&
      overlaps(candidate, { path: thread.path, ...thread.anchor }),
  )
  if (covering !== undefined) {
    return Option.some(`already covered by thread ${covering.id}, use updateThread`)
  }
  if (run.reported.some((reported) => overlaps(candidate, reported))) {
    return Option.some("overlaps a finding already reported in this run")
  }
  // A maintainer's resolution holds while the fingerprinted code is unchanged (EFF-1649 rule 9).
  const overridden = run.threads.find(
    (thread) => thread.resolvedBy === "maintainer" && thread.fingerprint === candidate.fingerprint,
  )
  if (overridden !== undefined) {
    return Option.some(
      `thread ${overridden.id} was resolved by a maintainer and its code hasn't changed`,
    )
  }
  return Option.none()
}

/** `dismissal` stops counting toward `REQUEST_CHANGES`; `approval` also stops withholding approval. */
export type Clearing = "standing" | "dismissal" | "approval"

export interface ThreadState {
  readonly threadId: string
  readonly severity: Severity
  /** The agent's judgement, or `addressed` from trusted code when the path left the diff. */
  readonly judgement: ThreadJudgement
  readonly clearing: Clearing
  /** The judgement or outdated flag differs from what janitor last stated in the thread. */
  readonly changed: boolean
}

const clearing = (
  thread: EarlierThread,
  judgement: Judgement,
  headMatch: HeadMatch,
  authorCanWrite: boolean,
): Clearing => {
  // The PR author never clears for approval, even with write access (EFF-1650 point 3).
  const maintainer =
    thread.resolvedBy === "maintainer" || thread.replies.some((reply) => reply.by === "maintainer")
  if ((judgement === "addressed" && headMatch._tag === "Gone") || maintainer) return "approval"
  const author =
    thread.resolvedBy === "author" || thread.replies.some((reply) => reply.by === "author")
  if (judgement !== "still_applies" || (authorCanWrite && author)) return "dismissal"
  return "standing"
}

export const judgeThread = (
  thread: EarlierThread,
  context: {
    readonly diff: TrustedDiff
    readonly judgement?: ThreadJudgement
    readonly headMatch: HeadMatch
    readonly authorCanWrite: boolean
  },
): ThreadState => {
  const file = context.diff.files.find((candidate) => candidate.path === thread.path)
  // A path that left the diff is addressed without asking the agent (EFF-1649 rule 5).
  const judgement: ThreadJudgement =
    file === undefined || file._tag === "Deleted"
      ? { judgement: "addressed" }
      : (context.judgement ?? { judgement: "still_applies" })
  return {
    threadId: thread.id,
    severity: thread.severity,
    judgement,
    clearing: clearing(thread, judgement.judgement, context.headMatch, context.authorCanWrite),
    changed:
      judgement.judgement !== thread.janitor.judgement ||
      (judgement.judgement === "still_applies" && thread.outdated && !thread.janitor.outdated),
  }
}

export interface ThreadReply {
  readonly threadId: string
  readonly judgement: Judgement
  readonly note?: string
  /** On a "Still applies at" reply: a permalink to the lines in the blob at the head SHA. */
  readonly stillAppliesAt?: string
}

const permalink = (repository: string, headSha: string, path: string, lines: LineRange) => {
  const fragment =
    lines.startLine === lines.endLine
      ? `L${lines.startLine}`
      : `L${lines.startLine}-L${lines.endLine}`
  const encodedPath = path.split("/").map(encodeURIComponent).join("/")
  return `https://github.com/${repository}/blob/${headSha}/${encodedPath}#${fragment}`
}

export const planReply = (
  thread: EarlierThread,
  state: ThreadState,
  context: {
    readonly repository: string
    readonly headSha: string
    readonly headMatch: HeadMatch
    readonly authorCanWrite: boolean
  },
): Option.Option<ThreadReply> => {
  const humanReplied = thread.replies.some((reply) =>
    DateTime.isGreaterThan(reply.at, thread.janitor.at),
  )
  // A resolution by an author without write access counts as a reply with no text (rule 11).
  const resolvedByOutsideAuthor =
    thread.resolvedBy === "author" && !context.authorCanWrite && !thread.janitor.resolved
  if (!state.changed && !humanReplied && !resolvedByOutsideAuthor) return Option.none()
  const { judgement, note, anchor } = state.judgement
  const location = anchor ?? (context.headMatch._tag === "Matches" ? context.headMatch : undefined)
  return Option.some({
    threadId: thread.id,
    judgement,
    ...(note === undefined ? {} : { note }),
    ...(judgement === "still_applies" && thread.outdated && location !== undefined
      ? { stillAppliesAt: permalink(context.repository, context.headSha, thread.path, location) }
      : {}),
  })
}
