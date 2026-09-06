import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type Actor,
  type AuditEntry,
  type CreateRuleRequest,
  type PatchRuleRequest,
  type RuleIssue,
  type RuleRecord,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"
import { listAudit, recordAudit } from "./Audit.ts"
import {
  LabelingConfiguration,
  LabelingConfigurationError,
  policyColumns,
  PolicyRow,
  type RepositoryNotFound,
  RuleRow,
  toRuleRecord,
  withRepositoryMutation,
} from "./Configuration.ts"

export class RulesError extends Data.TaggedError("RulesError")<{
  readonly operation: string
  readonly message: string
}> {}

export class RuleNotFound extends Data.TaggedError("RuleNotFound")<{
  readonly ruleId: RuleId
}> {}

export class RuleConflict extends Data.TaggedError("RuleConflict")<{
  readonly current: RuleRecord
}> {}

export class RuleInvalid extends Data.TaggedError("RuleInvalid")<{
  readonly issues: ReadonlyArray<RuleIssue>
}> {}

export type RulesFailure =
  | RepositoryNotFound
  | RuleNotFound
  | RuleConflict
  | RuleInvalid
  | RulesError
  | LabelingConfigurationError

const ruleColumns = (sql: SqlClient.SqlClient) => sql`
  rule_id, repository_id, label_id, policy_id, on_no_match, rule_group, priority,
  enabled, label_status, version, created_at, updated_at
`

/**
 * Rules (plan: "Rules"). A rule binds one synchronized label to one
 * published policy. Every write is audited and advances the repository
 * revision, so subsequent evaluations use the change without scheduling a backfill.
 */
export class LabelingRules extends Context.Service<
  LabelingRules,
  {
    readonly list: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<RuleRecord>, RulesFailure>
    readonly create: (
      repositoryId: GitHubRepositoryDatabaseId,
      request: CreateRuleRequest,
      actor: Actor,
    ) => Effect.Effect<RuleRecord, RulesFailure>
    readonly patch: (
      repositoryId: GitHubRepositoryDatabaseId,
      ruleId: RuleId,
      request: PatchRuleRequest,
      actor: Actor,
    ) => Effect.Effect<RuleRecord, RulesFailure>
    readonly remove: (
      repositoryId: GitHubRepositoryDatabaseId,
      ruleId: RuleId,
      version: number,
      actor: Actor,
    ) => Effect.Effect<void, RulesFailure>
    readonly audit: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<AuditEntry>, RulesFailure>
  }
