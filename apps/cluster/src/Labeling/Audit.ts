import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type Actor,
  AuditEntry,
  AuditOperation,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Append-only audit of configuration changes (plan: "Audit"). Written in
 * the same transaction as the change it describes.
 */

export interface AuditWrite {
  readonly repositoryId: GitHubRepositoryDatabaseId
  readonly subject: AuditEntry["subject"]
  readonly actor: Actor
  readonly operation: typeof AuditOperation.Type
  readonly before: unknown
  readonly after: unknown
}

export const recordAudit = (sql: SqlClient.SqlClient, write: AuditWrite) =>
  Effect.gen(function* () {
    const auditId = crypto.randomUUID()
    const subjectKind = write.subject._tag === "Policy" ? "policy" : "rule"
    const subjectId =
      write.subject._tag === "Policy" ? write.subject.policyId : write.subject.ruleId
    yield* sql`
      INSERT INTO labeling_audit
        (audit_id, repository_id, subject_kind, subject_id, actor_issuer, actor_subject, operation, before, after)
      VALUES (${auditId}, ${write.repositoryId}, ${subjectKind}, ${subjectId},
              ${write.actor.issuer}, ${write.actor.subject}, ${write.operation},
              ${write.before === null ? null : JSON.stringify(write.before)}::jsonb,
              ${write.after === null ? null : JSON.stringify(write.after)}::jsonb)
    `
  })

const AuditRow = Schema.Struct({
  audit_id: Schema.String,
  repository_id: GitHubRepositoryDatabaseId,
  subject_kind: Schema.Literals(["policy", "rule"]),
  subject_id: Schema.String,
  actor_issuer: Schema.String,
  actor_subject: Schema.String,
  operation: AuditOperation,
  before: Schema.NullOr(Schema.Unknown),
  after: Schema.NullOr(Schema.Unknown),
  created_at: Schema.DateTimeUtcFromDate,
})

export const AUDIT_LIST_LIMIT = 100

export const listAudit = (sql: SqlClient.SqlClient, repositoryId: GitHubRepositoryDatabaseId) =>
  sql`
    SELECT audit_id, repository_id, subject_kind, subject_id, actor_issuer, actor_subject,
           operation, before, after, created_at
    FROM labeling_audit WHERE repository_id = ${repositoryId}
    ORDER BY created_at DESC LIMIT ${AUDIT_LIST_LIMIT}
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AuditRow))),
    Effect.map((rows) =>
      rows.map((row): AuditEntry => ({
        auditId: row.audit_id,
        repositoryId: row.repository_id,
        subject:
          row.subject_kind === "policy"
            ? { _tag: "Policy", policyId: PolicyId.make(row.subject_id) }
            : { _tag: "Rule", ruleId: RuleId.make(row.subject_id) },
        actor: { issuer: row.actor_issuer, subject: row.actor_subject },
        operation: row.operation,
        before: row.before,
        after: row.after,
        createdAt: row.created_at,
      })),
    ),
  )
