import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId } from "../../GitHub/Id.ts"
import { GitHubEntityKind } from "../../GitHub/ReadModel.ts"

/**
 * The fact catalog (plan: "One catalog of facts"). Everything that needs to
 * know what a fact is reads this table: predicate validity, compilation,
 * snapshot construction, fingerprinting, editor completion, and later AI
 * evidence. Adding a fact means adding one entry here.
 */

export const FactName = Schema.Literals([
  "title",
  "body",
  "author",
  "state",
  "labels",
  "draft",
  "baseRef",
  "headSha",
  "changedFiles",
  "checks",
  "reviews",
]).annotate({ identifier: "FactName" })
export type FactName = typeof FactName.Type

/**
 * Synchronization tracks a fact needs before it is available. The first
 * three exist today; the rest are declared so programs can name their
 * facts now and compile to a requirement that activation cannot yet meet.
 */
export const FactTrack = Schema.Literals([
  "labels",
  "entities",
  "pull_requests",
  "changed_files",
  "checks",
  "reviews",
]).annotate({ identifier: "FactTrack" })
export type FactTrack = typeof FactTrack.Type

/** Scalar field types an item of a collection fact may carry. */
export const ItemFieldType = Schema.Literals(["Text", "Flag"]).annotate({
  identifier: "ItemFieldType",
})
export type ItemFieldType = typeof ItemFieldType.Type

export type FactType =
  | { readonly _tag: "Text" }
  | { readonly _tag: "Flag" }
  | { readonly _tag: "LabelSet" }
  | { readonly _tag: "Collection"; readonly fields: Readonly<Record<string, ItemFieldType>> }

export interface FactDefinition {
  readonly type: FactType
  readonly kinds: ReadonlyArray<GitHubEntityKind>
  readonly track: FactTrack
  readonly description: string
}

const both: ReadonlyArray<GitHubEntityKind> = ["issue", "pull_request"]
const pullRequest: ReadonlyArray<GitHubEntityKind> = ["pull_request"]

export const FactCatalog: Readonly<Record<FactName, FactDefinition>> = {
  title: { type: { _tag: "Text" }, kinds: both, track: "entities", description: "Title" },
  body: { type: { _tag: "Text" }, kinds: both, track: "entities", description: "Body" },
  author: {
    type: { _tag: "Text" },
    kinds: both,
    track: "entities",
    description: "Author login, compared case-insensitively",
  },
  state: { type: { _tag: "Text" }, kinds: both, track: "entities", description: "open or closed" },
  labels: {
    type: { _tag: "LabelSet" },
    kinds: both,
    track: "labels",
    description: "Labels currently applied, by stable ID",
  },
  draft: {
    type: { _tag: "Flag" },
    kinds: pullRequest,
    track: "pull_requests",
    description: "Whether the pull request is a draft",
  },
  baseRef: {
    type: { _tag: "Text" },
    kinds: pullRequest,
    track: "pull_requests",
    description: "Base branch name",
  },
  headSha: {
    type: { _tag: "Text" },
    kinds: pullRequest,
    track: "pull_requests",
    description: "Head commit SHA",
  },
  changedFiles: {
    type: { _tag: "Collection", fields: { path: "Text", status: "Text" } },
    kinds: pullRequest,
    track: "changed_files",
    description: "Files changed by the pull request",
  },
  checks: {
    type: { _tag: "Collection", fields: { name: "Text", state: "Text" } },
    kinds: pullRequest,
    track: "checks",
    description:
      "Check runs on the head commit; state is the conclusion, or the status while running",
  },
  reviews: {
    type: { _tag: "Collection", fields: { reviewer: "Text", state: "Text" } },
    kinds: pullRequest,
    track: "reviews",
    description: "Latest review per reviewer",
  },
}

export const factNames: ReadonlyArray<FactName> = FactName.literals

export const factsFor = (kind: GitHubEntityKind): ReadonlyArray<FactName> =>
  factNames.filter((name) => FactCatalog[name].kinds.includes(kind))

export const tracksFor = (facts: Iterable<FactName>): ReadonlyArray<FactTrack> =>
  [...new Set([...facts].map((name) => FactCatalog[name].track))].sort()

/**
 * A fact's value in a snapshot. A missing key means the snapshot cannot
 * supply the fact, which evaluation reports as `unknown`.
 */
export const ItemValue = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Boolean, Schema.Null]),
)
export type ItemValue = typeof ItemValue.Type

