import * as Schema from "effect/Schema"
import { format } from "@/components/policy-source/format"

/**
 * Wire schemas for the auto-labeling API, mirrored from
 * `@janitor/domain/Labeling/Policy/*`. See sync-button.ts for why the
 * schemas are copied rather than imported.
 */

// ENDPOINTS

export const REPOSITORIES_ENDPOINT = "/api/v1/repositories"
export const CATALOG_ENDPOINT = "/api/v1/labeling/catalog"

const repository = (repositoryId: string) =>
  `${REPOSITORIES_ENDPOINT}/${encodeURIComponent(repositoryId)}`
export const configurationEndpoint = (repositoryId: string) =>
  `${repository(repositoryId)}/configuration`
export const reconciliationsEndpoint = (repositoryId: string) =>
  `${repository(repositoryId)}/reconciliations`
export const policiesEndpoint = (repositoryId: string) => `${repository(repositoryId)}/policies`
export const policyEndpoint = (repositoryId: string, policyId: string) =>
  `${policiesEndpoint(repositoryId)}/${encodeURIComponent(policyId)}`
export const publishEndpoint = (repositoryId: string, policyId: string) =>
  `${policyEndpoint(repositoryId, policyId)}/publish`
export const validateEndpoint = (repositoryId: string) =>
  `${policiesEndpoint(repositoryId)}/validate`
export const rulesEndpoint = (repositoryId: string) => `${repository(repositoryId)}/rules`
export const ruleEndpoint = (repositoryId: string, ruleId: string) =>
  `${rulesEndpoint(repositoryId)}/${encodeURIComponent(ruleId)}`
export const testEndpoint = (repositoryId: string) => `${repository(repositoryId)}/test`
export const aiConsentEndpoint = (repositoryId: string) => `${repository(repositoryId)}/ai-consent`

// REPOSITORIES

export const RepositoryOverview = Schema.Struct({
  repositoryId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  enabled: Schema.Boolean,
  syncEnabled: Schema.optionalKey(Schema.Boolean),
  ruleCount: Schema.Int,
  policyCount: Schema.Int,
  access: Schema.Literals(["accessible", "suspect", "lost"]),
  configuredRevision: Schema.NullOr(Schema.Int),
  activeRevision: Schema.NullOr(Schema.Int),
})
export type RepositoryOverview = typeof RepositoryOverview.Type

// CATALOG

export const FactDescription = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["Text", "Flag", "LabelSet", "Collection"]),
  kinds: Schema.Array(Schema.Literals(["issue", "pull_request"])),
  track: Schema.String,
  description: Schema.String,
  operators: Schema.Array(Schema.String),
  fields: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.Literals(["Text", "Flag"]),
      operators: Schema.Array(Schema.String),
    }),
  ),
})
export type FactDescription = typeof FactDescription.Type

// POLICIES

export const PolicyTarget = Schema.Literals(["issue", "pull_request"])
export type PolicyTarget = typeof PolicyTarget.Type

export const Manifest = Schema.Struct({
  facts: Schema.Array(Schema.String),
  tracks: Schema.Array(Schema.String),
  references: Schema.Array(Schema.String),
  nodeCount: Schema.Int,
  expandedNodeCount: Schema.Int,
})
export type Manifest = typeof Manifest.Type

export const PolicyRecord = Schema.Struct({
  policyId: Schema.String,
  repositoryId: Schema.String,
  name: Schema.String,
  target: PolicyTarget,
  description: Schema.String,
  publishedVersionId: Schema.NullOr(Schema.String),
  publishedRevision: Schema.NullOr(Schema.Int),
  draftDiffers: Schema.optionalKey(Schema.Boolean),
  publishedEvaluator: Schema.optionalKey(Schema.Literals(["Conditions", "Classifier"])),
  version: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})
export type PolicyRecord = typeof PolicyRecord.Type

/** The authoring form is free JSON on the wire; the server validates it. */
export const ProgramSource = Schema.Struct({
  target: PolicyTarget,
  appliesWhen: Schema.optionalKey(Schema.Unknown),
  matchesWhen: Schema.optionalKey(Schema.Unknown),
  classify: Schema.optionalKey(Schema.Unknown),
})
export type ProgramSource = typeof ProgramSource.Type

