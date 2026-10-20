import type { RepositoryBlocked, RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import {
  aiRuleProgram,
  inspectAiRule,
  type AiRuleDefinition,
} from "@janitor/domain/Labeling/Policy/AiRule"
import { Program } from "@janitor/domain/Labeling/Policy/Program"
import { compile } from "@janitor/domain/Labeling/Policy/Compile"
import * as Hex from "effect/encoding/Hex"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type Actor,
  type AuditEntry,
  type CreateRuleRequest,
  GroupConflict,
  type PatchRuleRequest,
  type ReorderGroupRequest,
  RuleConflict,
  RuleInvalid,
  type RuleIssue,
  RuleNotFound,
  type RuleRecord,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import { listAudit, recordAudit } from "./Audit.ts"
import { groupIssues } from "./Groups.ts"
import { labelOwnershipConflict } from "./Ownership.ts"
import {
  LabelingConfiguration,
  policyColumns,
  PolicyRow,
  RuleRow,
  toRuleRecord,
  withRepositoryMutation,
} from "./Configuration.ts"

/** A create request with each omitted key's legacy default applied. */
export type NewRule = CreateRuleRequest &
  Required<Pick<CreateRuleRequest, "onMatch" | "onNoMatch" | "group" | "priority" | "enabled">>

const ruleColumns = (sql: SqlClient.SqlClient) => sql`
  rule_id, repository_id, label_id, policy_id, on_match, on_no_match, rule_group, priority,
  enabled, label_status, version, created_at, updated_at, ai_definition
`

/**
 * Rules (plan: "Rules"). A rule binds one synchronized label to one
 * published policy. Every write is audited and advances the repository
 * revision, so subsequent evaluations use the change without scheduling a backfill.
 * Each method fails with the domain errors a caller can act on; SQL, decode
 * and configuration failures die.
 */
export class LabelingRules extends Context.Service<
  LabelingRules,
  {
    readonly list: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<RuleRecord>, RepositoryNotFound>
    readonly create: (
      repositoryId: GitHubRepositoryDatabaseId,
      request: NewRule,
      actor: Actor,
    ) => Effect.Effect<
      RuleRecord,
      RepositoryNotFound | RepositoryBlocked | RuleConflict | RuleInvalid
    >
    readonly patch: (
      repositoryId: GitHubRepositoryDatabaseId,
      ruleId: RuleId,
      request: PatchRuleRequest,
      actor: Actor,
    ) => Effect.Effect<
      RuleRecord,
      RepositoryNotFound | RepositoryBlocked | RuleNotFound | RuleConflict | RuleInvalid
    >
    readonly reorder: (
      repositoryId: GitHubRepositoryDatabaseId,
      request: ReorderGroupRequest,
      actor: Actor,
    ) => Effect.Effect<
      ReadonlyArray<RuleRecord>,
      RepositoryNotFound | RepositoryBlocked | RuleInvalid | GroupConflict
    >
    readonly remove: (
      repositoryId: GitHubRepositoryDatabaseId,
      ruleId: RuleId,
      version: number,
      actor: Actor,
    ) => Effect.Effect<void, RepositoryNotFound | RepositoryBlocked | RuleNotFound | RuleConflict>
    readonly audit: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<AuditEntry>, RepositoryNotFound>
  }
>()("@janitor/cluster/Labeling/Rules/LabelingRules", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const configuration = yield* LabelingConfiguration
    const decodeRules = Schema.decodeUnknownEffect(Schema.Array(RuleRow))
    const decodePolicies = Schema.decodeUnknownEffect(Schema.Array(PolicyRow))

    /** Configuration infrastructure failures die; an unknown repository doesn't. */
    const requireRepository = (repositoryId: GitHubRepositoryDatabaseId) =>
      configuration
        .requireRepository(repositoryId)
        .pipe(Effect.catchTag("LabelingConfigurationError", Effect.die))

    const find = (repositoryId: GitHubRepositoryDatabaseId, ruleId: RuleId) =>
      sql`
        SELECT ${ruleColumns(sql)} FROM labeling_rule
        WHERE repository_id = ${repositoryId} AND rule_id = ${ruleId}
      `.pipe(
        Effect.flatMap(decodeRules),
        Effect.orDie,
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(new RuleNotFound({ ruleId }))
            : Effect.succeed(toRuleRecord(rows[0])),
        ),
      )

    /** A rule this transaction created or found by its creation key exists. */
    const findCreated = (repositoryId: GitHubRepositoryDatabaseId, ruleId: RuleId) =>
      find(repositoryId, ruleId).pipe(Effect.catchTag("RuleNotFound", Effect.die))

    /** The label must be synchronized and present; the policy must be published. */
    const validate = Effect.fn("LabelingRules.validate")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      labelId: RuleRecord["labelId"],
      policyId: PolicyId,
      group: string | null,
      priority: number,
      ownerRuleId?: RuleId,
    ) {
      const issues: Array<RuleIssue> = []
      const { labels } = yield* configuration.labels(repositoryId).pipe(Effect.orDie)
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
      `.pipe(Effect.flatMap(decodePolicies), Effect.orDie)
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
        ).pipe(Effect.orDie)
        if (conflict) issues.push({ code: "duplicate-label", message: conflict })
        issues.push(
          ...(yield* groupIssues(
            sql,
            repositoryId,
            group,
            policy.published_program.target,
            priority,
            ownerRuleId,
          ).pipe(Effect.orDie)),
        )
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
          Effect.orDie,
        )
        const compiled = compile({
          program,
          resolve: (id) => published.find((p) => p.policy_id === id),
        })
        if (compiled._tag === "Rejected") return yield* invalidAi(compiled.issue.message)
        const encoded = JSON.stringify(program)
        const hash = Hex.encode(
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
        }).pipe(Effect.orDie)
        return policyId
      })

    const list = Effect.fn("LabelingRules.list")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* requireRepository(repositoryId)
      const rows = yield* sql`
        SELECT ${ruleColumns(sql)} FROM labeling_rule
        WHERE repository_id = ${repositoryId} ORDER BY created_at, rule_id
      `.pipe(Effect.flatMap(decodeRules), Effect.orDie)
      return rows.map(toRuleRecord)
    })

    const create = Effect.fn("LabelingRules.create")(
      function* (repositoryId: GitHubRepositoryDatabaseId, request: NewRule, actor: Actor) {
        yield* requireRepository(repositoryId)
        if (request.requestId) {
          const prior = yield* sql<{
            rule_id: string
          }>`SELECT rule_id FROM labeling_rule WHERE repository_id=${repositoryId} AND creation_key=${request.requestId}`.pipe(
            Effect.orDie,
          )
          if (prior[0]) {
            const current = yield* findCreated(repositoryId, RuleId.make(prior[0].rule_id))
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
        yield* validate(
          repositoryId,
          request.labelId,
          policyId,
          request.group,
          request.priority,
          ruleId,
        )
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
        }).pipe(Effect.orDie)
        return yield* findCreated(repositoryId, ruleId)
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
        yield* requireRepository(repositoryId)
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
        yield* validate(
          repositoryId,
          next.labelId,
          next.policyId,
          next.group,
          next.priority,
          ruleId,
        )
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
        }).pipe(Effect.orDie)
        return yield* find(repositoryId, ruleId)
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    const reorder = Effect.fn("LabelingRules.reorder")(
      function* (
        repositoryId: GitHubRepositoryDatabaseId,
        request: ReorderGroupRequest,
        actor: Actor,
      ) {
        const members = (yield* list(repositoryId)).filter((rule) => rule.group === request.group)
        if (
          request.rules.length === 0 ||
          new Set(request.rules.map((rule) => rule.id)).size !== request.rules.length ||
          new Set(request.rules.map((rule) => rule.priority)).size !== request.rules.length
        )
          return yield* new RuleInvalid({
            issues: [
              {
                code: "invalid-reorder",
                message:
                  "Supply each group member once with a unique final priority, including disabled rules.",
              },
            ],
          })
        if (
          members.length !== request.rules.length ||
          members.some(
            (member) =>
              !request.rules.some(
                (rule) => rule.id === member.id && rule.version === member.version,
              ),
          )
        )
          return yield* new GroupConflict()
        yield* Effect.gen(function* () {
          for (const member of members) {
            const next = request.rules.find((rule) => rule.id === member.id)!
            yield* sql`UPDATE labeling_rule SET priority = ${next.priority}, version = version + 1,
              updated_at = CLOCK_TIMESTAMP() WHERE rule_id = ${member.id}`
            yield* recordAudit(sql, {
              repositoryId,
              subject: { _tag: "Rule", ruleId: member.id },
              actor,
              operation: "update",
              before: member,
              after: { ...member, priority: next.priority, version: member.version + 1 },
            })
          }
          yield* configuration.advance(repositoryId, actor)
        }).pipe(Effect.orDie)
        return (yield* list(repositoryId)).filter((rule) => rule.group === request.group)
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
        yield* requireRepository(repositoryId)
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
        }).pipe(Effect.orDie)
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    const audit = Effect.fn("LabelingRules.audit")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* requireRepository(repositoryId)
      return yield* listAudit(sql, repositoryId).pipe(Effect.orDie)
    })

    return {
      list,
      audit,
      create,
      patch,
      remove,
      reorder,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
