import { AiRuleDefinition } from "./AiRule.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "../../GitHub/Id.ts"
import { GitHubLabelAvailability } from "../../GitHub/ReadModel.ts"
import { SyncFreshness, SyncGeneration } from "../../GitHub/Sync.ts"
import { Manifest } from "./Compile.ts"
import { PolicyId } from "./Condition.ts"
import { FactTrack } from "./Facts.ts"
import { ResultAction, RuleBinding, RuleGroup, RuleId } from "./Plan.ts"
import { PolicyTarget, Program, ProgramSource } from "./Program.ts"

/**
 * Persisted records and API shapes (plan: "Configuration revision"). The
 * repository's labeling revision is the one fence: it advances when a
 * policy publishes or a rule changes, and each advance snapshots the
 * rules with the policy versions they bind, so a reconciliation
 * can reload exactly what was live.
 */

/** Monotonic per repository. Zero means nothing has been configured. */
export const LabelingRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  .pipe(Schema.brand("LabelingRevision"))
  .annotate({ identifier: "LabelingRevision" })
export type LabelingRevision = typeof LabelingRevision.Type

export const PolicyVersionId = Schema.String.check(Schema.isMinLength(1))
  .pipe(Schema.brand("PolicyVersionId"))
  .annotate({ identifier: "PolicyVersionId" })
export type PolicyVersionId = typeof PolicyVersionId.Type

/** Audit identity from Cloudflare Access: issuer plus subject, never email. */
export const Actor = Schema.Struct({
  issuer: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
}).annotate({ identifier: "Actor" })
export type Actor = typeof Actor.Type

export const PolicyName = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
).annotate({ identifier: "PolicyName" })
export const PolicyDescription = Schema.String.check(Schema.isMaxLength(1_000))

// POLICIES

export const PolicyRecord = Schema.Struct({
  policyId: PolicyId,
  repositoryId: GitHubRepositoryDatabaseId,
  name: PolicyName,
  target: PolicyTarget,
  description: PolicyDescription,
  /** Null until the first publish. */
  publishedVersionId: Schema.NullOr(PolicyVersionId),
  publishedRevision: Schema.NullOr(Schema.Int),
  /** Whether the saved program differs from the published version. */
  draftDiffers: Schema.optionalKey(Schema.Boolean),
  publishedEvaluator: Schema.optionalKey(Schema.Literals(["Conditions", "Classifier"])),
  /** Optimistic version of the policy row and its draft, advanced by every save. */
  version: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "PolicyRecord" })
export type PolicyRecord = typeof PolicyRecord.Type

export const PolicyVersionRecord = Schema.Struct({
  versionId: PolicyVersionId,
  policyId: PolicyId,
  revision: Schema.Int,
  contentHash: Schema.String,
  program: Program,
  manifest: Manifest,
  createdAt: Schema.DateTimeUtc,
}).annotate({ identifier: "PolicyVersionRecord" })
export type PolicyVersionRecord = typeof PolicyVersionRecord.Type

/** What the editor loads: the policy, its draft as written, and what is published. */
export const PolicyDetail = Schema.Struct({
  policy: PolicyRecord,
  draft: ProgramSource,
  /** True when the draft differs from the published program. */
  draftDiffers: Schema.Boolean,
  publishedSource: Schema.optionalKey(Schema.NullOr(ProgramSource)),
  published: Schema.NullOr(PolicyVersionRecord),
}).annotate({ identifier: "PolicyDetail" })
export type PolicyDetail = typeof PolicyDetail.Type

export const CreatePolicyRequest = Schema.Struct({
  name: PolicyName,
  description: PolicyDescription.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  source: ProgramSource,
}).annotate({ identifier: "CreatePolicyRequest" })
export type CreatePolicyRequest = typeof CreatePolicyRequest.Type

export const SavePolicyRequest = Schema.Struct({
  version: Schema.Int,
  name: Schema.optionalKey(PolicyName),
  description: Schema.optionalKey(PolicyDescription),
  source: Schema.optionalKey(ProgramSource),
}).annotate({ identifier: "SavePolicyRequest" })
export type SavePolicyRequest = typeof SavePolicyRequest.Type

export const PublishPolicyRequest = Schema.Struct({ version: Schema.Int }).annotate({
  identifier: "PublishPolicyRequest",
})

export const ValidatePolicyRequest = Schema.Struct({ source: ProgramSource }).annotate({
  identifier: "ValidatePolicyRequest",
})

export const ValidatePolicyResponse = Schema.Union([
  Schema.TaggedStruct("Valid", { manifest: Manifest }),
  Schema.TaggedStruct("Invalid", { message: Schema.String }),
]).annotate({ identifier: "ValidatePolicyResponse" })
export type ValidatePolicyResponse = typeof ValidatePolicyResponse.Type

// RULES

export const LabelStatus = Schema.Literals(["valid", "missing"]).annotate({
  identifier: "LabelStatus",
})

export const RuleRecord = Schema.Struct({
  ...RuleBinding.fields,
  ai: Schema.optionalKey(Schema.NullOr(AiRuleDefinition)),
  repositoryId: GitHubRepositoryDatabaseId,
  labelStatus: LabelStatus,
  version: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "RuleRecord" })
export type RuleRecord = typeof RuleRecord.Type

export const CreateRuleRequest = Schema.Struct({
  requestId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  ai: Schema.optionalKey(AiRuleDefinition),
  labelId: GitHubLabelDatabaseId,
  policyId: Schema.optionalKey(PolicyId),
  onMatch: RuleBinding.fields.onMatch,
  onNoMatch: ResultAction.pipe(Schema.withDecodingDefaultKey(Effect.succeed("no-action"))),
  group: Schema.NullOr(RuleGroup).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  priority: RuleBinding.fields.priority.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
}).annotate({ identifier: "CreateRuleRequest" })
export type CreateRuleRequest = typeof CreateRuleRequest.Type

