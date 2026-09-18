import * as Schema from "effect/Schema"

export const ReviewPublication = Schema.Struct({
  status: Schema.Literals([
    "none",
    "pending",
    "attempted",
    "published",
    "blocked",
    "rejected",
    "unresolved",
  ]),
  /** Exact agent-authored output and an opaque recovery marker, saved before sending. */
  body: Schema.NullOr(Schema.String),
  commentId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
})
export type ReviewPublication = typeof ReviewPublication.Type
export const noPublication: ReviewPublication = {
  status: "none",
  body: null,
  commentId: null,
  url: null,
  reason: null,
}
