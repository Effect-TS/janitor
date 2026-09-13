import * as Context from "effect/Context"
import * as Config from "effect/Config"
import * as Clock from "effect/Clock"
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
  permission: Schema.optionalKey(Schema.Literals(["read", "push", "pull_request"])),
  refresh: Schema.optionalKey(Schema.Boolean),
  publication: Schema.optionalKey(Schema.Boolean),
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
        pullRequestNumber?: number
        appId?: string
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
      const appId = yield* Config.String("JANITOR_GITHUB_APP_ID").pipe(Config.withDefault(""))
      const tokens = new Map<string, { token: Redacted.Redacted<string>; expiresAt: number }>()
      return {
        authorize: (request: typeof RepositoryRequest.Type) =>
          Effect.gen(function* () {
            const rows = yield* sql<{
              owner: string
              repo: string
              installation_id: string
              pr_number: string | null
            }>`
        SELECT r.owner, r.repo, r.installation_id, (SELECT t.pr_number FROM slack_thread t WHERE t.session_id=s.session_id) AS pr_number FROM agent_session s
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
            const identity = {
              owner: repository.owner,
              repo: repository.repo,
              ...(appId ? { appId } : {}),
              ...(repository.pr_number === null
                ? {}
                : { pullRequestNumber: Number(repository.pr_number) }),
            }
            if (!request.token) return identity
            const numericId = Number(request.repositoryId)
            if (!Number.isSafeInteger(numericId))
              return yield* new RepositoryAccessError({
                message: "Repository identity is out of range",
              })
            // PR creation must also read the private repository's head and base refs.
            const permissions =
              request.permission === "push"
                ? { contents: "write" }
                : request.permission === "pull_request"
                  ? { contents: "read", pull_requests: "write" }
                  : {
                      contents: "read",
                      ...(repository.pr_number === null ? {} : { pull_requests: "read" }),
                    }
            const key = JSON.stringify([repository.installation_id, numericId, permissions])
            const now = yield* Clock.currentTimeMillis
            // Readiness is checked even on cache hits. A denied Git/GitHub operation
            // requests refresh before retrying with the same publication identity.
            if (request.refresh) tokens.delete(key)
            for (const [identity, cached] of tokens)
              if (cached.expiresAt <= now + 60000) tokens.delete(identity)
            const cached = tokens.get(key)
            if (cached) return { ...identity, token: cached.token }
            const jwt = yield* auth.appJwt
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
                permissions,
              }),
              Effect.flatMap(http.execute),
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(
                HttpClientResponse.schemaBodyJson(
                  Schema.Struct({ token: Schema.String, expires_at: Schema.String }),
                ),
              ),
            )
            const expiresAt = Date.parse(response.expires_at)
            if (!Number.isFinite(expiresAt) || expiresAt <= now + 60000)
              return yield* new RepositoryAccessError({
                message: "Scoped credential expires too soon",
              })
            const token = Redacted.make(response.token)
            tokens.set(key, { token, expiresAt })
            return {
              ...identity,
              token,
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