export const FactValue = Schema.Union([
  Schema.TaggedStruct("Text", { value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("Flag", { value: Schema.Boolean }),
  Schema.TaggedStruct("LabelSet", { value: Schema.Array(GitHubLabelDatabaseId) }),
  Schema.TaggedStruct("Collection", { value: Schema.Array(ItemValue) }),
]).annotate({ identifier: "FactValue" })
export type FactValue = typeof FactValue.Type

export const FactSnapshot = Schema.Struct({
  kind: GitHubEntityKind,
  /** Keyed by fact name. Absent facts are unavailable, not empty. */
  facts: Schema.Record(Schema.String, FactValue),
  unavailableReasons: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "FactSnapshot" })
export type FactSnapshot = typeof FactSnapshot.Type

/** The synchronized fields facts are built from today. */
export interface EntityFields {
  readonly kind: GitHubEntityKind
  readonly title: string
  readonly body: string | null
  readonly authorLogin: string
  readonly state: "open" | "closed"
  readonly labels: ReadonlyArray<GitHubLabelDatabaseId>
  readonly pullRequest: {
    readonly baseRef: string
    readonly draft: boolean
    readonly headSha: string
  } | null
  /** Present once an entity refresh fetched them; absent facts evaluate unknown. */
  readonly collections?: {
    readonly files: ReadonlyArray<{ readonly path: string; readonly status: string }>
    readonly checks: ReadonlyArray<{ readonly name: string; readonly state: string }>
    readonly reviews: ReadonlyArray<{ readonly reviewer: string; readonly state: string }>
  }
}

/** Builds the facts the read model can supply; collection facts stay absent until their tracks exist. */
export const snapshotFacts = (entity: EntityFields): FactSnapshot => {
  const facts: Partial<Record<FactName, FactValue>> = {
    title: { _tag: "Text", value: entity.title },
    body: { _tag: "Text", value: entity.body },
    author: { _tag: "Text", value: entity.authorLogin },
    state: { _tag: "Text", value: entity.state },
    labels: { _tag: "LabelSet", value: entity.labels },
  }
  if (entity.pullRequest !== null) {
    facts.draft = { _tag: "Flag", value: entity.pullRequest.draft }
    facts.baseRef = { _tag: "Text", value: entity.pullRequest.baseRef }
    facts.headSha = { _tag: "Text", value: entity.pullRequest.headSha }
  }
  if (entity.collections !== undefined) {
    facts.changedFiles = {
      _tag: "Collection",
      value: entity.collections.files.map((file) => ({ path: file.path, status: file.status })),
    }
    facts.checks = {
      _tag: "Collection",
      value: entity.collections.checks.map((check) => ({ name: check.name, state: check.state })),
    }
    facts.reviews = {
      _tag: "Collection",
      value: entity.collections.reviews.map((review) => ({
        reviewer: review.reviewer,
        state: review.state,
      })),
    }
  }
  return { kind: entity.kind, facts }
}

// CATALOG DESCRIPTION

/** What editors need to offer completion: generated here so it cannot drift. */
export const FactDescription = Schema.Struct({
  name: FactName,
  type: Schema.Literals(["Text", "Flag", "LabelSet", "Collection"]),
  kinds: Schema.Array(GitHubEntityKind),
  track: FactTrack,
  description: Schema.String,
  operators: Schema.Array(Schema.String),
  /** Item fields with their operators, for collection facts. */
  fields: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: ItemFieldType,
      operators: Schema.Array(Schema.String),
    }),
  ),
}).annotate({ identifier: "FactDescription" })
export type FactDescription = typeof FactDescription.Type

export const textOperators = [
  "equals",
  "notEquals",
  "contains",
  "matchesGlob",
  "in",
  "isEmpty",
  "notEmpty",
]
export const flagOperators = ["is"]
export const labelSetOperators = ["has", "isEmpty", "notEmpty"]
export const quantifiers = ["some", "every", "none"]

const operatorsFor = (type: FactType["_tag"] | ItemFieldType): ReadonlyArray<string> => {
  switch (type) {
    case "Text":
      return textOperators
    case "Flag":
      return flagOperators
    case "LabelSet":
      return labelSetOperators
    case "Collection":
      return quantifiers
  }
}

export const describeCatalog = (): ReadonlyArray<FactDescription> =>
  factNames.map((name) => {
    const definition = FactCatalog[name]
    return {
      name,
      type: definition.type._tag,
      kinds: definition.kinds,
      track: definition.track,
      description: definition.description,
      operators: operatorsFor(definition.type._tag),
      fields:
        definition.type._tag === "Collection"
          ? Object.entries(definition.type.fields).map(([field, type]) => ({
              name: field,
              type,
              operators: operatorsFor(type),
            }))
          : [],
    }
  })
