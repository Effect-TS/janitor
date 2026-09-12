import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubAppAuth } from "../GitHub/AppAuth.ts"
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "@janitor/domain/GitHub/Api"
import { AgentSessionId } from "./RunnerProtocol.ts"

export const RepositoryRequest = Schema.Struct({
  sessionId: AgentSessionId,
  generation: Schema.Int,
  repositoryId: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  token: Schema.Boolean,
})
export class RepositoryAccessError extends Schema.TaggedError<RepositoryAccessError>()(
  "RepositoryAccessError",
  {
    message: Schema.String,
  },
) {}

export class RepositoryAccess extends Context.Service<
  RepositoryAccess,
  {
    readonly authorize: (request: typeof RepositoryRequest.Type) => Effect.Effect<
      {
        owner: string
        repo: string
        token?: Redacted.Redacted<string>
      },
      RepositoryAccessError
    >
  }
>()("Agent/RepositoryAccess") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const auth = yield* GitHubAppAuth
      const http = yield* HttpClient.HttpClient
      return {
        authorize: (request: typeof RepositoryRequest.Type) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ owner: string; repo: string; installation_id: string }>`
        SELECT r.owner, r.repo, r.installation_id FROM agent_session s
        JOIN github_repository r ON r.repository_id = s.repository_id
        WHERE s.session_id = ${request.sessionId} AND s.generation = ${request.generation}
          AND s.repository_id = ${request.repositoryId} AND s.runner_state <> 'disconnected'
          AND r.connected AND r.sync_enabled AND r.automation_ready_at IS NOT NULL
          AND repository_access_available(r.repository_id)
          AND NOT EXISTS (SELECT 1 FROM sync_target t WHERE t.scope->>'repositoryId' = r.repository_id
            AND (t.last_error IS NOT NULL OR t.health = 'blocked'))
      `
            const repository = rows[0]
            if (!repository)
              return yield* new RepositoryAccessError({
                message: "Selected repository is not ready",
              })
            if (!request.token) return { owner: repository.owner, repo: repository.repo }
            const numericId = Number(request.repositoryId)
            if (!Number.isSafeInteger(numericId))
              return yield* new RepositoryAccessError({
                message: "Repository identity is out of range",
              })
            const jwt = yield* auth.appJwt
            // Mint per clone, with a single numeric repository and read-only Contents permission.
            // No installation-wide token or private key reaches the execution service.
            const response = yield* HttpClientRequest.post(
              `${GITHUB_API_BASE_URL}/app/installations/${repository.installation_id}/access_tokens`,
            ).pipe(
              HttpClientRequest.bearerToken(Redacted.value(jwt)),
              HttpClientRequest.setHeaders({
                accept: "application/vnd.github+json",
                "x-github-api-version": GITHUB_API_VERSION,
                "user-agent": GITHUB_USER_AGENT,
              }),
              HttpClientRequest.bodyJson({
                repository_ids: [numericId],
                permissions: { contents: "read" },
              }),
              Effect.flatMap(http.execute),
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(
                HttpClientResponse.schemaBodyJson(Schema.Struct({ token: Schema.String })),
              ),
            )
            return {
              owner: repository.owner,
              repo: repository.repo,
              token: Redacted.make(response.token),
            }
          }).pipe(
            Effect.mapError(
              () =>
                new RepositoryAccessError({
                  message: "Selected repository is not ready or scoped credentials are unavailable",
                }),
            ),
          ),
      }
    }),
  )
}
