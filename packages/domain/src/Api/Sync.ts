import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import {
  RepositoryBlocked,
  RepositoryNotFound,
  SynchronizationDisabled,
} from "../GitHub/Repository.ts"
import { SyncSummary } from "../GitHub/Sync.ts"

/** The re-sync button: the whole-system summary, and requests to sync everything or one repository. */
export class SyncGroup extends HttpApiGroup.make("sync")
  .add(HttpApiEndpoint.get("getSummary", "/sync", { success: SyncSummary }))
  .add(
    HttpApiEndpoint.post("requestAll", "/sync", {
      success: SyncSummary.pipe(HttpApiSchema.status(202)),
    }),
  )
  .add(
    HttpApiEndpoint.post("requestRepository", "/repositories/:repositoryId/sync", {
      params: { repositoryId: GitHubRepositoryDatabaseId },
      success: SyncSummary.pipe(HttpApiSchema.status(202)),
      error: [RepositoryNotFound, RepositoryBlocked, SynchronizationDisabled],
    }),
  ) {}
