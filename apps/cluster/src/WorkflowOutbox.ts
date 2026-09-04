import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "./SqlErrors.ts"

export class WorkflowOutboxError extends Schema.TaggedError<WorkflowOutboxError>()(
  "@janitor/cluster/WorkflowOutbox/WorkflowOutboxError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface OutboxRequest {
  readonly workflowTag: string
  readonly executionKey: string
  readonly payload: unknown
  readonly dueAt?: Date | undefined
}

export const OutboxRow = Schema.Struct({
  workflow_tag: Schema.String,
  execution_key: Schema.String,
  payload: Schema.Unknown,
  attempts: Schema.Int,
})
export type OutboxRow = typeof OutboxRow.Type

export interface ClaimOptions {
  readonly leaseToken: string
  readonly leaseDuration: Duration.Duration
  readonly limit: number
  /** Restrict the claim to one request, for dispatch immediately after commit. */
  readonly only?: { readonly workflowTag: string; readonly executionKey: string } | undefined
}

export interface FencedReference {
  readonly workflowTag: string
  readonly executionKey: string
  readonly leaseToken: string
}

/**
 * SQL-backed request outbox for workflow submissions. Rows are claimed with
 * a bounded lease and a fencing token so concurrent dispatchers cannot both
 * complete one row, and a lost dispatcher lets the row become due again.
 */
export class WorkflowOutbox extends Context.Service<
  WorkflowOutbox,
  {
    /** Idempotent: an existing row for the same key is left untouched. Joins any ambient transaction. */
    readonly enqueue: (request: OutboxRequest) => Effect.Effect<void, WorkflowOutboxError>
    readonly claimDue: (
      options: ClaimOptions,
    ) => Effect.Effect<ReadonlyArray<OutboxRow>, WorkflowOutboxError>
    /** Returns false when the lease was lost or the row was already accepted. */
    readonly markAccepted: (
      reference: FencedReference,
    ) => Effect.Effect<boolean, WorkflowOutboxError>
    /** Releases the lease and moves the row's due time, if the lease is still held. */
    readonly release: (
      reference: FencedReference,
      retryAfter: Duration.Duration,
    ) => Effect.Effect<boolean, WorkflowOutboxError>
  }
>()("@janitor/cluster/WorkflowOutbox/WorkflowOutbox", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(OutboxRow))
    const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString)

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new WorkflowOutboxError({ operation, message: describeError(error) }),
        )

    const enqueue = Effect.fn("WorkflowOutbox.enqueue")(function* (request: OutboxRequest) {
      const payload = yield* encodeJson(request.payload).pipe(wrap("enqueue"))
      yield* sql`
        INSERT INTO workflow_outbox ${sql.insert({
          workflow_tag: request.workflowTag,
          execution_key: request.executionKey,
          payload,
          ...(request.dueAt === undefined ? {} : { due_at: request.dueAt }),
        })}
        ON CONFLICT (workflow_tag, execution_key) DO UPDATE
        SET due_at = LEAST(workflow_outbox.due_at, EXCLUDED.due_at)
        WHERE workflow_outbox.accepted_at IS NULL AND workflow_outbox.attempts = 0
      `.pipe(wrap("enqueue"))
    })

    const claimDue = Effect.fn("WorkflowOutbox.claimDue")(function* (options: ClaimOptions) {
      const seconds = Duration.toSeconds(options.leaseDuration)
      const onlyClause =
        options.only === undefined
          ? sql``
          : sql`AND workflow_tag = ${options.only.workflowTag} AND execution_key = ${options.only.executionKey}`
      return yield* sql`
        WITH due AS (
          SELECT workflow_tag, execution_key FROM workflow_outbox
          WHERE accepted_at IS NULL
            AND due_at <= CLOCK_TIMESTAMP()
            AND (lease_until IS NULL OR lease_until <= CLOCK_TIMESTAMP())
            ${onlyClause}
          ORDER BY due_at
          LIMIT ${options.limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE workflow_outbox AS o
        SET lease_token = ${options.leaseToken},
            lease_until = CLOCK_TIMESTAMP() + make_interval(secs => ${seconds}),
            attempts = o.attempts + 1
        FROM due
        WHERE o.workflow_tag = due.workflow_tag AND o.execution_key = due.execution_key
        RETURNING o.workflow_tag, o.execution_key, o.payload, o.attempts
      `.pipe(Effect.flatMap(decodeRows), wrap("claimDue"))
    })

    const markAccepted = Effect.fn("WorkflowOutbox.markAccepted")(function* (
      reference: FencedReference,
    ) {
      const rows = yield* sql`
        UPDATE workflow_outbox
        SET accepted_at = CLOCK_TIMESTAMP(), lease_token = NULL, lease_until = NULL
        WHERE workflow_tag = ${reference.workflowTag}
          AND execution_key = ${reference.executionKey}
          AND lease_token = ${reference.leaseToken}
          AND accepted_at IS NULL
        RETURNING execution_key
      `.pipe(wrap("markAccepted"))
      return rows.length === 1
    })

    const release = Effect.fn("WorkflowOutbox.release")(function* (
      reference: FencedReference,
      retryAfter: Duration.Duration,
    ) {
      const seconds = Duration.toSeconds(retryAfter)
      const rows = yield* sql`
        UPDATE workflow_outbox
        SET lease_token = NULL,
            lease_until = NULL,
            due_at = CLOCK_TIMESTAMP() + make_interval(secs => ${seconds})
        WHERE workflow_tag = ${reference.workflowTag}
          AND execution_key = ${reference.executionKey}
          AND lease_token = ${reference.leaseToken}
          AND accepted_at IS NULL
        RETURNING execution_key
      `.pipe(wrap("release"))
      return rows.length === 1
    })

    return { enqueue, claimDue, markAccepted, release }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
