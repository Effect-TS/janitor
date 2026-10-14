import { assert, layer } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { MigratedPostgresLayer, runScript } from "../support/Postgres.ts"

const Services = PullRequestReviewStore.layer.pipe(Layer.provideMerge(MigratedPostgresLayer))

layer(Services, { timeout: "2 minutes" })("PR review migration", (it) => {
  it.effect("applies on top of 0055 and leaves existing repositories without PR review", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* PullRequestReviewStore
      const fs = yield* FileSystem.FileSystem
      const directory = `${import.meta.dirname}/../../migrations`
      const files = (yield* fs.readDirectory(directory))
        .filter((file) => file.endsWith(".sql"))
        .sort()
      assert.isTrue(
        files.some((file) => file > "0056"),
        "the PR review migration follows 0055",
      )
      const repositoryId = GitHubRepositoryDatabaseId.make("9100")
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE SCHEMA pr_review_upgrade`
          yield* sql`SET LOCAL search_path TO pr_review_upgrade`
          for (const file of files.filter((file) => file < "0056")) {
            yield* runScript(sql, yield* fs.readFileString(`${directory}/${file}`))
          }
          yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1)`
          yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence) VALUES(${repositoryId},'77','test','example',TRUE,TRUE,'accessible',1)`

          for (const file of files.filter((file) => file >= "0056")) {
            yield* runScript(sql, yield* fs.readFileString(`${directory}/${file}`))
          }

          assert.isFalse(yield* store.isEnabled(repositoryId))
          const runId = RunId.make(crypto.randomUUID())
          yield* store.start({
            runId,
            repositoryId,
            number: 1,
            title: "First change",
            headSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            trigger: { _tag: "Automatic" },
            startedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 14)),
          })
          assert.deepStrictEqual(
            (yield* store.runs(repositoryId, { limit: 10, cursor: Option.none() })).runs.map(
              (run) => run.runId,
            ),
            [runId],
          )
        }),
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
