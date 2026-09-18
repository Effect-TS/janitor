import { ReproductionPrText } from "./Draft.ts"
import * as Schema from "effect/Schema"

/**
 * What a review run concludes (ADR 0007): the agent classifies the issue,
 * writes its findings and uncertainty in its own words, and cites the
 * evidence it used. Trusted code keeps only evidence the run observed and
 * marks the rest unverified; it never rewrites the prose.
 */

export const ReviewClassification = Schema.Literals(["bug", "enhancement", "question", "unclear"])
export type ReviewClassification = typeof ReviewClassification.Type

export const ReviewEvidenceKind = Schema.Literals(["issue", "pull_request", "file"])
export type ReviewEvidenceKind = typeof ReviewEvidenceKind.Type

/** An evidence citation as the agent gives it: a number for items, a path for files. */
export const ReviewCitation = Schema.Struct({
  kind: ReviewEvidenceKind,
  reference: Schema.String.check(Schema.isMaxLength(500)),
  note: Schema.String.check(Schema.isMaxLength(1000)),
})
export type ReviewCitation = typeof ReviewCitation.Type

/** The contract of the agent's `finish` call. Sizes bound the stored prose. */
export const ReviewConclusion = Schema.Struct({
  reproductionPr: Schema.optionalKey(Schema.NullOr(ReproductionPrText)),
  classification: ReviewClassification,
  findings: Schema.String.check(Schema.isMaxLength(16_000)),
  uncertainty: Schema.String.check(Schema.isMaxLength(4_000)),
  evidence: Schema.Array(ReviewCitation).check(Schema.isMaxLength(50)),
})
export type ReviewConclusion = typeof ReviewConclusion.Type

/** A citation after validation: verified when the run observed the item or file. */
export const ReviewEvidence = Schema.Struct({
  ...ReviewCitation.fields,
  verified: Schema.Boolean,
  /** The GitHub page of a verified issue or pull request. */
  url: Schema.NullOr(Schema.String),
})
export type ReviewEvidence = typeof ReviewEvidence.Type
