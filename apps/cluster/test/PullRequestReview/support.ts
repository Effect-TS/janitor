import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"

/** The repository `FakeReviewGitHub` answers for: `effect/one` on installation 77. */
export const repositoryId = GitHubRepositoryDatabaseId.make("701")

/**
 * Connects, enables and turns PR review on for each repository, on
 * installation 77. The first is `effect/one`.
 */
export const seedRepositories = (...ids: ReadonlyArray<GitHubRepositoryDatabaseId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const store = yield* PullRequestReviewStore
    yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','effect','Organization','all','active','https://github.com/settings/installations/77',1) ON CONFLICT DO NOTHING`
    for (const [index, id] of ids.entries()) {
      const repo = index === 0 ? "one" : `repo-${id}`
      yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence) VALUES(${id},'77','effect',${repo},TRUE,TRUE,'accessible',1) ON CONFLICT DO NOTHING`
      yield* store.setEnabled(id, true)
    }
  })

/**
 * Runs a cluster call to completion. The in-memory runner's timers follow
 * the test clock, so the clock moves in small steps until the call is done,
 * and then a little more so messages it sent on are delivered.
 */
export const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    for (let step = 0; fiber.pollUnsafe() === undefined; step++) {
      if (step === 600) return yield* Effect.die(new Error("The cluster call did not complete"))
      yield* TestClock.adjust(Duration.millis(100))
    }
    const result = yield* Fiber.join(fiber)
    yield* TestClock.adjust(Duration.seconds(1))
    return result
  })