>()("@janitor/cluster/Labeling/Rules/LabelingRules", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const configuration = yield* LabelingConfiguration
    const decodeRules = Schema.decodeUnknownEffect(Schema.Array(RuleRow))
    const decodePolicies = Schema.decodeUnknownEffect(Schema.Array(PolicyRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new RulesError({ operation, message: describeError(error) }),
        )

    const find = (repositoryId: GitHubRepositoryDatabaseId, ruleId: RuleId) =>
      sql`
        SELECT ${ruleColumns(sql)} FROM labeling_rule
        WHERE repository_id = ${repositoryId} AND rule_id = ${ruleId}
      `.pipe(
        Effect.flatMap(decodeRules),
        wrap("find"),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(new RuleNotFound({ ruleId }))
            : Effect.succeed(toRuleRecord(rows[0])),
        ),
      )

    /** The label must be synchronized and present; the policy must be published. */
    const validate = Effect.fn("LabelingRules.validate")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      labelId: RuleRecord["labelId"],
      policyId: PolicyId,
      onNoMatch: RuleRecord["onNoMatch"],
    ) {
      const issues: Array<RuleIssue> = []
      const { labels } = yield* configuration.labels(repositoryId)
      const label = labels.find((candidate) => candidate.labelId === labelId)
      if (label === undefined) {
        issues.push({
          code: "unresolved-label",
          message: `Label ${labelId} is not a synchronized label of this repository`,
        })
      } else if (label.availability === "unavailable") {
        issues.push({
          code: "unavailable-label",
          message: `Label ${label.name} was deleted on GitHub`,
        })
      }
      const policies = yield* sql`
        SELECT ${policyColumns(sql)} FROM labeling_policy p
        LEFT JOIN labeling_policy_version v ON v.version_id = p.published_version_id
        WHERE p.repository_id = ${repositoryId} AND p.policy_id = ${policyId}
      `.pipe(Effect.flatMap(decodePolicies), wrap("validate"))
      const policy = policies[0]
      if (policy === undefined || policy.published_version_id === null) {
        issues.push({
          code: "policy-not-published",
          message: `Policy ${policyId} is not published in this repository`,
        })
      } else if (onNoMatch === "ensure-absent") {
        // A classifier can only add: its misses are never conclusive.
        const published = yield* sql`
          SELECT program->'evaluator'->>'_tag' AS evaluator FROM labeling_policy_version
          WHERE version_id = ${policy.published_version_id}
        `.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ evaluator: Schema.String }))),
          ),
          wrap("validate"),
        )
        if (published[0]?.evaluator === "Classifier") {
          issues.push({
            code: "classifier-preserve-only",
            message:
              "A rule bound to a classifier must leave the label alone when it does not match",
          })
        }
      }
      if (issues.length > 0) return yield* new RuleInvalid({ issues })
    })

    const list = Effect.fn("LabelingRules.list")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* configuration.requireRepository(repositoryId)
      const rows = yield* sql`
        SELECT ${ruleColumns(sql)} FROM labeling_rule
        WHERE repository_id = ${repositoryId} ORDER BY created_at, rule_id
      `.pipe(Effect.flatMap(decodeRules), wrap("list"))
      return rows.map(toRuleRecord)
    })

    const create = Effect.fn("LabelingRules.create")(
      function* (
        repositoryId: GitHubRepositoryDatabaseId,
        request: CreateRuleRequest,
        actor: Actor,
      ) {
        yield* configuration.requireRepository(repositoryId)
        yield* validate(repositoryId, request.labelId, request.policyId, request.onNoMatch)
        const ruleId = RuleId.make(crypto.randomUUID())
        yield* Effect.gen(function* () {
          yield* sql`
              INSERT INTO labeling_rule
                (rule_id, repository_id, label_id, policy_id, on_no_match, rule_group, priority, enabled, version)
              VALUES (${ruleId}, ${repositoryId}, ${request.labelId}, ${request.policyId},
                      ${request.onNoMatch}, ${request.group}, ${request.priority}, ${request.enabled}, 1)
            `
          yield* recordAudit(sql, {
            repositoryId,
            subject: { _tag: "Rule", ruleId },
            actor,
            operation: "create",
            before: null,
            after: request,
          })
          yield* configuration.advance(repositoryId, actor)
        }).pipe(wrap("create"))
        return yield* find(repositoryId, ruleId)
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    const patch = Effect.fn("LabelingRules.patch")(
      function* (
        repositoryId: GitHubRepositoryDatabaseId,
        ruleId: RuleId,
        request: PatchRuleRequest,
        actor: Actor,
      ) {
        yield* configuration.requireRepository(repositoryId)
        const current = yield* find(repositoryId, ruleId)
        if (current.version !== request.version) return yield* new RuleConflict({ current })
        const next = {
          labelId: request.labelId ?? current.labelId,
          policyId: request.policyId ?? current.policyId,
          onNoMatch: request.onNoMatch ?? current.onNoMatch,
          group: request.group === undefined ? current.group : request.group,
          priority: request.priority ?? current.priority,
          enabled: request.enabled ?? current.enabled,
        }
        yield* validate(repositoryId, next.labelId, next.policyId, next.onNoMatch)
        // A label that came back, or a new label, is valid again.
        const labelStatus = next.labelId === current.labelId ? current.labelStatus : "valid"
        yield* Effect.gen(function* () {
          yield* sql`
              UPDATE labeling_rule
              SET label_id = ${next.labelId}, policy_id = ${next.policyId}, on_no_match = ${next.onNoMatch},
                  rule_group = ${next.group}, priority = ${next.priority}, enabled = ${next.enabled},
                  label_status = ${labelStatus}, version = version + 1, updated_at = CLOCK_TIMESTAMP()
              WHERE rule_id = ${ruleId} AND version = ${request.version}
            `
          yield* recordAudit(sql, {
            repositoryId,
            subject: { _tag: "Rule", ruleId },
            actor,
            operation: "update",
            before: current,
            after: next,
          })
          yield* configuration.advance(repositoryId, actor)
        }).pipe(wrap("patch"))
        return yield* find(repositoryId, ruleId)
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    const remove = Effect.fn("LabelingRules.remove")(
      function* (
        repositoryId: GitHubRepositoryDatabaseId,
        ruleId: RuleId,
        version: number,
        actor: Actor,
      ) {
        yield* configuration.requireRepository(repositoryId)
        const current = yield* find(repositoryId, ruleId)
        if (current.version !== version) return yield* new RuleConflict({ current })
        yield* Effect.gen(function* () {
          yield* sql`DELETE FROM labeling_rule WHERE rule_id = ${ruleId} AND version = ${version}`
          yield* recordAudit(sql, {
            repositoryId,
            subject: { _tag: "Rule", ruleId },
            actor,
            operation: "delete",
            before: current,
            after: null,
          })
          yield* configuration.advance(repositoryId, actor)
        }).pipe(wrap("remove"))
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    const audit = Effect.fn("LabelingRules.audit")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* configuration.requireRepository(repositoryId)
      return yield* listAudit(sql, repositoryId).pipe(wrap("audit"))
    })

    return {
      list,
      audit,
      create,
      patch,
      remove,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
