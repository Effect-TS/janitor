import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * The sandbox checkout (EFF-1645 point 2, EFF-1892): the container fetches
 * the pull request's head and base SHA from the base repository, depth 1,
 * and checks out the head only if it is still the SHA recorded at admission.
 * The egress handler authenticates the fetch; nothing here sees a token.
 */

/** A git command exited non-zero, or couldn't run. */
export class GitCommandFailed extends Schema.TaggedError<GitCommandFailed>()("GitCommandFailed", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {}

/** The pull request's head moved after admission. Retrying can't help. */
export class HeadShaMismatch extends Schema.TaggedError<HeadShaMismatch>()("HeadShaMismatch", {
  expected: Schema.String,
  actual: Schema.String,
}) {}

/** Runs `git` with these arguments in `/workspace` and returns its stdout. */
export type Git = (args: ReadonlyArray<string>) => Effect.Effect<string, GitCommandFailed>

export const CheckoutRequest = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  prNumber: Schema.Int,
  baseSha: Schema.String,
  headSha: Schema.String,
})
export type CheckoutRequest = typeof CheckoutRequest.Type

/** What the provisioning endpoint answers. */
export const CheckoutOutcome = Schema.Union([
  Schema.TaggedStruct("CheckedOut", {}),
  GitCommandFailed,
  HeadShaMismatch,
])
export type CheckoutOutcome = typeof CheckoutOutcome.Type

export const checkout = Effect.fnUntraced(function* (git: Git, request: CheckoutRequest) {
  const ref = `refs/pull/${request.prNumber}/head`
  yield* git(["init", "--quiet"])
  yield* git(["remote", "add", "origin", `https://github.com/${request.owner}/${request.repo}.git`])
  yield* git([
    "fetch",
    "--quiet",
    "--depth=1",
    "--no-tags",
    "origin",
    `+${ref}:${ref}`,
    request.baseSha,
  ])
  const actual = (yield* git(["rev-parse", ref])).trim()
  if (actual !== request.headSha) {
    return yield* new HeadShaMismatch({ expected: request.headSha, actual })
  }
  yield* git(["checkout", "--quiet", "--detach", request.headSha])
})
