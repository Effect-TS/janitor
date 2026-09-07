import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import { ActivityCursor, ActivityEntry, ActivityPage } from "@janitor/domain/Labeling/Activity"
import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { LabelingConfiguration } from "./Configuration.ts"

export const ACTIVITY_PAGE_SIZE = 50
const Row = Schema.Struct({
  ...ActivityEntry.fields,
  createdAt: Schema.DateTimeUtcFromDate,
  generation: Schema.String,
})
/** One bounded query; the cursor looks up the original timestamp without losing microseconds. */
export const activityPage = Effect.fn("Labeling.activityPage")(function* (
  repositoryId: GitHubRepositoryDatabaseId,
  query: { search: string; target: string; cursor: ActivityCursor | null },
) {
  yield* (yield* LabelingConfiguration).requireRepository(repositoryId)
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    WITH page AS MATERIALIZED (
      SELECT r.*, e.title, e.kind
      FROM labeling_reconciliation r
      LEFT JOIN github_entity e ON e.repository_id=r.repository_id AND e.number=r.number
    WHERE r.repository_id=${repositoryId}
      AND (${query.target}='all' OR e.kind=${query.target})
      AND (${query.search}='' OR strpos(lower(COALESCE(e.title,'')), lower(${query.search}))>0
        OR strpos(r.number::text, ${query.search.replace(/^#/, "")})>0)
      AND (${query.cursor === null} OR (r.created_at,r.number,r.snapshot_generation,r.rules_revision) < (
        SELECT created_at,number,snapshot_generation,rules_revision FROM labeling_reconciliation
        WHERE repository_id=${repositoryId} AND number=${query.cursor?.number ?? 0}
          AND snapshot_generation=${query.cursor?.generation ?? "0"}::bigint
          AND rules_revision=${query.cursor?.revision ?? 0}
      ))
    ORDER BY r.created_at DESC,r.number DESC,r.snapshot_generation DESC,r.rules_revision DESC
    LIMIT ${ACTIVITY_PAGE_SIZE + 1}
    )
    SELECT r.number::text || ':' || r.snapshot_generation::text || ':' || r.rules_revision::text AS id,
      r.number, r.title, r.kind, r.created_at AS "createdAt", r.outcome, r.detail,
      r.rules_revision::int AS revision, r.snapshot_generation::text AS generation, r.plan,
      COALESCE(a.actions, '[]'::jsonb) AS actions
    FROM page r
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('labelId', a.label_id, 'name', l.name, 'color', l.color,
        'ruleId', a.rule_id, 'action', a.action, 'status', a.status, 'detail', a.detail)
        ORDER BY a.label_id) AS actions
      FROM labeling_label_action a
      LEFT JOIN github_label l ON l.repository_id=a.repository_id AND l.label_id=a.label_id
      WHERE a.repository_id=r.repository_id AND a.number=r.number
        AND a.snapshot_generation=r.snapshot_generation AND a.rules_revision=r.rules_revision
    ) a ON true
    ORDER BY r.created_at DESC,r.number DESC,r.snapshot_generation DESC,r.rules_revision DESC
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))))
  const entries = rows.slice(0, ACTIVITY_PAGE_SIZE)
  const last = entries.at(-1)
  return {
    entries,
    cursor:
      rows.length > ACTIVITY_PAGE_SIZE && last
        ? { number: last.number, generation: last.generation, revision: last.revision }
        : null,
  } satisfies ActivityPage
})

export class ActivityReader extends Context.Service<
  ActivityReader,
  {
    readonly page: (
      repositoryId: GitHubRepositoryDatabaseId,
      query: { search: string; target: string; cursor: ActivityCursor | null },
    ) => Effect.Effect<ActivityPage, Effect.Error<ReturnType<typeof activityPage>>>
  }
>()("@janitor/Labeling/ActivityReader") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const configuration = yield* LabelingConfiguration
      return {
        page: (
          repositoryId: GitHubRepositoryDatabaseId,
          query: { search: string; target: string; cursor: ActivityCursor | null },
        ) =>
          activityPage(repositoryId, query).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(LabelingConfiguration, configuration),
          ),
      }
    }),
  )
}
