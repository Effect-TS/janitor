import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { compile, CompileIssue } from "@janitor/domain/Labeling/Policy/Compile"
import { PolicyId, type PolicyNames } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type Actor,
  type CreatePolicyRequest,
  type PolicyDetail,
  type PolicyRecord,
  PolicyVersionId,
  type PolicyVersionRecord,
  type SavePolicyRequest,
  type ValidatePolicyResponse,
} from "@janitor/domain/Labeling/Policy/Configuration"
import {
  Program,
  programFromSource,
  type ProgramSource,
  programToSource,
  UnknownPolicyName,
} from "@janitor/domain/Labeling/Policy/Program"
import { validatePrompt } from "@janitor/domain/Labeling/Policy/Prompt"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"
import { recordAudit } from "./Audit.ts"
import {
  LabelingConfiguration,
  LabelingConfigurationError,
  policyColumns,
  PolicyRow,
  type RepositoryNotFound,
  toPolicyRecord,
  toVersionRecord,
  VersionRow,
  withRepositoryMutation,
} from "./Configuration.ts"

export class PoliciesError extends Data.TaggedError("PoliciesError")<{
  readonly operation: string
  readonly message: string
}> {}

export class PolicyNotFound extends Data.TaggedError("PolicyNotFound")<{
  readonly policyId: PolicyId
}> {}

/** The caller edited a version that is no longer current. */
export class PolicyConflict extends Data.TaggedError("PolicyConflict")<{
  readonly current: PolicyDetail
}> {}

export class PolicyInvalid extends Data.TaggedError("PolicyInvalid")<{
  readonly message: string
}> {}

export class PolicyNameTaken extends Data.TaggedError("PolicyNameTaken")<{
  readonly name: string
}> {}

/** Rules bind it or published programs reference it. */
export class PolicyInUse extends Data.TaggedError("PolicyInUse")<{
  readonly policyId: PolicyId
  readonly rules: number
  readonly references: number
}> {}

/** A resolver that also names the version, so callers can cache by it. */
export type VersionResolver = (policyId: PolicyId) => PolicyVersionRecord | undefined

export type PoliciesFailure =
  | RepositoryNotFound
  | PolicyNotFound
  | PolicyConflict
  | PolicyInvalid
  | PolicyNameTaken
  | PolicyInUse
  | PoliciesError
  | LabelingConfigurationError

const DraftRow = Schema.Struct({ program: Program })
const CountRow = Schema.Struct({ count: Schema.FiniteFromString })

const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  )

const newId = Effect.sync(() => crypto.randomUUID())

/**
 * Policies (plan: "Policies"). A policy has one draft and a series of
 * immutable, content-addressed published versions. Publishing compiles the
 * draft against the other published policies, then advances the
 * repository revision so rules bound to it re-evaluate.
 */
export class Policies extends Context.Service<
  Policies,
  {
    readonly list: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<PolicyRecord>, PoliciesFailure>
    readonly get: (
      repositoryId: GitHubRepositoryDatabaseId,
      policyId: PolicyId,
    ) => Effect.Effect<PolicyDetail, PoliciesFailure>
    readonly create: (
      repositoryId: GitHubRepositoryDatabaseId,
      request: CreatePolicyRequest,
      actor: Actor,
    ) => Effect.Effect<PolicyDetail, PoliciesFailure>
    readonly save: (
      repositoryId: GitHubRepositoryDatabaseId,
      policyId: PolicyId,
      request: SavePolicyRequest,
      actor: Actor,
    ) => Effect.Effect<PolicyDetail, PoliciesFailure>
    readonly publish: (
      repositoryId: GitHubRepositoryDatabaseId,
      policyId: PolicyId,
      version: number,
      actor: Actor,
    ) => Effect.Effect<PolicyDetail, PoliciesFailure>
    readonly validate: (
      repositoryId: GitHubRepositoryDatabaseId,
      source: ProgramSource,
      policyId: Option.Option<PolicyId>,
    ) => Effect.Effect<ValidatePolicyResponse, PoliciesFailure>
    readonly versions: (
      repositoryId: GitHubRepositoryDatabaseId,
      policyId: PolicyId,
    ) => Effect.Effect<ReadonlyArray<PolicyVersionRecord>, PoliciesFailure>
    readonly remove: (
      repositoryId: GitHubRepositoryDatabaseId,
      policyId: PolicyId,
      version: number,
      actor: Actor,
    ) => Effect.Effect<void, PoliciesFailure>
    /** Names for the authoring form, and a resolver over published versions. */
    readonly names: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<PolicyNames, PoliciesFailure>
    readonly resolver: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<VersionResolver, PoliciesFailure>
  }
