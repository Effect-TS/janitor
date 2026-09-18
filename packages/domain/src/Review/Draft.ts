import * as Schema from "effect/Schema"

/** Agent prose for publication outcomes, retained before any attempt. */
export const ReproductionPrText = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(240)),
  body: Schema.String.check(Schema.isMaxLength(20_000)),
  /** {{pr_url}} is replaced only with the confirmed GitHub PR URL. */
  publishedSummary: Schema.String.check(Schema.isMaxLength(20_000)),
  blockedSummary: Schema.String.check(Schema.isMaxLength(20_000)),
  /** Optional for saved results from before draft reuse was supported. */
  reuseBlockedSummary: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
})
export type ReproductionPrText = typeof ReproductionPrText.Type

export const DraftPublication = Schema.Struct({
  status: Schema.Literals(["pending", "branch", "published", "blocked", "rejected", "unresolved"]),
  branch: Schema.String,
  baseCommit: Schema.String,
  defaultBranch: Schema.String,
  text: ReproductionPrText,
  /** Each attempt is persisted before sending, separately from its result. */
  attempted: Schema.NullOr(Schema.Literals(["tree", "commit", "branch", "pr"])),
  treeSha: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(Schema.Int),
  url: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  /** Present for reuse; survives recovery independently of the prior run's history. */
  reuse: Schema.optionalKey(
    Schema.Struct({
      ownerRunId: Schema.String,
      headSha: Schema.String,
      prHash: Schema.String,
      base: Schema.String,
      newPrHash: Schema.String,
    }),
  ),
})
export type DraftPublication = typeof DraftPublication.Type
