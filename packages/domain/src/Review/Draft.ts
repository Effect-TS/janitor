import * as Schema from "effect/Schema"

/** Agent prose for both outcomes, retained before any publication attempt. */
export const ReproductionPrText = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(240)),
  body: Schema.String.check(Schema.isMaxLength(20_000)),
  /** {{pr_url}} is replaced only with the confirmed GitHub PR URL. */
  publishedSummary: Schema.String.check(Schema.isMaxLength(20_000)),
  blockedSummary: Schema.String.check(Schema.isMaxLength(20_000)),
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
})
export type DraftPublication = typeof DraftPublication.Type
