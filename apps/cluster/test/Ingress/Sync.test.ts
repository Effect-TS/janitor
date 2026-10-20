import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  RepositoryBlocked,
  RepositoryNotFound,
  SynchronizationDisabled,
} from "@janitor/domain/GitHub/Repository"
import type { SyncSummary } from "@janitor/domain/GitHub/Sync"
import { SyncGroupLayer } from "../../src/Ingress/Sync.ts"
import { SyncStatus } from "../../src/SyncStatus.ts"
import { makeClient } from "../support/Api.ts"

const summary: SyncSummary = {
  state: "idle",
  lastVerifiedAt: DateTime.makeUnsafe("2026-09-03T12:00:00.000Z"),
  pendingTargets: 0,
  blockedTargets: 0,
  failedTargets: 0,
}

const repositoryId = GitHubRepositoryDatabaseId.make("701")

const stub = (overrides: Partial<SyncStatus["Service"]> = {}): SyncStatus["Service"] => ({
  requestRepository: () => Effect.succeed({ summary, requested: 3 }),
  summary: Effect.succeed(summary),
  requestAll: Effect.succeed({
    summary: { ...summary, state: "syncing", pendingTargets: 4 },
    requested: 4,
  }),
  ...overrides,
})

const client = (status: SyncStatus["Service"]) =>
  makeClient(
    SyncGroupLayer,
    Context.make(SyncStatus, status).pipe(
      Context.add(WorkflowDispatcher, {
        dispatchDue: () => Effect.succeed({ claimed: 0, accepted: 0, released: 0 }),
      }),
    ),
  )

describe("sync", () => {
  it.effect("returns the summary", () =>
    Effect.gen(function* () {
      const api = yield* client(stub())
      assert.deepStrictEqual(yield* api.sync.getSummary(), summary)
    }),
  )

  it.effect("requests a sync of everything and answers with the new state", () =>
    Effect.gen(function* () {
      const api = yield* client(stub())
      const result = yield* api.sync.requestAll()
      assert.strictEqual(result.state, "syncing")
      assert.strictEqual(result.pendingTargets, 4)
    }),
  )

  it.effect("refuses a repository sync with the reason the repository can't sync", () =>
    Effect.gen(function* () {
      const refusals = [
        new RepositoryNotFound({ repositoryId }),
        new RepositoryBlocked({ repositoryId, reason: "paused" }),
        new SynchronizationDisabled(),
      ]
      for (const refusal of refusals) {
        const api = yield* client(stub({ requestRepository: () => Effect.fail(refusal) }))
        const error = yield* api.sync
          .requestRepository({ params: { repositoryId } })
          .pipe(Effect.flip)
        assert.deepStrictEqual(error, refusal)
      }
    }),
  )
})
