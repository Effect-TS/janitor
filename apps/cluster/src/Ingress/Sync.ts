import { JanitorApi } from "@janitor/domain/Api"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { WorkflowDispatcher } from "../WorkflowDispatcher.ts"
import { SyncStatus } from "../SyncStatus.ts"

/** Starts the requested work now; the cron picks it up anyway if this fails. */
const dispatchNow = Effect.gen(function* () {
  const dispatcher = yield* WorkflowDispatcher
  yield* dispatcher
    .dispatchDue()
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Immediate manual sync dispatch failed; cron will recover it", cause),
      ),
    )
})

export const SyncGroupLayer = HttpApiBuilder.group(JanitorApi, "sync", (handlers) =>
  handlers
    .handle("getSummary", () =>
      Effect.gen(function* () {
        const status = yield* SyncStatus
        return yield* status.summary.pipe(Effect.orDie)
      }),
    )
    .handle("requestAll", () =>
      Effect.gen(function* () {
        const status = yield* SyncStatus
        const result = yield* status.requestAll.pipe(Effect.orDie)
        yield* dispatchNow
        return result.summary
      }),
    )
    .handle("requestRepository", ({ params }) =>
      Effect.gen(function* () {
        const status = yield* SyncStatus
        const result = yield* status.requestRepository(params.repositoryId)
        yield* dispatchNow
        return result.summary
      }),
    ),
)
