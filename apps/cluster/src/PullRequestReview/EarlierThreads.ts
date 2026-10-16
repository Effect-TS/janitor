import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { parseReplyMarker, parseSeverityMarker } from "@janitor/domain/PullRequestReview/Render"
import type { Actor, EarlierThread } from "@janitor/domain/PullRequestReview/Threads"
import type * as ReviewGitHub from "./GitHub.ts"

/**
 * Janitor's review threads from earlier runs, as the review rules see them.
 * The agent loop judges and deduplicates against them, and `Publish` decides
 * replies and clearing from them, so both read them the same way.
 */

const WRITE_ACCESS: ReadonlyArray<ReviewGitHub.RepositoryPermission> = [
  "admin",
  "maintain",
  "write",
]

/** The judgement in one of janitor's replies written before replies carried a marker. */
const statedJudgement = (body: string, isRoot: boolean) =>
  isRoot || body.startsWith("Still applies")
    ? ("still_applies" as const)
    : body.startsWith("Addressed in")
      ? ("addressed" as const)
      : body.startsWith("Withdrawn")
        ? ("withdrawn" as const)
        : ("still_applies" as const)

/** The comment text of a janitor thread's root, without its hidden marker. */
export const rootComment = (body: string) =>
  body.replace(/\s*<!-- janitor:finding [^>]*-->\s*$/, "")

/** Who a login is on this pull request: the author, a maintainer with write access, or anyone else. */
export const makeActors = (
  client: ReviewGitHub.PullRequestGitHub,
  pull: ReviewGitHub.PullRequest,
) => {
  const authorLogin = Option.map(pull.author, (author) => author.login)
  const canWrite = (login: string) =>
    Effect.map(client.permission(login), (permission) => WRITE_ACCESS.includes(permission))
  return {
    authorCanWrite: Option.isSome(authorLogin)
      ? canWrite(authorLogin.value)
      : Effect.succeed(false),
    actor: (login: string) =>
      Option.getOrUndefined(authorLogin) === login
        ? Effect.succeed<Actor>("author")
        : Effect.map(canWrite(login), (write): Actor => (write ? "maintainer" : "other")),
  }
}

/** One of janitor's threads, with its human replies and resolution attributed by `actor`. */
export const earlierThread = <E>(
  thread: ReviewGitHub.JanitorThread,
  actor: (login: string) => Effect.Effect<Actor, E>,
) =>
  Effect.gen(function* () {
    const root = thread.comments[0]!
    const own = thread.comments.filter((comment) => comment.byJanitor)
    const last = own.at(-1) ?? root
    const end = thread.line ?? thread.startLine ?? 1
    const anchor = { startLine: Math.min(thread.startLine ?? end, end), endLine: end }
    const replies = yield* Effect.forEach(
      thread.comments.filter((comment) => !comment.byJanitor),
      (comment) => Effect.map(actor(comment.author), (by) => ({ by, at: comment.createdAt })),
    )
    const resolvedBy = Option.isSome(thread.resolvedBy)
      ? yield* actor(thread.resolvedBy.value)
      : undefined
    const earlier: EarlierThread = {
      id: thread.id,
      path: thread.path,
      anchor,
      // A marker from before severities were recorded is taken as blocking.
      severity: Option.getOrElse(parseSeverityMarker(root.body), () => "blocking" as const),
      fingerprint: thread.fingerprint,
      outdated: thread.isOutdated,
      ...(resolvedBy === undefined ? {} : { resolvedBy }),
      replies,
      janitor: {
        at: last.createdAt,
        // What janitor stated, and saw, when it last spoke; a reply from
        // before markers is read from its text and never saw a resolution.
        ...Option.getOrElse(last === root ? Option.none() : parseReplyMarker(last.body), () => ({
          judgement: statedJudgement(last.body, last === root),
          outdated: last !== root && last.body.startsWith("Still applies at"),
          resolved: false,
        })),
      },
    }
    return earlier
  })