export const PolicyVersionRecord = Schema.Struct({
  versionId: Schema.String,
  policyId: Schema.String,
  revision: Schema.Int,
  contentHash: Schema.String,
  program: Schema.Unknown,
  manifest: Manifest,
  createdAt: Schema.DateTimeUtc,
})
export type PolicyVersionRecord = typeof PolicyVersionRecord.Type

export const PolicyDetail = Schema.Struct({
  policy: PolicyRecord,
  draft: ProgramSource,
  draftDiffers: Schema.Boolean,
  publishedSource: Schema.optionalKey(Schema.NullOr(ProgramSource)),
  published: Schema.NullOr(PolicyVersionRecord),
})
export type PolicyDetail = typeof PolicyDetail.Type

export const ValidatePolicyResponse = Schema.Union([
  Schema.TaggedStruct("Valid", { manifest: Manifest }),
  Schema.TaggedStruct("Invalid", { message: Schema.String }),
])
export type ValidatePolicyResponse = typeof ValidatePolicyResponse.Type

import { ResultAction } from "@janitor/domain/Labeling/Policy/Plan"

// RULES

export { ResultAction, describeResultAction } from "@janitor/domain/Labeling/Policy/Plan"

export const AiRuleDefinition = Schema.Struct({
  gatePolicyId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  target: PolicyTarget,
  prompt: Schema.String,
  minimumConfidence: Schema.Number,
})
export type AiRuleDefinition = typeof AiRuleDefinition.Type
export const RuleRecord = Schema.Struct({
  ai: Schema.optionalKey(Schema.NullOr(AiRuleDefinition)),
  id: Schema.String,
  repositoryId: Schema.String,
  labelId: Schema.String,
  policyId: Schema.String,
  onMatch: ResultAction,
  onNoMatch: ResultAction,
  group: Schema.NullOr(Schema.String),
  priority: Schema.Int,
  enabled: Schema.Boolean,
  labelStatus: Schema.Literals(["valid", "missing"]),
  version: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})
export type RuleRecord = typeof RuleRecord.Type

export const RuleIssue = Schema.Struct({ code: Schema.String, message: Schema.String })
export type RuleIssue = typeof RuleIssue.Type

// CONFIGURATION

export const SynchronizedLabel = Schema.Struct({
  color: Schema.optionalKey(Schema.NullOr(Schema.String)),
  labelId: Schema.String,
  name: Schema.String,
  availability: Schema.Literals(["available", "suspect", "unavailable"]),
})
export type SynchronizedLabel = typeof SynchronizedLabel.Type

export const SyncFreshness = Schema.Literals([
  "projected",
  "verified",
  "syncing",
  "stale",
  "blocked",
])

export const ConfigurationView = Schema.Struct({
  repositoryId: Schema.String,
  configuredRevision: Schema.Int,
  activeRevision: Schema.NullOr(Schema.Int),
  pendingTracks: Schema.Array(Schema.String),
  policies: Schema.Array(PolicyRecord),
  rules: Schema.Array(RuleRecord),
  labels: Schema.Array(SynchronizedLabel),
  labelFreshness: SyncFreshness,
})
export type ConfigurationView = typeof ConfigurationView.Type

// AI CONSENT

export const AiConsent = Schema.Struct({
  repositoryId: Schema.String,
  state: Schema.Literals(["enabled", "draining", "disabled"]),
  provider: Schema.String,
  model: Schema.String,
  activeLeases: Schema.Int,
  updatedAt: Schema.DateTimeUtc,
})
export type AiConsent = typeof AiConsent.Type

// EVALUATION

export const Outcome = Schema.Literals(["match", "no-match", "unknown", "not-applicable", "failed"])
export type Outcome = typeof Outcome.Type

export const NodeSegment = Schema.Union([
  Schema.TaggedStruct("Child", { index: Schema.Int }),
  Schema.TaggedStruct("Not", {}),
  Schema.TaggedStruct("Policy", { policyId: Schema.String, root: Schema.String }),
])

