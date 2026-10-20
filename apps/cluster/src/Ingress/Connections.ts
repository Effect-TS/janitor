import { JanitorApi } from "@janitor/domain/Api"
import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { RepositoryConnections } from "../RepositoryConnections.ts"
import { CurrentAccessIdentity } from "./Middleware.ts"

const change = (
  repositoryId: GitHubRepositoryDatabaseId,
  action: "connect" | "disconnect" | "pause" | "resume",
) =>
  Effect.flatMap(CurrentAccessIdentity, (identity) =>
    RepositoryConnections.use((connections) => connections.change(repositoryId, action, identity)),
  )

/**
 * The repository connections page. `RepositoryConnections` fails with the
 * domain errors the endpoints declare, so the handlers only pick the acting
 * identity and call through. Only connecting and resuming ask GitHub, and
 * disconnecting passes every guard, so those refusals die where they can't
 * happen.
 */
export const ConnectionsGroupLayer = HttpApiBuilder.group(JanitorApi, "connections", (handlers) =>
  handlers
    .handle("listAvailable", () =>
      RepositoryConnections.use((connections) => connections.inventory),
    )
    .handle("refresh", () => RepositoryConnections.use((connections) => connections.refresh))
    .handle("startAuthorization", ({ payload }) =>
      Effect.gen(function* () {
        const identity = yield* CurrentAccessIdentity
        const url = yield* RepositoryConnections.use((connections) =>
          connections.github(payload.installationId, identity),
        )
        return { url }
      }),
    )
    .handle("completeAuthorization", ({ payload }) =>
      Effect.flatMap(CurrentAccessIdentity, (identity) =>
        RepositoryConnections.use((connections) => connections.returned(payload.state, identity)),
      ),
    )
    .handle("connect", ({ params }) => change(params.repositoryId, "connect"))
    .handle("disconnect", ({ params }) =>
      change(params.repositoryId, "disconnect").pipe(
        Effect.catchTag(["RepositoryBlocked", "RepositoryIdentityChanged"], Effect.die),
      ),
    )
    .handle("pause", ({ params }) =>
      change(params.repositoryId, "pause").pipe(
        Effect.catchTag("RepositoryIdentityChanged", Effect.die),
      ),
    )
    .handle("resume", ({ params }) => change(params.repositoryId, "resume")),
)
