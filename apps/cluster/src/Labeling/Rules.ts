import {
  aiRuleProgram,
  inspectAiRule,
  type AiRuleDefinition,
} from "@janitor/domain/Labeling/Policy/AiRule"
import { Program } from "@janitor/domain/Labeling/Policy/Program"
import { compile } from "@janitor/domain/Labeling/Policy/Compile"
import * as Encoding from "effect/Encoding"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
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
import { labelOwnershipConflict } from "./Ownership.ts"
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
  rule_id, repository_id, label_id, policy_id, on_match, on_no_match, rule_group, priority,
  enabled, label_status, version, created_at, updated_at, ai_definition
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
      ownerRuleId?: RuleId,
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
          AND (p.owner_rule_id IS NULL OR p.owner_rule_id = ${ownerRuleId ?? null})
      `.pipe(Effect.flatMap(decodePolicies), wrap("validate"))
      const policy = policies[0]
      if (policy === undefined || policy.published_version_id === null) {
        issues.push({
          code: "policy-not-published",
          message: `Policy ${policyId} is not published in this repository`,
        })
      }
      if (policy?.published_program) {
        const conflict = yield* labelOwnershipConflict(
          sql,
          repositoryId,
          labelId,
          policy.published_program.target,
          ownerRuleId,
        ).pipe(wrap("ownership"))
        if (conflict) issues.push({ code: "duplicate-label", message: conflict })
      }
      if (issues.length > 0) return yield* new RuleInvalid({ issues })
    })

    const invalidAi = (message: string) =>
      new RuleInvalid({ issues: [{ code: "invalid-ai-rule", message }] })
    const saveClassifier = (
      repositoryId: GitHubRepositoryDatabaseId,
      ruleId: RuleId,
      definition: AiRuleDefinition,
      existing?: PolicyId,
    ) =>
      Effect.gen(function* () {
        const inspected = inspectAiRule(definition)
        if (inspected.diagnostics.length)
          return yield* invalidAi(inspected.diagnostics.map((d) => d.message).join("; "))
        const program = aiRuleProgram(definition)
        const published = yield* sql`SELECT p.policy_id, v.program FROM labeling_policy p
          JOIN labeling_policy_version v ON v.version_id=p.published_version_id
          WHERE p.repository_id=${repositoryId} AND p.owner_rule_id IS NULL`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ policy_id: PolicyId, program: Program })),
            ),
          ),
          wrap("gate"),
        )
        const compiled = compile({
          program,
          resolve: (id) => published.find((p) => p.policy_id === id),
        })
        if (compiled._tag === "Rejected") return yield* invalidAi(compiled.issue.message)
        const encoded = JSON.stringify(program)
        const hash = Encoding.encodeHex(
          new Uint8Array(
            yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded)),
            ),
          ),
        )
        const policyId = existing ?? PolicyId.make(crypto.randomUUID())
        yield* Effect.gen(function* () {
          if (!existing) {
            yield* sql`INSERT INTO labeling_policy (policy_id,repository_id,name,target,description,version,owner_rule_id)
              VALUES (${policyId},${repositoryId},${"AI rule " + ruleId},${definition.target},'',1,${ruleId})`
            yield* sql`INSERT INTO labeling_policy_draft (policy_id,program) VALUES (${policyId},${encoded}::jsonb)`
          } else {
            yield* sql`UPDATE labeling_policy SET target=${definition.target},version=version+1,updated_at=CLOCK_TIMESTAMP() WHERE policy_id=${policyId} AND owner_rule_id=${ruleId}`
            yield* sql`UPDATE labeling_policy_draft SET program=${encoded}::jsonb,updated_at=CLOCK_TIMESTAMP() WHERE policy_id=${policyId}`
          }
          const versions = yield* sql<{
            version_id: string
          }>`SELECT version_id FROM labeling_policy_version WHERE policy_id=${policyId} AND content_hash=${hash}`
          const versionId = versions[0]?.version_id ?? crypto.randomUUID()
          if (!versions.length)
            yield* sql`INSERT INTO labeling_policy_version (version_id,policy_id,repository_id,revision,content_hash,program,manifest)
            VALUES (${versionId},${policyId},${repositoryId},(SELECT coalesce(max(revision),0)+1 FROM labeling_policy_version WHERE policy_id=${policyId}),${hash},${encoded}::jsonb,${JSON.stringify(compiled.manifest)}::jsonb)`
          for (const dependency of compiled.manifest.references) {
            yield* sql`INSERT INTO labeling_policy_dependency (version_id,dependency_policy_id) VALUES (${versionId},${dependency}) ON CONFLICT DO NOTHING`
          }
          yield* sql`UPDATE labeling_policy SET published_version_id=${versionId} WHERE policy_id=${policyId}`
        }).pipe(wrap("classifier"))
        return policyId
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
        if (request.requestId) {
          const prior = yield* sql<{
            rule_id: string
          }>`SELECT rule_id FROM labeling_rule WHERE repository_id=${repositoryId} AND creation_key=${request.requestId}`.pipe(
            wrap("idempotency"),
          )
          if (prior[0]) {
            const current = yield* find(repositoryId, RuleId.make(prior[0].rule_id))
            if (
              current.labelId !== request.labelId ||
              current.onMatch !== request.onMatch ||
              current.onNoMatch !== request.onNoMatch ||
              current.enabled !== request.enabled ||
              current.group !== request.group ||
              current.priority !== request.priority ||
              JSON.stringify(current.ai ?? null) !== JSON.stringify(request.ai ?? null) ||
              (!request.ai && current.policyId !== request.policyId)
            )
              return yield* new RuleConflict({ current })
            return current
          }
        }
        const ruleId = RuleId.make(crypto.randomUUID())
        if (request.ai && request.policyId)
          return yield* invalidAi("AI rules cannot bind a shared policy")
        const policyId = request.ai
          ? yield* saveClassifier(repositoryId, ruleId, request.ai)
          : request.policyId
        if (!policyId)
          return yield* invalidAi("Choose a published policy or supply an AI definition")
        yield* validate(repositoryId, request.labelId, policyId, ruleId)
        yield* Effect.gen(function* () {
          yield* sql`
              INSERT INTO labeling_rule
                (rule_id, repository_id, label_id, policy_id, on_match, on_no_match, rule_group, priority, enabled, version, ai_definition, creation_key)
              VALUES (${ruleId}, ${repositoryId}, ${request.labelId}, ${policyId},
                      ${request.onMatch}, ${request.onNoMatch}, ${request.group}, ${request.priority}, ${request.enabled}, 1, ${request.ai ? JSON.stringify(request.ai) : null}::jsonb, ${request.requestId ?? null})
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
        if (request.ai && !current.ai)
          return yield* invalidAi("Create a new AI rule instead of changing a policy rule's type")
        if (current.ai && request.policyId !== undefined && request.policyId !== current.policyId)
          return yield* invalidAi("AI rules must retain their owned classifier")
        const ai = request.ai ?? current.ai ?? null
        const aiPolicyId =
          request.ai && JSON.stringify(request.ai) !== JSON.stringify(current.ai)
            ? yield* saveClassifier(repositoryId, ruleId, request.ai, current.policyId)
            : current.policyId
        const next = {
          ai,
          labelId: request.labelId ?? current.labelId,
          policyId: current.ai ? aiPolicyId : (request.policyId ?? current.policyId),
          onMatch: request.onMatch ?? current.onMatch,
          onNoMatch: request.onNoMatch ?? current.onNoMatch,
          group: request.group === undefined ? current.group : request.group,
          priority: request.priority ?? current.priority,
          enabled: request.enabled ?? current.enabled,
        }
        yield* validate(repositoryId, next.labelId, next.policyId, ruleId)
        // A label that came back, or a new label, is valid again.
        const labelStatus = next.labelId === current.labelId ? current.labelStatus : "valid"
        yield* Effect.gen(function* () {
          yield* sql`
              UPDATE labeling_rule
              SET ai_definition = ${ai ? JSON.stringify(ai) : null}::jsonb, label_id = ${next.labelId}, policy_id = ${next.policyId}, on_match = ${next.onMatch}, on_no_match = ${next.onNoMatch},
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