export const PatchRuleRequest = Schema.Struct({
  ai: Schema.optionalKey(AiRuleDefinition),
  version: Schema.Int,
  labelId: Schema.optionalKey(GitHubLabelDatabaseId),
  policyId: Schema.optionalKey(PolicyId),
  onMatch: Schema.optionalKey(ResultAction),
  onNoMatch: Schema.optionalKey(ResultAction),
  group: Schema.optionalKey(Schema.NullOr(RuleGroup)),
  priority: Schema.optionalKey(RuleBinding.fields.priority),
  enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "PatchRuleRequest" })
export type PatchRuleRequest = typeof PatchRuleRequest.Type

export const ReorderGroupRequest = Schema.Struct({
  group: RuleGroup,
  /** Complete membership and observed versions detect concurrent edits and membership changes. */
  rules: Schema.Array(
    Schema.Struct({ id: RuleId, version: Schema.Int, priority: RuleBinding.fields.priority }),
  ).check(Schema.isMinLength(1)),
}).annotate({ identifier: "ReorderGroupRequest" })
export type ReorderGroupRequest = typeof ReorderGroupRequest.Type

export const RuleIssueCode = Schema.Literals([
  "unresolved-label",
  "unavailable-label",
  "duplicate-label",
  "duplicate-priority",
  "group-target-mismatch",
  "invalid-reorder",
  "policy-not-published",
  "policy-target-mismatch",
  "invalid-ai-rule",
]).annotate({ identifier: "RuleIssueCode" })
export type RuleIssueCode = typeof RuleIssueCode.Type

export const RuleIssue = Schema.Struct({ code: RuleIssueCode, message: Schema.String }).annotate({
  identifier: "RuleIssue",
})
export type RuleIssue = typeof RuleIssue.Type

// CONFIGURATION

/** One rule as snapshotted at a revision, bound to a published version. */
export const ConfiguredRule = Schema.Struct({
  ...RuleBinding.fields,
  /** Historical snapshots predate rule revisions in cache identities. */
  version: Schema.optionalKey(Schema.Int),
  policyVersionId: PolicyVersionId,
}).annotate({ identifier: "ConfiguredRule" })
export type ConfiguredRule = typeof ConfiguredRule.Type

/**
 * The track generations a revision asked synchronization to verify before
 * it may become active.
 */
export const Preparation = Schema.Record(Schema.String, SyncGeneration).annotate({
  identifier: "Preparation",
})
export type Preparation = typeof Preparation.Type

export const ConfigurationSnapshot = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  revision: LabelingRevision,
  rules: Schema.Array(ConfiguredRule),
  /** Every policy version the rules bind or reference, so evaluation needs no other read. */
  versions: Schema.Array(PolicyVersionRecord),
  requiredTracks: Schema.Array(FactTrack),
  preparation: Preparation,
  createdAt: Schema.DateTimeUtc,
}).annotate({ identifier: "ConfigurationSnapshot" })
export type ConfigurationSnapshot = typeof ConfigurationSnapshot.Type

/** A label as synchronization currently knows it. */
export const SynchronizedLabel = Schema.Struct({
  color: Schema.optionalKey(Schema.NullOr(Schema.String)),
  labelId: GitHubLabelDatabaseId,
  name: Schema.String,
  availability: GitHubLabelAvailability,
}).annotate({ identifier: "SynchronizedLabel" })
export type SynchronizedLabel = typeof SynchronizedLabel.Type

/** What the repository page loads. */
export const ConfigurationView = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  configuredRevision: LabelingRevision,
  activeRevision: Schema.NullOr(LabelingRevision),
  /** Tracks the configured revision is still waiting on. Empty once active. */
  pendingTracks: Schema.Array(FactTrack),
  policies: Schema.Array(PolicyRecord),
  rules: Schema.Array(RuleRecord),
  labels: Schema.Array(SynchronizedLabel),
  labelFreshness: SyncFreshness,
}).annotate({ identifier: "ConfigurationView" })
export type ConfigurationView = typeof ConfigurationView.Type

// AUDIT

export const AuditOperation = Schema.Literals(["create", "update", "publish", "delete"]).annotate({
  identifier: "AuditOperation",
})

export const AuditEntry = Schema.Struct({
  auditId: Schema.String,
  repositoryId: GitHubRepositoryDatabaseId,
  subject: Schema.Union([
    Schema.TaggedStruct("Policy", { policyId: PolicyId }),
    Schema.TaggedStruct("Rule", { ruleId: RuleId }),
  ]),
  actor: Actor,
  operation: AuditOperation,
  before: Schema.NullOr(Schema.Unknown),
  after: Schema.NullOr(Schema.Unknown),
  createdAt: Schema.DateTimeUtc,
}).annotate({ identifier: "AuditEntry" })
export type AuditEntry = typeof AuditEntry.Type

// AI CONSENT

/**
 * Repository consent for classifier evaluation (design: "AI evaluator").
 * `Draining` refuses new leases and becomes `Disabled` once every active
 * lease has finished or expired; a call that holds a lease cannot be recalled.
 */
export const AiConsentState = Schema.Literals(["enabled", "draining", "disabled"]).annotate({
  identifier: "AiConsentState",
})
export type AiConsentState = typeof AiConsentState.Type

export const AiConsent = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  state: AiConsentState,
  /** Provider and model the repository consented to; fixed per consent grant. */
  provider: Schema.String,
  model: Schema.String,
  activeLeases: Schema.Int,
  updatedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "AiConsent" })
export type AiConsent = typeof AiConsent.Type

export const SetAiConsentRequest = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "SetAiConsentRequest" })
