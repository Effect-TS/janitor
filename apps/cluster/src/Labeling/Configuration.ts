import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { GitHubRepositoryTrack } from "@janitor/domain/GitHub/Sync"
import {
  type Actor,
  ConfigurationSnapshot,
  type ConfigurationView,
  ConfiguredRule,
  LabelingRevision,
  PolicyRecord,
  PolicyVersionId,
  PolicyVersionRecord,
  Preparation,
  RuleRecord,
  type SynchronizedLabel,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { type FactTrack, FactTrack as FactTrackSchema } from "@janitor/domain/Labeling/Policy/Facts"
import { compile, Manifest } from "@janitor/domain/Labeling/Policy/Compile"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import { Program } from "@janitor/domain/Labeling/Policy/Program"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { isSqlError } from "effect/unstable/sql/SqlError"
import { GitHubReadModel } from "../GitHub/ReadModel.ts"
import { describeError } from "../SqlErrors.ts"
import { freshnessOf } from "../SyncFreshness.ts"
import { SyncTargets } from "../SyncTargets.ts"

/** Serialize configuration edits before reading versions or resolving references. */
export const withRepositoryMutation = <A, E, R>(
  sql: SqlClient.SqlClient,
  repositoryId: GitHubRepositoryDatabaseId,
  effect: Effect.Effect<A, E, R>,
) =>
  sql
    .withTransaction(
      sql`SELECT repository_id FROM github_repository WHERE repository_id = ${repositoryId} FOR NO KEY UPDATE`.pipe(
        Effect.andThen(effect),
      ),
    )
    .pipe(
      Effect.mapError((error) =>
        isSqlError(error)
          ? new LabelingConfigurationError({ operation: "mutation", message: describeError(error) })
          : error,
      ),
    )

/** Configuration display tolerates older label verification than evaluation will. */
export const LABEL_MAX_AGE = Duration.hours(24)

export class LabelingConfigurationError extends Data.TaggedError("LabelingConfigurationError")<{
  readonly operation: string
  readonly message: string
}> {}

export class RepositoryNotFound extends Data.TaggedError("RepositoryNotFound")<{
  readonly repositoryId: GitHubRepositoryDatabaseId
}> {}

const RevisionFromText = Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision))

// ROWS

export const PolicyRow = Schema.Struct({
  policy_id: PolicyId,
  repository_id: GitHubRepositoryDatabaseId,
  name: Schema.String,
  target: Schema.Literals(["issue", "pull_request"]),
  description: Schema.String,
  published_version_id: Schema.NullOr(PolicyVersionId),
  published_revision: Schema.NullOr(Schema.Int),
  draft_program: Schema.optionalKey(Program),
  published_program: Schema.optionalKey(Schema.NullOr(Program)),
  version: Schema.Int,
  created_at: Schema.DateTimeUtcFromDate,
  updated_at: Schema.DateTimeUtcFromDate,
})

