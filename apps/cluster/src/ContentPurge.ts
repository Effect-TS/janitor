import type { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "./SqlErrors.ts"

export class ContentPurgeError extends Schema.TaggedError<ContentPurgeError>()(
  "@janitor/cluster/ContentPurge/ContentPurgeError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Grace period between losing access and deleting private content. A
 * reinstall or restored access inside the window cancels the purge.
 */
export const CONTENT_PURGE_GRACE = Duration.days(7)

export type PurgeSubject =
  | { readonly _tag: "installation"; readonly installationId: GitHubInstallationId }
  | { readonly _tag: "repository"; readonly repositoryId: GitHubRepositoryDatabaseId }

export interface PurgeSummary {
  readonly purged: number
}

const PurgeRow = Schema.Struct({
  subject_kind: Schema.Literals(["installation", "repository"]),
  subject_id: Schema.String,
})

const subjectId = (subject: PurgeSubject) =>
  subject._tag === "installation" ? subject.installationId : subject.repositoryId

/**
 * Deletes private content after uninstall or confirmed access loss while
 * keeping identifiers, digests, and audit rows. Raw payload ciphertext,
 * entity titles and bodies, and label names are the content; everything else
 * stays so a same-ID reinstall repairs cleanly.
 */
export class ContentPurge extends Context.Service<
  ContentPurge,
  {
    /** Joins the caller's transaction. Idempotent for a subject already scheduled. */
    readonly schedule: (
      subject: PurgeSubject,
      reason: string,
    ) => Effect.Effect<void, ContentPurgeError>
    /** Joins the caller's transaction. Removes a pending purge when access returns. */
    readonly cancel: (subject: PurgeSubject) => Effect.Effect<void, ContentPurgeError>
    readonly runDue: (now: DateTime.Utc) => Effect.Effect<PurgeSummary, ContentPurgeError>
  }
>()("@janitor/cluster/ContentPurge/ContentPurge", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(PurgeRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new ContentPurgeError({ operation, message: describeError(error) }),
        )

    const schedule = Effect.fn("ContentPurge.schedule")(function* (
      subject: PurgeSubject,
      reason: string,
    ) {
      const now = yield* DateTime.now
      yield* sql`
        INSERT INTO content_purge ${sql.insert({
          subject_kind: subject._tag,
          subject_id: subjectId(subject),
          reason,
          requested_at: DateTime.toDateUtc(now),
          due_at: DateTime.toDateUtc(DateTime.addDuration(now, CONTENT_PURGE_GRACE)),
        })}
        ON CONFLICT (subject_kind, subject_id) DO NOTHING
      `.pipe(wrap("schedule"))
    })

    const cancel = Effect.fn("ContentPurge.cancel")(function* (subject: PurgeSubject) {
      yield* sql`
        DELETE FROM content_purge
        WHERE subject_kind = ${subject._tag} AND subject_id = ${subjectId(subject)} AND completed_at IS NULL
      `.pipe(wrap("cancel"))
    })

    const purgeRepositories = (repositoryIds: ReadonlyArray<string>, now: Date) =>
      Effect.gen(function* () {
        if (repositoryIds.length === 0) return
        yield* sql`
          UPDATE github_entity SET title = '', body = NULL, observed_at = CLOCK_TIMESTAMP()
          WHERE repository_id IN ${sql.in(repositoryIds)}
        `
        yield* sql`
          UPDATE github_label SET name = '', color = NULL, observed_at = CLOCK_TIMESTAMP()
          WHERE repository_id IN ${sql.in(repositoryIds)}
        `
        yield* sql`
          UPDATE github_repository SET content_purged_at = ${now}
          WHERE repository_id IN ${sql.in(repositoryIds)}
        `
        yield* sql`DELETE FROM github_http_cache WHERE repository_id IN ${sql.in(repositoryIds)}`
        yield* sql`DELETE FROM labeling_rule_test WHERE repository_id IN ${sql.in(repositoryIds)}`
        yield* sql`DELETE FROM labeling_ai_decision WHERE repository_id IN ${sql.in(repositoryIds)}`
      })

    const runDue = Effect.fn("ContentPurge.runDue")(function* (now: DateTime.Utc) {
      const nowDate = DateTime.toDateUtc(now)
      const due = yield* sql`
        SELECT subject_kind, subject_id FROM content_purge
        WHERE completed_at IS NULL AND due_at <= ${nowDate}
        ORDER BY due_at
        LIMIT 50
      `.pipe(Effect.flatMap(decodeRows), wrap("runDue"))

      let purged = 0
      for (const row of due) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (row.subject_kind === "installation") {
                yield* sql`
                  UPDATE github_webhook_delivery
                  SET payload = ''::bytea, purged_at = ${nowDate}
                  WHERE installation_id = ${row.subject_id} AND purged_at IS NULL
                `
                yield* sql`
                  DELETE FROM github_http_cache WHERE scope_key = ${`installation:${row.subject_id}`}
                `
                const repositories = yield* sql<{ repository_id: string }>`
                  SELECT repository_id FROM github_repository WHERE installation_id = ${row.subject_id}
                `
                yield* purgeRepositories(
                  repositories.map((repository) => repository.repository_id),
                  nowDate,
                )
              } else {
                yield* purgeRepositories([row.subject_id], nowDate)
              }
              yield* sql`
                UPDATE content_purge SET completed_at = ${nowDate}
                WHERE subject_kind = ${row.subject_kind} AND subject_id = ${row.subject_id}
              `
            }),
          )
          .pipe(wrap("runDue"))
        purged++
      }
      return { purged }
    })

    return { schedule, cancel, runDue }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
