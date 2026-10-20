import { JanitorApi } from "@janitor/domain/Api"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { WorkflowDispatcher } from "../WorkflowDispatcher.ts"
import { type RequestAllResult, SyncStatus } from "../SyncStatus.ts"

/** Starts the requested work now; the cron picks it up anyway if this fails. */
const dispatchNow = WorkflowDispatcher.use((dispatcher) => dispatcher.dispatchDue()).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Immediate manual sync dispatch failed; cron will recover it", cause),
  ),
)

const dispatched = <E, R>(request: Effect.Effect<RequestAllResult, E, R>) =>
  request.pipe(
    Effect.tap(() => dispatchNow),
    Effect.map((result) => result.summary),
  )

export const SyncGroupLayer = HttpApiBuilder.group(JanitorApi, "sync", (handlers) =>
  handlers
    .handle("getSummary", () => SyncStatus.use((status) => status.summary))
    .handle("requestAll", () => dispatched(SyncStatus.use((status) => status.requestAll)))
    .handle("requestRepository", ({ params }) =>
      dispatched(SyncStatus.use((status) => status.requestRepository(params.repositoryId))),
    ),
)
