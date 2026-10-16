import * as Clock from "effect/Clock"
import { PersistenceError } from "effect/cluster/ClusterError"
import * as Entity from "effect/cluster/Entity"
import * as MessageStorage from "effect/cluster/MessageStorage"
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

/** Lets the event loop run, so real I/O such as a Postgres reply can land; the test clock stays put. */
const yieldToIo = TestClock.withLive(Effect.sleep(Duration.millis(1)))

/**
 * Whether the in-memory runner holds a message that is due but has no final
 * reply yet: one waiting for the runner to pick it up, or one whose handler
 * is still running. A message leaves that set only once its handler finished.
 * An entity's keep-alive stays unanswered for as long as it is held, so it
 * isn't work to wait for.
 */
const pendingWork = Effect.gen(function* () {
  const driver = yield* MessageStorage.MemoryDriver
  const now = yield* Clock.currentTimeMillis
  for (const envelope of driver.unprocessed) {
    if (envelope._tag !== "Request" || envelope.tag === Entity.KeepAliveRpc._tag) continue
    const deliverAt = driver.requests.get(envelope.requestId)?.deliverAt ?? null
    if (deliverAt === null || deliverAt <= now) return true
  }
  return false
})

/**
 * Waits until every due message has been handled, including the messages
 * those handlers sent on. The clock moves only while work remains, in small
 * steps, because the runner picks up stored messages on the clock.
 */
export const drain = Effect.gen(function* () {
  for (let step = 0; yield* pendingWork; step++) {
    if (step === 2_000) return yield* Effect.die(new Error("The cluster did not drain"))
    yield* yieldToIo
    yield* TestClock.adjust(Duration.millis(100))
  }
})

/** Runs a cluster call to completion, then drains what it set off. */
export const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    for (let step = 0; fiber.pollUnsafe() === undefined; step++) {
      if (step === 2_000) return yield* Effect.die(new Error("The cluster call did not complete"))
      yield* yieldToIo
      yield* TestClock.adjust(Duration.millis(100))
    }
    const result = yield* Fiber.join(fiber)
    yield* drain
    return result
  })

/**
 * Fails storing the next message with RPC tag `tag`, the way a crash between
 * a handler's state write and its send would lose it. The handler that sent
 * it fails, and the runner retries that handler's message.
 */
export const failNextSend = (tag: string) =>
  Effect.gen(function* () {
    const driver = yield* MessageStorage.MemoryDriver
    const encoded = driver.encoded as {
      -readonly [K in keyof typeof driver.encoded]: (typeof driver.encoded)[K]
    }
    const save = encoded.saveEnvelope
    encoded.saveEnvelope = (options) => {
      if (options.envelope._tag !== "Request" || options.envelope.tag !== tag) return save(options)
      encoded.saveEnvelope = save
      return Effect.fail(new PersistenceError({ cause: new Error(`Lost ${tag}`) }))
    }
  })
