import type { GitHubPullRequestApi } from "@janitor/domain/GitHub/Api"
import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** PR IDs are not issue IDs. Bootstrap identity without inventing the latter. */
export const applyPullRequestBatch = (request: {
  repositoryId: GitHubRepositoryDatabaseId
  pulls: ReadonlyArray<GitHubPullRequestApi>
  sequence: GitHubWebhookJournalSequence
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { repositoryId, sequence } = request
    const unique = new Map<number, GitHubPullRequestApi>()
    for (const pull of request.pulls) {
      const previous = unique.get(pull.number)
      if (!previous || !DateTime.isLessThan(pull.updatedAt, previous.updatedAt))
        unique.set(pull.number, pull)
    }
    const pulls = [...unique.values()].sort((a, b) => a.number - b.number)
    if (pulls.length === 0) return [] as Array<number>
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const identities = pulls.filter((pull) => pull.title !== undefined)
        const created =
          identities.length > 0
            ? yield* sql<{ number: number }>`
      INSERT INTO github_entity ${sql.insert(
        identities.map((pull) => ({
          repository_id: repositoryId,
          number: pull.number,
          kind: "pull_request",
          issue_id: null,
          issue_node_id: null,
          title: pull.title!,
          body: pull.body ?? null,
          author_login: pull.user?.login ?? "ghost",
          author_id: pull.user?.id ?? null,
          state: pull.state,
          github_updated_at: DateTime.toDateUtc(pull.updatedAt),
          projected_sequence: sequence,
        })),
      )} ON CONFLICT(repository_id,number) DO NOTHING RETURNING number`
            : []
        const inserted = new Set(created.map((row) => row.number))
        const labels = new Map<string, NonNullable<GitHubPullRequestApi["labels"]>[number]>()
        const associations = identities
          .filter((pull) => inserted.has(pull.number))
          .flatMap((pull) => {
            for (const label of pull.labels ?? []) labels.set(label.id, label)
            return [...new Set((pull.labels ?? []).map((label) => label.id))].map((labelId) => ({
              repository_id: repositoryId,
              number: pull.number,
              label_id: labelId,
            }))
          })
        if (labels.size > 0)
          yield* sql`INSERT INTO github_label ${sql.insert([...labels.values()].sort((a, b) => a.id.localeCompare(b.id)).map((label) => ({ repository_id: repositoryId, label_id: label.id, node_id: label.nodeId, name: label.name, availability: "available", projected_sequence: sequence })))}
      ON CONFLICT(repository_id,label_id) DO UPDATE SET node_id=EXCLUDED.node_id,name=EXCLUDED.name,availability='available',projected_sequence=EXCLUDED.projected_sequence,observed_at=CLOCK_TIMESTAMP() WHERE github_label.projected_sequence <= EXCLUDED.projected_sequence`
        if (associations.length > 0)
          yield* sql`INSERT INTO github_entity_label ${sql.insert(associations)} ON CONFLICT DO NOTHING`
        const entities = yield* sql<{
          number: number
        }>`SELECT number FROM github_entity WHERE repository_id=${repositoryId} AND number IN ${sql.in(pulls.map((pull) => pull.number))}`
        const present = new Set(entities.map((row) => row.number))
        const accepted = pulls.filter((pull) => present.has(pull.number))
        if (accepted.length > 0)
          yield* sql`
      INSERT INTO github_pull_request ${sql.insert(
        accepted.map((pull) => ({
          repository_id: repositoryId,
          number: pull.number,
          pull_request_id: pull.id,
          pull_request_node_id: pull.nodeId,
          base_ref: pull.base.ref,
          draft: pull.draft,
          head_sha: pull.head.sha,
          merged: pull.merged ?? pull.mergedAt !== null,
          github_updated_at: DateTime.toDateUtc(pull.updatedAt),
          projected_sequence: sequence,
        })),
      )} ON CONFLICT(repository_id,number) DO UPDATE SET
        pull_request_id=EXCLUDED.pull_request_id,pull_request_node_id=EXCLUDED.pull_request_node_id,
        base_ref=EXCLUDED.base_ref,draft=EXCLUDED.draft,head_sha=EXCLUDED.head_sha,merged=EXCLUDED.merged,
        github_updated_at=EXCLUDED.github_updated_at,projected_sequence=EXCLUDED.projected_sequence
      WHERE (github_pull_request.github_updated_at IS NULL OR github_pull_request.github_updated_at < EXCLUDED.github_updated_at
        OR (github_pull_request.github_updated_at = EXCLUDED.github_updated_at AND github_pull_request.projected_sequence <= EXCLUDED.projected_sequence))
        AND EXISTS(SELECT 1 FROM github_entity e WHERE e.repository_id=EXCLUDED.repository_id AND e.number=EXCLUDED.number
          AND (e.github_updated_at < EXCLUDED.github_updated_at OR (e.github_updated_at=EXCLUDED.github_updated_at AND e.projected_sequence <= EXCLUDED.projected_sequence)))`
        return pulls.filter((pull) => !present.has(pull.number)).map((pull) => pull.number)
      }),
    )
  })