export const NodeTrace = Schema.Struct({
  location: Schema.Struct({ root: Schema.String, path: Schema.Array(NodeSegment) }),
  outcome: Schema.Literals(["match", "no-match", "unknown"]),
  reason: Schema.String,
})
export type NodeTrace = typeof NodeTrace.Type

export const Omission = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
  unit: Schema.Literals(["characters", "items"]),
})
export const InputFactReport = Schema.Struct({
  name: Schema.String,
  originalBytes: Schema.Int,
  suppliedBytes: Schema.Int,
  omission: Schema.NullOr(Omission),
})
export const AiInputReport = Schema.Struct({
  version: Schema.Int,
  budgetBytes: Schema.Int,
  originalBytes: Schema.Int,
  suppliedBytes: Schema.Int,
  status: Schema.Literals(["complete", "shortened", "rejected"]),
  facts: Schema.Array(InputFactReport),
})
export type AiInputReport = typeof AiInputReport.Type
export const AiInputDetails = Schema.Struct({
  system: Schema.String,
  text: Schema.String,
  facts: Schema.Array(Schema.Struct({ name: Schema.String, json: Schema.String })),
})
export type AiInputDetails = typeof AiInputDetails.Type
export const AiReasonCode = Schema.Literals([
  "input-too-large",
  "missing-evidence",
  "access-disabled",
  "provider-unavailable",
  "provider-failed",
  "budget-exhausted",
  "concurrent-timeout",
  "insufficient-evidence",
  "low-confidence",
])
export type AiReasonCode = typeof AiReasonCode.Type

export const Evaluation = Schema.Struct({
  inputReport: Schema.optionalKey(AiInputReport),
  reasonCode: Schema.optionalKey(AiReasonCode),
  confidence: Schema.optionalKey(Schema.Number),
  cached: Schema.optionalKey(Schema.Boolean),
  outcome: Outcome,
  reason: Schema.String,
  trace: Schema.Array(NodeTrace),
})
export type Evaluation = typeof Evaluation.Type

export const Plan = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      ruleId: Schema.String,
      outcome: Outcome,
      selected: Schema.Boolean,
      requestedAction: Schema.optionalKey(ResultAction),
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({
      labelId: Schema.String,
      action: Schema.Literals(["add", "remove"]),
      ruleId: Schema.String,
    }),
  ),
})
export type Plan = typeof Plan.Type

export const ReconciliationRecord = Schema.Struct({
  repositoryId: Schema.String,
  number: Schema.Int,
  snapshotGeneration: Schema.String,
  rulesRevision: Schema.Int,
  coveredSequence: Schema.String,
  fingerprint: Schema.String,
  createdAt: Schema.DateTimeUtc,
  outcome: Schema.NullOr(Schema.Literals(["evaluated", "superseded", "not-qualified", "failed"])),
  detail: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Plan),
  actions: Schema.Array(
    Schema.Struct({
      labelId: Schema.String,
      action: Schema.Literals(["add", "remove"]),
      ruleId: Schema.String,
      status: Schema.Literals(["planned", "applied", "failed"]),
      detail: Schema.NullOr(Schema.String),
    }),
  ),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
})
export type ReconciliationRecord = typeof ReconciliationRecord.Type

// TEST BENCH

