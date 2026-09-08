import type { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** A page commits atomically. Labels are replaced only for accepted observations. */
export const applyIssueBatch = (request: {
  repositoryId: GitHubRepositoryDatabaseId
  issues: ReadonlyArray<GitHubIssueApi>
  sequence: GitHubWebhookJournalSequence
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { repositoryId, sequence } = request
    const unique = new Map<number, GitHubIssueApi>()
    for (const issue of request.issues) {
      const previous = unique.get(issue.number)
      if (!previous || !DateTime.isLessThan(issue.updatedAt, previous.updatedAt))
        unique.set(issue.number, issue)
    }
    const issues = [...unique.values()].sort((a, b) => a.number - b.number)
    if (issues.length === 0) return [] as Array<number>
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const accepted = yield* sql<{ number: number }>`
      INSERT INTO github_entity ${sql.insert(
        issues.map((issue) => ({
          repository_id: repositoryId,
          number: issue.number,
          kind: issue.pullRequest === undefined ? "issue" : "pull_request",
          issue_id: issue.id,
          issue_node_id: issue.nodeId,
          title: issue.title,
          body: issue.body,
          author_login: issue.user?.login ?? "ghost",
          author_id: issue.user?.id ?? null,
          state: issue.state,
          github_updated_at: DateTime.toDateUtc(issue.updatedAt),
          projected_sequence: sequence,
        })),
      )}
      ON CONFLICT (repository_id, number) DO UPDATE SET
        kind=EXCLUDED.kind, issue_id=EXCLUDED.issue_id, issue_node_id=EXCLUDED.issue_node_id,
        title=EXCLUDED.title, body=EXCLUDED.body, author_login=EXCLUDED.author_login,
        author_id=COALESCE(EXCLUDED.author_id,github_entity.author_id), state=EXCLUDED.state,
        github_updated_at=EXCLUDED.github_updated_at, projected_sequence=EXCLUDED.projected_sequence,
        observed_at=CLOCK_TIMESTAMP()
      WHERE github_entity.github_updated_at < EXCLUDED.github_updated_at
        OR (github_entity.github_updated_at = EXCLUDED.github_updated_at AND github_entity.projected_sequence <= EXCLUDED.projected_sequence)
      RETURNING number`
        if (accepted.length === 0) return [] as Array<number>
        const numbers = new Set(accepted.map((row) => row.number))
        const applied = issues.filter((issue) => numbers.has(issue.number))
        const labels = new Map<string, GitHubIssueApi["labels"][number]>()
        for (const issue of applied) for (const label of issue.labels) labels.set(label.id, label)
        if (labels.size > 0)
          yield* sql`
      INSERT INTO github_label ${sql.insert(
        [...labels.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((label) => ({
            repository_id: repositoryId,
            label_id: label.id,
            node_id: label.nodeId,
            name: label.name,
            color: label.color ?? null,
            availability: "available",
            projected_sequence: sequence,
          })),
      )}
      ON CONFLICT (repository_id,label_id) DO UPDATE SET node_id=EXCLUDED.node_id,name=EXCLUDED.name,
        color=COALESCE(EXCLUDED.color,github_label.color),
        availability='available',projected_sequence=EXCLUDED.projected_sequence,observed_at=CLOCK_TIMESTAMP()
      WHERE github_label.projected_sequence <= EXCLUDED.projected_sequence`
        yield* sql`DELETE FROM github_entity_label WHERE repository_id=${repositoryId} AND number IN ${sql.in([...numbers])}`
        const associations = applied.flatMap((issue) =>
          [...new Set(issue.labels.map((label) => label.id))].map((labelId) => ({
            repository_id: repositoryId,
            number: issue.number,
            label_id: labelId,
          })),
        )
        if (associations.length > 0)
          yield* sql`INSERT INTO github_entity_label ${sql.insert(associations)} ON CONFLICT DO NOTHING`
        return [...numbers]
      }),
    )
  })
