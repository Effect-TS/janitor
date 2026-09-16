import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Ref, Remote } from "./Remote.ts"

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  command: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `git ${this.command} exited ${this.exitCode}: ${this.stderr}`
  }
}

export const CheckoutOptions = Schema.Struct({
  key: Schema.NonEmptyString,
  remote: Remote,
  /** Branch, full ref (including refs/pull/N/head), or commit ID. */
  ref: Schema.optionalKey(Ref),
  /** Explicitly discard local changes and reset to the requested ref. */
  fresh: Schema.optionalKey(Schema.Boolean),
})
export type CheckoutOptions = typeof CheckoutOptions.Type

export const Checkout = Schema.Struct({
  key: Schema.NonEmptyString,
  root: Schema.NonEmptyString,
  /** Path relative to the sandbox root; `.` when the whole machine is the checkout. */
  path: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  remote: Remote,
  /** Requested ref, retained so repeated acquisition can detect conflicting requests. */
  ref: Schema.NonEmptyString,
})
export type Checkout = typeof Checkout.Type

export interface CheckoutsService {
  readonly checkout: (options: CheckoutOptions) => Effect.Effect<Checkout, GitError>
  readonly get: (key: string) => Effect.Effect<Option.Option<Checkout>, GitError>
  readonly release: (key: string) => Effect.Effect<void, GitError>
}

/** Repository copies addressed by a stable session key. */
export class Checkouts extends Context.Service<Checkouts, CheckoutsService>()(
  "@janitor/alchemy/Git/Checkouts",
) {}

export const failure =
  (command: string) =>
  (error: unknown): GitError =>
    Schema.is(GitError)(error)
      ? error
      : new GitError({ command, exitCode: -1, stderr: String(error) })