export const TestSubject = Schema.Union([
  Schema.TaggedStruct("Draft", {
    source: ProgramSource,
    policyId: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("Policy", { policyId: Schema.String }),
  Schema.TaggedStruct("Configuration", {}),
])
export type TestSubject = typeof TestSubject.Type

export const TestEntity = Schema.Struct({
  number: Schema.Int,
  kind: Schema.Literals(["issue", "pull_request"]),
  title: Schema.String,
  authorLogin: Schema.String,
  baseRef: Schema.NullOr(Schema.String),
  draft: Schema.NullOr(Schema.Boolean),
  labels: Schema.Array(Schema.String),
  evaluation: Schema.NullOr(Evaluation),
  plan: Schema.NullOr(Plan),
})
export type TestEntity = typeof TestEntity.Type

export const TestCandidates = Schema.Union([
  Schema.TaggedStruct("Ready", { items: Schema.Array(TestEntity) }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
])
export type TestCandidates = typeof TestCandidates.Type

export const TestResponse = Schema.Union([
  Schema.TaggedStruct("Evaluated", { entities: Schema.Array(TestEntity) }),
  Schema.TaggedStruct("Rejected", { message: Schema.String }),
])
export type TestResponse = typeof TestResponse.Type

// DESCRIPTIONS

export const describeRevision = (view: ConfigurationView): string => {
  if (view.configuredRevision === 0) return "Nothing configured"
  if (view.activeRevision === view.configuredRevision) {
    return `Revision ${view.configuredRevision} active`
  }
  const waiting = view.pendingTracks.length === 0 ? "promotion" : view.pendingTracks.join(", ")
  return `Revision ${view.configuredRevision} waiting on ${waiting}`
}

export const labelName = (labels: ReadonlyArray<SynchronizedLabel>, labelId: string): string =>
  labels.find((label) => label.labelId === labelId)?.name ?? labelId

export const policyName = (policies: ReadonlyArray<PolicyRecord>, policyId: string): string =>
  policies.find((policy) => policy.policyId === policyId)?.name ?? policyId

/** One line per planned change, naming the label and the policy that decided it. */
export const describePlan = (
  plan: Plan,
  view: ConfigurationView,
  actions: ReadonlyArray<ReconciliationRecord["actions"][number]> = [],
): ReadonlyArray<string> =>
  plan.actions.map((action) => {
    const rule = view.rules.find((candidate) => candidate.id === action.ruleId)
    const via = rule === undefined ? action.ruleId : policyName(view.policies, rule.policyId)
    const status = actions.find((entry) => entry.labelId === action.labelId)
    const suffix =
      status === undefined || status.status === "planned"
        ? ""
        : status.status === "applied"
          ? " ✓"
          : ` ✗ ${status.detail ?? "failed"}`
    return `${action.action} ${labelName(view.labels, action.labelId)} (${via})${suffix}`
  })

export const describeLocation = (location: NodeTrace["location"]): string =>
  [
    location.root,
    ...location.path.map((segment) => {
      switch (segment._tag) {
        case "Child":
          return `#${segment.index + 1}`
        case "Not":
          return "not"
        case "Policy":
          return `policy ${segment.policyId} ${segment.root}`
      }
    }),
  ].join(" > ")

export const describeOutcome = (outcome: Outcome): string => {
  switch (outcome) {
    case "match":
      return "Match"
    case "no-match":
      return "No match"
    case "unknown":
      return "Unknown"
    case "failed":
      return "Evaluation failed"
    case "not-applicable":
      return "Not applicable"
  }
}

export const formatSource = (source: ProgramSource): string => format(source)

// Activity wire schemas use the web app’s Effect version.
export const ActivityCursor = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  generation: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ActivityCursor = typeof ActivityCursor.Type
export const ActivityAction = Schema.Struct({
  labelId: Schema.String,
  name: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  ruleId: Schema.String,
  action: Schema.Literals(["add", "remove"]),
  status: Schema.Literals(["planned", "applied", "failed"]),
  detail: Schema.NullOr(Schema.String),
})
export const ActivityEntry = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  title: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.Literals(["issue", "pull_request"])),
  createdAt: Schema.DateTimeUtc,
  outcome: Schema.NullOr(Schema.Literals(["evaluated", "superseded", "not-qualified", "failed"])),
  detail: Schema.NullOr(Schema.String),
  revision: Schema.Int,
  plan: Schema.NullOr(Plan),
  actions: Schema.Array(ActivityAction),
  evaluations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ ruleId: Schema.String, outcome: Schema.String, reason: Schema.String }),
    ),
  ),
})
export type ActivityEntry = typeof ActivityEntry.Type
export const ActivityPage = Schema.Struct({
  entries: Schema.Array(ActivityEntry),
  cursor: Schema.NullOr(ActivityCursor),
})
export type ActivityPage = typeof ActivityPage.Type
