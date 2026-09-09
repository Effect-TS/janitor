import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import {
  type ReconciliationIdentity,
  reconciliationKey,
} from "@janitor/domain/Labeling/Reconciliation"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubReadModel } from "../GitHub/ReadModel.ts"
import { describeError } from "../SqlErrors.ts"
import { freshnessOf } from "../SyncFreshness.ts"
import { SyncTargets } from "../SyncTargets.ts"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import { withRepositoryActivity } from "../RepositoryActivity.ts"

export const RECONCILE_ENTITY_TAG = "Janitor/ReconcileEntityV1"

/** Evaluation needs a fresher verification than configuration display. */
export const EVALUATION_MAX_AGE = Duration.hours(1)

export class SnapshotHandoffError extends Data.TaggedError("SnapshotHandoffError")<{
  readonly operation: string
  readonly message: string
}> {}

export interface HandoffRequest {
  readonly repositoryId: GitHubRepositoryDatabaseId
  readonly number: number
  /** The generation the refresh just verified. */
  readonly generation: SyncGeneration
  readonly sequence: GitHubWebhookJournalSequence
}

export type HandoffResult =
  | { readonly _tag: "Published"; readonly identity: ReconciliationIdentity }
  | {
      readonly _tag: "Skipped"
      readonly reason:
        | "no-active-revision"
        | "no-entity"
        | "not-verified"
        | "automation-not-eligible"
    }

const ConfiguredRow = Schema.Struct({
  configured_revision: Schema.NullOr(
    Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision)),
  ),
})

const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  )

/**
 * Publishes a qualified snapshot for one verified entity: the reconciliation
 * row and the reconcile workflow's outbox row in one transaction. Idempotent
 * on the identity, so a repeated activity attempt writes nothing new.
 */
export class SnapshotHandoff extends Context.Service<
  SnapshotHandoff,
  {
    readonly publish: (
      request: HandoffRequest,
    ) => Effect.Effect<HandoffResult, SnapshotHandoffError>
  }
>()("@janitor/cluster/Labeling/SnapshotHandoff/SnapshotHandoff", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const readModel = yield* GitHubReadModel
    const targets = yield* SyncTargets
    const outbox = yield* WorkflowOutbox
    const decodeConfigured = Schema.decodeUnknownEffect(Schema.Array(ConfiguredRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new SnapshotHandoffError({ operation, message: describeError(error) }),
        )

    const publish = Effect.fn("SnapshotHandoff.publish")(function* (request: HandoffRequest) {
      const { repositoryId, number } = request
      const configured = yield* sql`
        SELECT configured_revision::text FROM labeling_repository_rules WHERE repository_id = ${repositoryId}
      `.pipe(Effect.flatMap(decodeConfigured), wrap("configuredRevision"))
      const rulesRevision = configured[0]?.configured_revision ?? null
      if (rulesRevision === null) {
        return { _tag: "Skipped", reason: "no-active-revision" } as const
      }
      const entity = yield* readModel.getEntity(repositoryId, number).pipe(wrap("getEntity"))
      if (Option.isNone(entity)) {
        return { _tag: "Skipped", reason: "no-entity" } as const
      }
      const target = yield* targets
        .get({ _tag: "Entity", repositoryId, number })
        .pipe(wrap("getTarget"))
      const now = yield* DateTime.now
      const verified =
        Option.isSome(target) &&
        target.value.verifiedGeneration === request.generation &&
        freshnessOf(target, now, EVALUATION_MAX_AGE) === "verified"
      if (!verified) {
        return { _tag: "Skipped", reason: "not-verified" } as const
      }
      const [eligible] = yield* sql<{
        allowed: boolean
      }>`SELECT entity_automation_eligible(${repositoryId}, ${number}, ${request.generation}::bigint) AS allowed`.pipe(
        wrap("automationEligibility"),
      )
      if (!eligible?.allowed) return { _tag: "Skipped", reason: "automation-not-eligible" } as const

      // Only what concrete rules read, in a stable order.
      const { entity: record, pullRequest, labels } = entity.value
      const fingerprint = yield* sha256Hex(
        JSON.stringify({
          kind: record.kind,
          title: record.title,
          author: record.authorLogin.toLowerCase(),
          state: record.state,
          baseRef: Option.map(pullRequest, (pr) => pr.baseRef).pipe(Option.getOrNull),
          draft: Option.map(pullRequest, (pr) => pr.draft).pipe(Option.getOrNull),
          labels: labels.map((label) => label.labelId).sort(),
        }),
      )
      const identity: ReconciliationIdentity = {
        repositoryId,
        number,
        snapshotGeneration: request.generation,
        rulesRevision,
      }
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO labeling_reconciliation
                (repository_id, number, snapshot_generation, rules_revision, covered_sequence, fingerprint)
              VALUES (${repositoryId}, ${number}, ${request.generation}, ${rulesRevision},
                      ${request.sequence}, ${fingerprint})
              ON CONFLICT DO NOTHING
            `
            yield* outbox.enqueue({
              workflowTag: RECONCILE_ENTITY_TAG,
              executionKey: reconciliationKey(identity),
              payload: identity,
            })
          }),
        )
        .pipe(wrap("publish"))
      yield* Effect.logInfo("Published qualified snapshot").pipe(
        Effect.annotateLogs({
          repositoryId,
          number,
          snapshotGeneration: request.generation,
          rulesRevision,
        }),
      )
      return { _tag: "Published", identity } as const
    })

    return {
      publish: (request: HandoffRequest) =>
        withRepositoryActivity(sql, request.repositoryId, publish(request)).pipe(
          Effect.map(
            Option.getOrElse((): HandoffResult => ({
              _tag: "Skipped",
              reason: "automation-not-eligible",
            })),
          ),
          wrap("publish"),
        ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