export const toPolicyRecord = (row: typeof PolicyRow.Type): PolicyRecord => ({
  policyId: row.policy_id,
  repositoryId: row.repository_id,
  name: row.name,
  target: row.target,
  description: row.description,
  publishedVersionId: row.published_version_id,
  publishedRevision: row.published_revision,
  ...(row.draft_program === undefined
    ? {}
    : {
        draftDiffers:
          row.published_program == null ||
          JSON.stringify(row.draft_program) !== JSON.stringify(row.published_program),
      }),
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** Policies joined to their published revision number. */
export const policyColumns = (sql: SqlClient.SqlClient) => sql`
  p.policy_id, p.repository_id, p.name, p.target, p.description, p.published_version_id,
  v.revision AS published_revision, p.version, p.created_at, p.updated_at,
  (SELECT d.program FROM labeling_policy_draft d WHERE d.policy_id = p.policy_id) AS draft_program,
  v.program AS published_program
`

export const VersionRow = Schema.Struct({
  version_id: PolicyVersionId,
  policy_id: PolicyId,
  revision: Schema.Int,
  content_hash: Schema.String,
  program: Program,
  manifest: Manifest,
  created_at: Schema.DateTimeUtcFromDate,
})

export const toVersionRecord = (row: typeof VersionRow.Type): PolicyVersionRecord => ({
  versionId: row.version_id,
  policyId: row.policy_id,
  revision: row.revision,
  contentHash: row.content_hash,
  program: row.program,
  manifest: row.manifest,
  createdAt: row.created_at,
})

export const RuleRow = Schema.Struct({
  rule_id: RuleId,
  repository_id: GitHubRepositoryDatabaseId,
  label_id: RuleRecord.fields.labelId,
  policy_id: PolicyId,
  on_no_match: RuleRecord.fields.onNoMatch,
  rule_group: Schema.NullOr(Schema.String),
  priority: Schema.Int,
  enabled: Schema.Boolean,
  label_status: RuleRecord.fields.labelStatus,
  version: Schema.Int,
  created_at: Schema.DateTimeUtcFromDate,
  updated_at: Schema.DateTimeUtcFromDate,
})

export const toRuleRecord = (row: typeof RuleRow.Type): RuleRecord => ({
  id: row.rule_id,
  repositoryId: row.repository_id,
  labelId: row.label_id,
  policyId: row.policy_id,
  onNoMatch: row.on_no_match,
  group: row.rule_group,
  priority: row.priority,
  enabled: row.enabled,
  labelStatus: row.label_status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const ConfigurationRow = Schema.Struct({
  repository_id: GitHubRepositoryDatabaseId,
  revision: RevisionFromText,
  rules: Schema.Array(ConfiguredRule),
  version_ids: Schema.Array(PolicyVersionId),
  required_tracks: Schema.Array(FactTrackSchema),
  preparation: Preparation,
  created_at: Schema.DateTimeUtcFromDate,
})

const PointerRow = Schema.Struct({
  configured_revision: RevisionFromText,
  active_revision: Schema.NullOr(RevisionFromText),
})

const PendingTrackRow = Schema.Struct({ track: Schema.String })

const ZERO = LabelingRevision.make(0)

/** How many open pull requests one revision advance asks to refresh. */
export const ENTITY_INVALIDATION_LIMIT = 500

const isRepositoryTrack = (track: FactTrack): track is GitHubRepositoryTrack =>
  GitHubRepositoryTrack.literals.some((known) => known === track)

/**
 * The repository's labeling revision (plan: "Configuration revision").
 * `advance` runs inside the caller's transaction after a publish or a rule
 * change: it snapshots the enabled rules with the versions they bind,
 * pins every version those programs reference, records the preparation
 * request, and moves the configured pointer. `load` reads a snapshot back
 * by revision so a reconciliation evaluates exactly what was live.
 */
export class LabelingConfiguration extends Context.Service<
  LabelingConfiguration,
  {
    readonly requireRepository: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<void, RepositoryNotFound | LabelingConfigurationError>
    readonly labels: (repositoryId: GitHubRepositoryDatabaseId) => Effect.Effect<
      {
        readonly labels: ReadonlyArray<SynchronizedLabel>
        readonly freshness: ConfigurationView["labelFreshness"]
      },
      LabelingConfigurationError
    >
    readonly load: (
      repositoryId: GitHubRepositoryDatabaseId,
      revision: LabelingRevision,
    ) => Effect.Effect<Option.Option<ConfigurationSnapshot>, LabelingConfigurationError>
    readonly advance: (
      repositoryId: GitHubRepositoryDatabaseId,
      actor: Actor,
    ) => Effect.Effect<LabelingRevision, LabelingConfigurationError>
    readonly view: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ConfigurationView, RepositoryNotFound | LabelingConfigurationError>
  }
>()("@janitor/cluster/Labeling/Configuration/LabelingConfiguration", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const readModel = yield* GitHubReadModel
    const targets = yield* SyncTargets
    const decodeRules = Schema.decodeUnknownEffect(Schema.Array(RuleRow))
    const decodeVersions = Schema.decodeUnknownEffect(Schema.Array(VersionRow))
    const decodePolicies = Schema.decodeUnknownEffect(Schema.Array(PolicyRow))
    const decodeConfigurations = Schema.decodeUnknownEffect(Schema.Array(ConfigurationRow))
    const decodePointers = Schema.decodeUnknownEffect(Schema.Array(PointerRow))
    const decodePendingTracks = Schema.decodeUnknownEffect(Schema.Array(PendingTrackRow))
    const encodeRules = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ConfiguredRule)))
    const encodeVersionIds = Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(PolicyVersionId)),
    )
    const encodeTracks = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(FactTrackSchema)))
    const encodePreparation = Schema.encodeEffect(Schema.fromJsonString(Preparation))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new LabelingConfigurationError({ operation, message: describeError(error) }),
        )

    const requireRepository = Effect.fn("LabelingConfiguration.requireRepository")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const repository = yield* readModel.getRepository(repositoryId).pipe(wrap("getRepository"))
      if (Option.isNone(repository)) return yield* new RepositoryNotFound({ repositoryId })
    })

    const labels = Effect.fn("LabelingConfiguration.labels")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const records = yield* readModel.listLabels(repositoryId).pipe(wrap("listLabels"))
      const target = yield* targets
        .get({ _tag: "RepositoryTrack", repositoryId, track: "labels" })
        .pipe(wrap("labelsTarget"))
      const freshness = freshnessOf(target, yield* DateTime.now, LABEL_MAX_AGE)
      const synchronized: ReadonlyArray<SynchronizedLabel> = records.map((label) => ({
        labelId: label.labelId,
        name: label.name,
        availability: label.availability,
      }))
      return { labels: synchronized, freshness }
    })

    /** Published versions by id, following manifest references until closed. */
    const closeVersions = (initial: ReadonlyArray<PolicyVersionId>) =>
      Effect.gen(function* () {
        const found = new Map<PolicyVersionId, PolicyVersionRecord>()
        let pending = [...new Set(initial)]
        while (pending.length > 0) {
          const rows = yield* sql`
            SELECT version_id, policy_id, revision, content_hash, program, manifest, created_at
            FROM labeling_policy_version WHERE version_id IN ${sql.in(pending)}
          `.pipe(Effect.flatMap(decodeVersions))
          for (const row of rows) found.set(row.version_id, toVersionRecord(row))
          const referencedPolicies = [
            ...new Set(rows.flatMap((row) => row.manifest.references)),
          ] as Array<PolicyId>
          if (referencedPolicies.length === 0) break
          const published = yield* sql`
            SELECT published_version_id FROM labeling_policy
            WHERE policy_id IN ${sql.in(referencedPolicies)} AND published_version_id IS NOT NULL
          `.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ published_version_id: PolicyVersionId })),
              ),
            ),
          )
          pending = published.map((row) => row.published_version_id).filter((id) => !found.has(id))
        }
        return [...found.values()]
      })

    const load = Effect.fn("LabelingConfiguration.load")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      revision: LabelingRevision,
    ) {
      const rows = yield* sql`
        SELECT repository_id, revision::text, rules, version_ids, required_tracks, preparation, created_at
        FROM labeling_configuration WHERE repository_id = ${repositoryId} AND revision = ${revision}
      `.pipe(Effect.flatMap(decodeConfigurations), wrap("load"))
      const row = rows[0]
      if (row === undefined) return Option.none()
      const versions =
        row.version_ids.length === 0
          ? []
          : yield* sql`
              SELECT version_id, policy_id, revision, content_hash, program, manifest, created_at
              FROM labeling_policy_version WHERE version_id IN ${sql.in(row.version_ids)}
            `.pipe(
              Effect.flatMap(decodeVersions),
              Effect.map((found) => found.map(toVersionRecord)),
              wrap("load"),
            )
      const snapshot: ConfigurationSnapshot = {
        repositoryId,
        revision: row.revision,
        rules: row.rules,
        versions,
        requiredTracks: row.required_tracks,
        preparation: row.preparation,
        createdAt: row.created_at,
      }
      return Option.some(snapshot)
    })

    const advance = Effect.fn("LabelingConfiguration.advance")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      actor: Actor,
    ) {
      const pointer = yield* sql`
        SELECT configured_revision::text, active_revision::text FROM labeling_repository_rules
        WHERE repository_id = ${repositoryId} FOR UPDATE
      `.pipe(Effect.flatMap(decodePointers), wrap("advance"))
      const next = LabelingRevision.make((pointer[0]?.configured_revision ?? ZERO) + 1)

      // Enabled rules bound to a published policy. A rule whose policy is
      // unpublished or whose label is missing is not live.
      const bound = yield* sql`
        SELECT r.rule_id, r.repository_id, r.label_id, r.policy_id, r.on_no_match, r.rule_group,
               r.priority, r.enabled, r.label_status, r.version, r.created_at, r.updated_at,
               p.published_version_id
        FROM labeling_rule r
        JOIN labeling_policy p ON p.policy_id = r.policy_id
        WHERE r.repository_id = ${repositoryId} AND r.enabled AND r.label_status = 'valid'
          AND p.published_version_id IS NOT NULL
        ORDER BY r.created_at, r.rule_id
      `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ ...RuleRow.fields, published_version_id: PolicyVersionId }),
            ),
          ),
        ),
        wrap("advance"),
      )
      const rules: ReadonlyArray<ConfiguredRule> = bound.map((row) => ({
        id: row.rule_id,
        labelId: row.label_id,
        policyId: row.policy_id,
        onNoMatch: row.on_no_match,
        group: row.rule_group,
        priority: row.priority,
        enabled: true,
        policyVersionId: row.published_version_id,
      }))
      const versions = yield* closeVersions(rules.map((rule) => rule.policyVersionId)).pipe(
        wrap("advance"),
      )
      const byPolicy = new Map(versions.map((version) => [version.policyId, version]))
      const manifests = []
      for (const rule of rules) {
        const version = byPolicy.get(rule.policyId)
        if (version === undefined) continue
        const result = compile({
          program: version.program,
          policyId: version.policyId,
          resolve: (id) => byPolicy.get(id),
        })
        if (result._tag === "Rejected") {
          return yield* new LabelingConfigurationError({
            operation: "advance",
            message: result.issue.message,
          })
        }
        manifests.push(result.manifest)
      }
      const requiredTracks = [
        ...new Set(manifests.flatMap((manifest) => manifest.tracks)),
      ].sort() as Array<FactTrack>

      // The preparation request: one new generation per track the rules
      // need, recorded so promotion can wait for exactly those. Tracks
      // synchronization does not have yet are not waited for; their facts
      // evaluate as unknown until the track exists.
      const preparation: Record<string, string> = {}
      // Collection facts are fetched per entity, so a revision that reads
      // them asks every open pull request to refresh; they become available
      // as those refreshes verify, and evaluate unknown until then.
      if (requiredTracks.some((track) => !isRepositoryTrack(track))) {
        const open = yield* readModel
          .listOpenEntities(repositoryId, ENTITY_INVALIDATION_LIMIT)
          .pipe(wrap("advance"))
        for (const { entity, pullRequest } of open) {
          if (Option.isNone(pullRequest)) continue
          yield* targets
            .invalidate({
              scope: { _tag: "Entity", repositoryId, number: entity.number },
              sequence: Option.none(),
            })
            .pipe(wrap("advance"))
        }
      }
      for (const track of requiredTracks) {
        if (!isRepositoryTrack(track)) continue
        const { generation } = yield* targets
          .invalidate({
            scope: { _tag: "RepositoryTrack", repositoryId, track },
            sequence: Option.none(),
          })
          .pipe(wrap("advance"))
        preparation[track] = generation
      }

      const encoded = yield* Effect.all({
        rules: encodeRules(rules),
        versionIds: encodeVersionIds(versions.map((version) => version.versionId)),
        tracks: encodeTracks(requiredTracks),
        preparation: encodePreparation(preparation as Preparation),
      }).pipe(wrap("advance"))
      yield* sql`
        INSERT INTO labeling_configuration
          (repository_id, revision, rules, version_ids, required_tracks, preparation, actor_issuer, actor_subject)
        VALUES (${repositoryId}, ${next}, ${encoded.rules}::jsonb, ${encoded.versionIds}::jsonb,
                ${encoded.tracks}::jsonb, ${encoded.preparation}::jsonb, ${actor.issuer}, ${actor.subject})
      `.pipe(wrap("advance"))
      yield* sql`
        INSERT INTO labeling_repository_rules (repository_id, configured_revision)
        VALUES (${repositoryId}, ${next})
        ON CONFLICT (repository_id) DO UPDATE SET
          configured_revision = EXCLUDED.configured_revision,
          updated_at = CLOCK_TIMESTAMP()
      `.pipe(wrap("advance"))
      yield* Effect.logInfo("Advanced auto-labeling configuration").pipe(
        Effect.annotateLogs({ repositoryId, revision: next, rules: rules.length }),
      )
      return next
    })

    /** Tracks whose verified generation is still below what the revision recorded. */
    const pendingTracks = (repositoryId: GitHubRepositoryDatabaseId, preparation: Preparation) => {
      const needed = Object.entries(preparation)
      if (needed.length === 0) return Effect.succeed<ReadonlyArray<FactTrack>>([])
      return Effect.forEach(needed, ([track, generation]) =>
        sql`
          SELECT ${track} AS track FROM (SELECT 1) AS one
          WHERE NOT EXISTS (
            SELECT 1 FROM sync_target
            WHERE scope_key = ${`repository:${repositoryId}:${track}`}
              AND health = 'ok' AND verified_generation >= ${generation}::bigint
          )
        `.pipe(Effect.flatMap(decodePendingTracks)),
      ).pipe(
        Effect.map((rows) => rows.flat().map((row) => row.track as FactTrack)),
        wrap("pendingTracks"),
      )
    }

    const view = Effect.fn("LabelingConfiguration.view")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* requireRepository(repositoryId)
      const [pointer, policies, rules, synchronized] = yield* Effect.all(
        [
          sql`
            SELECT configured_revision::text, active_revision::text FROM labeling_repository_rules
            WHERE repository_id = ${repositoryId}
          `.pipe(Effect.flatMap(decodePointers), wrap("view")),
          sql`
            SELECT ${policyColumns(sql)} FROM labeling_policy p
            LEFT JOIN labeling_policy_version v ON v.version_id = p.published_version_id
            WHERE p.repository_id = ${repositoryId} ORDER BY p.name
          `.pipe(Effect.flatMap(decodePolicies), wrap("view")),
          sql`
            SELECT rule_id, repository_id, label_id, policy_id, on_no_match, rule_group, priority,
                   enabled, label_status, version, created_at, updated_at
            FROM labeling_rule WHERE repository_id = ${repositoryId} ORDER BY created_at, rule_id
          `.pipe(Effect.flatMap(decodeRules), wrap("view")),
          labels(repositoryId),
        ],
        { concurrency: 4 },
      )
      const configuredRevision = pointer[0]?.configured_revision ?? ZERO
      const activeRevision = pointer[0]?.active_revision ?? null
      const pending =
        configuredRevision === ZERO || activeRevision === configuredRevision
          ? []
          : yield* sql`
              SELECT preparation FROM labeling_configuration
              WHERE repository_id = ${repositoryId} AND revision = ${configuredRevision}
            `.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ preparation: Preparation })),
                ),
              ),
              wrap("view"),
              Effect.flatMap((rows) => pendingTracks(repositoryId, rows[0]?.preparation ?? {})),
            )
      const result: ConfigurationView = {
        repositoryId,
        configuredRevision,
        activeRevision,
        pendingTracks: pending,
        policies: policies.map(toPolicyRecord),
        rules: rules.map(toRuleRecord),
        labels: synchronized.labels,
        labelFreshness: synchronized.freshness,
      }
      return result
    })

    return { requireRepository, labels, load, advance, view }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
