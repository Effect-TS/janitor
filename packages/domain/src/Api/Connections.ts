import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import { AuthorizationExpired } from "../GitHub/Authorization.ts"
import { ConnectionInventory } from "../GitHub/Connection.ts"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import {
  RepositoryBlocked,
  RepositoryIdentityChanged,
  RepositoryNotFound,
} from "../GitHub/Repository.ts"

const params = { repositoryId: GitHubRepositoryDatabaseId }

/**
 * The repository connections page: what the GitHub App can reach, the round
 * trip through GitHub's installation settings, and each repository's
 * connection and pause.
 */
export class ConnectionsGroup extends HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.get("listAvailable", "/repository-connections/available", {
      success: ConnectionInventory,
    }),
  )
  .add(HttpApiEndpoint.post("refresh", "/repository-connections/refresh"))
  .add(
    HttpApiEndpoint.post("startAuthorization", "/repository-connections/github", {
      payload: Schema.Struct({ installationId: Schema.NullOr(Schema.String) }),
      success: Schema.Struct({ url: Schema.String }),
    }),
  )
  .add(
    HttpApiEndpoint.post("completeAuthorization", "/repository-connections/return", {
      payload: Schema.Struct({ state: Schema.String }),
      error: AuthorizationExpired,
    }),
  )
  .add(
    HttpApiEndpoint.put("connect", "/repositories/:repositoryId/connection", {
      params,
      error: [RepositoryNotFound, RepositoryBlocked, RepositoryIdentityChanged],
    }),
  )
  .add(
    HttpApiEndpoint.delete("disconnect", "/repositories/:repositoryId/connection", {
      params,
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("pause", "/repositories/:repositoryId/connection/pause", {
      params,
      error: [RepositoryNotFound, RepositoryBlocked],
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/repositories/:repositoryId/connection/resume", {
      params,
      error: [RepositoryNotFound, RepositoryBlocked, RepositoryIdentityChanged],
    }),
  ) {}