>()("@janitor/cluster/Labeling/Policies/Policies", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const configuration = yield* LabelingConfiguration
    const decodePolicies = Schema.decodeUnknownEffect(Schema.Array(PolicyRow))
    const decodeVersions = Schema.decodeUnknownEffect(Schema.Array(VersionRow))
    const decodeDrafts = Schema.decodeUnknownEffect(Schema.Array(DraftRow))
    const decodeCounts = Schema.decodeUnknownEffect(Schema.Array(CountRow))
    const encodeProgram = Schema.encodeEffect(Schema.fromJsonString(Program))
    const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(VersionRow.fields.manifest))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new PoliciesError({ operation, message: describeError(error) }),
        )

    const listRows = (repositoryId: GitHubRepositoryDatabaseId) =>
      sql`
        SELECT ${policyColumns(sql)} FROM labeling_policy p
        LEFT JOIN labeling_policy_version v ON v.version_id = p.published_version_id
        WHERE p.repository_id = ${repositoryId} AND p.owner_rule_id IS NULL ORDER BY p.name
      `.pipe(Effect.flatMap(decodePolicies), wrap("list"))

    const findRow = (repositoryId: GitHubRepositoryDatabaseId, policyId: PolicyId) =>
      sql`
        SELECT ${policyColumns(sql)} FROM labeling_policy p
        LEFT JOIN labeling_policy_version v ON v.version_id = p.published_version_id
        WHERE p.repository_id = ${repositoryId} AND p.policy_id = ${policyId} AND p.owner_rule_id IS NULL
      `.pipe(
        Effect.flatMap(decodePolicies),
        wrap("find"),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(new PolicyNotFound({ policyId }))
            : Effect.succeed(toPolicyRecord(rows[0])),
        ),
      )

    const names = Effect.fn("Policies.names")(function* (repositoryId: GitHubRepositoryDatabaseId) {
      const rows = yield* listRows(repositoryId)
      const byName = new Map(rows.map((row) => [row.name.toLowerCase(), row.policy_id]))
      const byId = new Map(rows.map((row) => [row.policy_id, row.name]))
      const result: PolicyNames = {
        resolve: (name) => {
          const asId = PolicyId.make(name)
          return byName.get(name.toLowerCase()) ?? (byId.has(asId) ? asId : undefined)
        },
        format: (policyId) => byId.get(policyId) ?? policyId,
      }
      return result
    })

    /** Published versions of every policy in the repository, by policy id. */
    const resolver = Effect.fn("Policies.resolver")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const rows = yield* sql`
        SELECT v.version_id, v.policy_id, v.revision, v.content_hash, v.program, v.manifest, v.created_at
        FROM labeling_policy p
        JOIN labeling_policy_version v ON v.version_id = p.published_version_id
        WHERE p.repository_id = ${repositoryId}
      `.pipe(Effect.flatMap(decodeVersions), wrap("resolver"))
      const byPolicy = new Map(rows.map((row) => [row.policy_id, toVersionRecord(row)]))
      const resolve: VersionResolver = (policyId) => byPolicy.get(policyId)
      return resolve
    })

    const draftOf = (policyId: PolicyId) =>
      sql`SELECT program FROM labeling_policy_draft WHERE policy_id = ${policyId}`.pipe(
        Effect.flatMap(decodeDrafts),
        wrap("draft"),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(new PoliciesError({ operation: "draft", message: "draft row missing" }))
            : Effect.succeed(rows[0].program),
        ),
      )

    const publishedOf = (record: PolicyRecord) =>
      record.publishedVersionId === null
        ? Effect.succeed(null)
        : sql`
            SELECT version_id, policy_id, revision, content_hash, program, manifest, created_at
            FROM labeling_policy_version WHERE version_id = ${record.publishedVersionId}
          `.pipe(
            Effect.flatMap(decodeVersions),
            wrap("published"),
            Effect.map((rows) => (rows[0] === undefined ? null : toVersionRecord(rows[0]))),
          )

    const detail = Effect.fn("Policies.detail")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      policyId: PolicyId,
    ) {
      const policy = yield* findRow(repositoryId, policyId)
      const [draft, published, policyNames] = yield* Effect.all([
        draftOf(policyId),
        publishedOf(policy),
        names(repositoryId),
      ])
      const result: PolicyDetail = {
        policy,
        draft: programToSource(draft, policyNames),
        draftDiffers:
          published === null || JSON.stringify(published.program) !== JSON.stringify(draft),
        published,
        publishedSource:
          published === null ? null : programToSource(published.program, policyNames),
      }
      return result
    })

    const decodeSource = (repositoryId: GitHubRepositoryDatabaseId, source: ProgramSource) =>
      names(repositoryId).pipe(
        Effect.flatMap((policyNames) => {
          const program = programFromSource(source, policyNames)
          if (program instanceof UnknownPolicyName) {
            return Effect.fail(
              new PolicyInvalid({ message: `Policy '${program.name}' does not exist` }),
            )
          }
          if (program.evaluator._tag === "Classifier") {
            const prompt = validatePrompt(program.evaluator.prompt, program.evaluator.evidence)
            if (prompt._tag === "Invalid") {
              return Effect.fail(new PolicyInvalid({ message: prompt.message }))
            }
          }
          return Effect.succeed(program)
        }),
      )

    const compiled = Effect.fn("Policies.compile")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      program: Program,
      policyId: Option.Option<PolicyId>,
    ) {
      const resolve = yield* resolver(repositoryId)
      const result = compile({
        program,
        resolve,
        ...(Option.isSome(policyId) ? { policyId: policyId.value } : {}),
      })
      if (result._tag === "Rejected" || Option.isNone(policyId)) return result
      if (program.evaluator._tag === "Classifier") {
        const bindings =
          yield* sql`SELECT count(*)::text AS count FROM labeling_rule WHERE policy_id = ${policyId.value} AND on_no_match = 'ensure-absent'`.pipe(
            Effect.flatMap(decodeCounts),
            wrap("compile"),
          )
        if ((bindings[0]?.count ?? 0) > 0) {
          return yield* new PolicyInvalid({
            message:
              "Rules using this policy must preserve labels on no match before publishing a classifier",
          })
        }
      }
      // References follow the current published version. Check consumers too.
      for (const policy of yield* listRows(repositoryId)) {
        if (policy.policy_id === policyId.value) continue
        const published = resolve(policy.policy_id)
        if (published === undefined) continue
        const checked = compile({
          program: published.program,
          policyId: policy.policy_id,
          resolve: (id) => (id === policyId.value ? { program } : resolve(id)),
        })
        if (checked._tag === "Rejected") {
          return {
            _tag: "Rejected",
            issue: new CompileIssue({
              code: checked.issue.code,
              location: checked.issue.location,
              message: `Publishing would invalidate policy '${policy.name}': ${checked.issue.message}`,
            }),
          } as const
        }
      }
      return result
    })

    const validate = Effect.fn("Policies.validate")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      source: ProgramSource,
      policyId: Option.Option<PolicyId>,
    ) {
      yield* configuration.requireRepository(repositoryId)
      const program = yield* decodeSource(repositoryId, source).pipe(
        Effect.catchTag("PolicyInvalid", (error) => Effect.succeed(error)),
      )
      if (program instanceof PolicyInvalid) {
        return { _tag: "Invalid", message: program.message } as const
      }
      const result = yield* compiled(repositoryId, program, policyId).pipe(
        Effect.catchTag("PolicyInvalid", (error) => Effect.succeed(error)),
      )
      if (result instanceof PolicyInvalid)
        return { _tag: "Invalid", message: result.message } as const
      return result._tag === "Compiled"
        ? ({ _tag: "Valid", manifest: result.manifest } as const)
        : ({ _tag: "Invalid", message: result.issue.message } as const)
    })

    const list = Effect.fn("Policies.list")(function* (repositoryId: GitHubRepositoryDatabaseId) {
      yield* configuration.requireRepository(repositoryId)
      return (yield* listRows(repositoryId)).map(toPolicyRecord)
    })

    const get = Effect.fn("Policies.get")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      policyId: PolicyId,
    ) {
      yield* configuration.requireRepository(repositoryId)
      return yield* detail(repositoryId, policyId)
    })

    const nameTaken = (
      repositoryId: GitHubRepositoryDatabaseId,
      name: string,
      except: Option.Option<PolicyId>,
    ) =>
      sql`
        SELECT count(*)::text AS count FROM labeling_policy
        WHERE repository_id = ${repositoryId} AND lower(name) = ${name.toLowerCase()}
          AND (${Option.getOrNull(except)}::text IS NULL OR policy_id <> ${Option.getOrNull(except)})
      `.pipe(
        Effect.flatMap(decodeCounts),
        wrap("nameTaken"),
        Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
      )

    const create = Effect.fn("Policies.create")(
      function* (
        repositoryId: GitHubRepositoryDatabaseId,
        request: CreatePolicyRequest,
        actor: Actor,
      ) {
        yield* configuration.requireRepository(repositoryId)
        if (yield* nameTaken(repositoryId, request.name, Option.none())) {
          return yield* new PolicyNameTaken({ name: request.name })
        }
        const program = yield* decodeSource(repositoryId, request.source)
        const policyId = PolicyId.make(yield* newId)
        const encoded = yield* encodeProgram(program).pipe(wrap("create"))
        yield* Effect.gen(function* () {
          yield* sql`
              INSERT INTO labeling_policy (policy_id, repository_id, name, target, description, version)
              VALUES (${policyId}, ${repositoryId}, ${request.name}, ${program.target}, ${request.description}, 1)
            `
          yield* sql`
              INSERT INTO labeling_policy_draft (policy_id, program) VALUES (${policyId}, ${encoded}::jsonb)
            `
          yield* recordAudit(sql, {
            repositoryId,
            subject: { _tag: "Policy", policyId },
            actor,
            operation: "create",
            before: null,
            after: { name: request.name, description: request.description, program },
          })
        }).pipe(wrap("create"))
        return yield* detail(repositoryId, policyId)
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    const save = Effect.fn("Policies.save")(
      function* (
        repositoryId: GitHubRepositoryDatabaseId,
        policyId: PolicyId,
        request: SavePolicyRequest,
        actor: Actor,
      ) {
        yield* configuration.requireRepository(repositoryId)
        const current = yield* detail(repositoryId, policyId)
        if (current.policy.version !== request.version) {
          return yield* new PolicyConflict({ current })
        }
        const name = request.name ?? current.policy.name
        if (
          name !== current.policy.name &&
          (yield* nameTaken(repositoryId, name, Option.some(policyId)))
        ) {
          return yield* new PolicyNameTaken({ name })
        }
        const program =
          request.source === undefined
            ? yield* draftOf(policyId)
            : yield* decodeSource(repositoryId, request.source)
        const description = request.description ?? current.policy.description
        const encoded = yield* encodeProgram(program).pipe(wrap("save"))
        yield* Effect.gen(function* () {
          yield* sql`
              UPDATE labeling_policy
              SET name = ${name}, description = ${description}, target = ${program.target},
                  version = version + 1, updated_at = CLOCK_TIMESTAMP()
              WHERE policy_id = ${policyId} AND version = ${request.version}
            `
          yield* sql`
              UPDATE labeling_policy_draft SET program = ${encoded}::jsonb, updated_at = CLOCK_TIMESTAMP()
              WHERE policy_id = ${policyId}
            `
          yield* recordAudit(sql, {
            repositoryId,
            subject: { _tag: "Policy", policyId },
            actor,
            operation: "update",
            before: {
              name: current.policy.name,
              description: current.policy.description,
              draft: current.draft,
            },
            after: { name, description, program },
          })
        }).pipe(wrap("save"))
        return yield* detail(repositoryId, policyId)
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    const publish = Effect.fn("Policies.publish")(
      function* (
        repositoryId: GitHubRepositoryDatabaseId,
        policyId: PolicyId,
        version: number,
        actor: Actor,
      ) {
        yield* configuration.requireRepository(repositoryId)
        const current = yield* detail(repositoryId, policyId)
        if (current.policy.version !== version) return yield* new PolicyConflict({ current })
        const program = yield* draftOf(policyId)
        const result = yield* compiled(repositoryId, program, Option.some(policyId))
        if (result._tag === "Rejected")
          return yield* new PolicyInvalid({ message: result.issue.message })
        const contentHash = yield* sha256Hex(JSON.stringify(program))
        const encodedProgram = yield* encodeProgram(program).pipe(wrap("publish"))
        const encodedManifest = yield* encodeManifest(result.manifest).pipe(wrap("publish"))

        yield* Effect.gen(function* () {
          const existing = yield* sql`
              SELECT version_id, policy_id, revision, content_hash, program, manifest, created_at
              FROM labeling_policy_version WHERE policy_id = ${policyId} AND content_hash = ${contentHash}
            `.pipe(Effect.flatMap(decodeVersions))
          let versionId = existing[0]?.version_id
          if (versionId === undefined) {
            versionId = PolicyVersionId.make(yield* newId)
            yield* sql`
                INSERT INTO labeling_policy_version
                  (version_id, policy_id, repository_id, revision, content_hash, program, manifest)
                VALUES (${versionId}, ${policyId}, ${repositoryId},
                        (SELECT coalesce(max(revision), 0) + 1 FROM labeling_policy_version WHERE policy_id = ${policyId}),
                        ${contentHash}, ${encodedProgram}::jsonb, ${encodedManifest}::jsonb)
              `
            for (const dependency of result.manifest.references) {
              yield* sql`
                  INSERT INTO labeling_policy_dependency (version_id, dependency_policy_id)
                  VALUES (${versionId}, ${dependency})
                `
            }
          }
          yield* sql`
              UPDATE labeling_policy
              SET published_version_id = ${versionId}, version = version + 1, updated_at = CLOCK_TIMESTAMP()
              WHERE policy_id = ${policyId} AND version = ${version}
            `
          yield* recordAudit(sql, {
            repositoryId,
            subject: { _tag: "Policy", policyId },
            actor,
            operation: "publish",
            before: current.published === null ? null : { versionId: current.published.versionId },
            after: { versionId, contentHash, manifest: result.manifest },
          })
          yield* configuration.advance(repositoryId, actor)
        }).pipe(wrap("publish"))
        return yield* detail(repositoryId, policyId)
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    const versions = Effect.fn("Policies.versions")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      policyId: PolicyId,
    ) {
      yield* configuration.requireRepository(repositoryId)
      yield* findRow(repositoryId, policyId)
      const rows = yield* sql`
        SELECT version_id, policy_id, revision, content_hash, program, manifest, created_at
        FROM labeling_policy_version WHERE policy_id = ${policyId} ORDER BY revision DESC
      `.pipe(Effect.flatMap(decodeVersions), wrap("versions"))
      return rows.map(toVersionRecord)
    })

    const remove = Effect.fn("Policies.remove")(
      function* (
        repositoryId: GitHubRepositoryDatabaseId,
        policyId: PolicyId,
        version: number,
        actor: Actor,
      ) {
        yield* configuration.requireRepository(repositoryId)
        const current = yield* detail(repositoryId, policyId)
        if (current.policy.version !== version) return yield* new PolicyConflict({ current })
        const [rules, references] = yield* Effect.all([
          sql`SELECT count(*)::text AS count FROM labeling_rule WHERE policy_id = ${policyId}`.pipe(
            Effect.flatMap(decodeCounts),
          ),
          sql`
          SELECT count(*)::text AS count FROM labeling_policy_dependency d
          WHERE d.dependency_policy_id = ${policyId}
        `.pipe(Effect.flatMap(decodeCounts)),
        ]).pipe(wrap("remove"))
        const ruleCount = rules[0]?.count ?? 0
        const referenceCount = references[0]?.count ?? 0
        if (ruleCount > 0 || referenceCount > 0) {
          return yield* new PolicyInUse({ policyId, rules: ruleCount, references: referenceCount })
        }
        const history = yield* sql`
          SELECT count(*)::text AS count FROM labeling_configuration c
          JOIN labeling_policy_version v ON c.version_ids ? v.version_id
          WHERE c.repository_id = ${repositoryId} AND v.policy_id = ${policyId}
        `.pipe(Effect.flatMap(decodeCounts), wrap("remove"))
        if ((history[0]?.count ?? 0) > 0) {
          return yield* new PolicyInvalid({
            message:
              "This policy cannot be deleted because retained configuration history uses its published versions",
          })
        }
        yield* Effect.gen(function* () {
          yield* sql`UPDATE labeling_policy SET published_version_id = NULL WHERE policy_id = ${policyId}`
          yield* sql`DELETE FROM labeling_policy WHERE policy_id = ${policyId}`
          yield* recordAudit(sql, {
            repositoryId,
            subject: { _tag: "Policy", policyId },
            actor,
            operation: "delete",
            before: { name: current.policy.name, draft: current.draft },
            after: null,
          })
          if (current.published !== null) yield* configuration.advance(repositoryId, actor)
        }).pipe(wrap("remove"))
      },
      (effect, repositoryId) => withRepositoryMutation(sql, repositoryId, effect),
    )

    return {
      list,
      get,
      create,
      save,
      validate,
      versions,
      names,
      resolver,
      publish,
      remove,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
