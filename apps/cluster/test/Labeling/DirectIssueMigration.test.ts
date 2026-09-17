import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { LABEL_ISSUE_TAG } from "../../src/Labeling/IssueLabeling.ts"
import { RECONCILE_ENTITY_TAG } from "../../src/Labeling/SnapshotHandoff.ts"
import { installationId, repositoryId, seed, Services } from "./support.ts"

const migration = readFileSync(
  new URL("../../migrations/0039_direct_issue_labeling.sql", import.meta.url),
  "utf8",
)

layer(Services, { timeout: "2 minutes" })("Direct issue labeling cutover", (it) => {
  it.effect("retires pending legacy issue jobs and leaves pull request jobs alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE SCHEMA legacy_issues`
      yield* sql`CREATE TABLE legacy_issues.labeling_reconciliation (LIKE public.labeling_reconciliation INCLUDING ALL)`
      yield* sql`ALTER TABLE legacy_issues.labeling_reconciliation DROP COLUMN source`
      yield* sql`CREATE TABLE legacy_issues.workflow_outbox (LIKE public.workflow_outbox INCLUDING ALL)`
      yield* sql`CREATE TABLE legacy_issues.github_entity (LIKE public.github_entity INCLUDING ALL)`
      yield* sql`INSERT INTO legacy_issues.github_entity
        (repository_id, number, kind, title, author_login, state, github_updated_at, projected_sequence) VALUES
        ('701', 16, 'issue', 'Hello', 'octocat', 'open', CLOCK_TIMESTAMP(), 1),
        ('701', 17, 'issue', 'Hello', 'octocat', 'open', CLOCK_TIMESTAMP(), 1),
        ('701', 5, 'pull_request', 'Change', 'octocat', 'open', CLOCK_TIMESTAMP(), 1)`
      const fingerprint = "0".repeat(64)
      yield* sql`INSERT INTO legacy_issues.labeling_reconciliation
        (repository_id, number, snapshot_generation, rules_revision, covered_sequence, fingerprint, outcome) VALUES
        ('701', 16, 3, 2, 1, ${fingerprint}, NULL),
        ('701', 17, 4, 2, 1, ${fingerprint}, 'evaluated'),
        ('701', 5, 3, 2, 1, ${fingerprint}, NULL)`
      yield* sql`INSERT INTO legacy_issues.workflow_outbox (workflow_tag, execution_key, payload, accepted_at) VALUES
        (${RECONCILE_ENTITY_TAG}, 'reconcile:701:16:3:2', '{"repositoryId":"701","number":16,"snapshotGeneration":"3","rulesRevision":2}', NULL),
        (${RECONCILE_ENTITY_TAG}, 'reconcile:701:17:4:2', '{"repositoryId":"701","number":17,"snapshotGeneration":"4","rulesRevision":2}', CLOCK_TIMESTAMP()),
        (${RECONCILE_ENTITY_TAG}, 'reconcile:701:5:3:2', '{"repositoryId":"701","number":5,"snapshotGeneration":"3","rulesRevision":2}', NULL)`
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL search_path TO legacy_issues, public`
          yield* sql.unsafe(migration)
        }),
      )
      assert.deepStrictEqual(
        yield* sql`SELECT execution_key FROM legacy_issues.workflow_outbox ORDER BY execution_key`,
        [{ execution_key: "reconcile:701:17:4:2" }, { execution_key: "reconcile:701:5:3:2" }],
      )
      assert.deepStrictEqual(
        yield* sql`SELECT number, source, outcome, detail FROM legacy_issues.labeling_reconciliation ORDER BY number`,
        [
          { number: 5, source: "sync", outcome: null, detail: null },
          {
            number: 16,
            source: "sync",
            outcome: "superseded",
            detail: "Issue labeling moved to direct GitHub evaluation",
          },
          { number: 17, source: "sync", outcome: "evaluated", detail: null },
        ],
      )
    }),
  )

  it.effect("keeps direct issue work across cache-only changes but not across access loss", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed
      const enqueue = (key: string) =>
        sql`INSERT INTO workflow_outbox (workflow_tag, execution_key, payload) VALUES
          (${LABEL_ISSUE_TAG}, ${key}, ${JSON.stringify({ repositoryId, number: 16 })}::jsonb)`
      const pending = sql<{ execution_key: string }>`
        SELECT execution_key FROM workflow_outbox WHERE workflow_tag = ${LABEL_ISSUE_TAG}`
      yield* enqueue("label-issue:701:16:1:1")
      // Turning the installation's cache off is a synchronization event only.
      yield* sql`UPDATE github_installation SET sync_enabled = FALSE WHERE installation_id = ${installationId}`
      yield* sql`UPDATE github_installation SET sync_enabled = TRUE WHERE installation_id = ${installationId}`
      assert.strictEqual((yield* pending).length, 1)
      // Losing access fences everything pending.
      yield* sql`UPDATE github_repository SET access = 'lost' WHERE repository_id = ${repositoryId}`
      assert.strictEqual((yield* pending).length, 0)
      yield* sql`UPDATE github_repository SET access = 'accessible' WHERE repository_id = ${repositoryId}`
      yield* enqueue("label-issue:701:16:2:1")
      // So does a pause.
      yield* sql`UPDATE github_repository SET enabled = FALSE WHERE repository_id = ${repositoryId}`
      assert.strictEqual((yield* pending).length, 0)
    }),
  )
})
