import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RepositoryAccess } from "../../src/Agent/RepositoryAccess.ts"
import { GitHubAppAuth } from "../../src/GitHub/AppAuth.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

let rejectCredential = false
const requests: unknown[] = []
const service = RepositoryAccess.layer.pipe(
  Layer.provideMerge(MigratedPostgresLayer),
  Layer.provide(
    Layer.succeed(GitHubAppAuth, {
      appJwt: Effect.succeed(Redacted.make("test-app-jwt")),
      installationToken: () =>
        Effect.die("An installation-wide token must never reach repository execution"),
      invalidateInstallationToken: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          assert.strictEqual(
            request.url,
            "https://api.github.com/app/installations/77/access_tokens",
          )
          assert.strictEqual(request.headers.authorization, "Bearer test-app-jwt")
          assert.strictEqual(request.body._tag, "Uint8Array")
          if (request.body._tag === "Uint8Array")
            requests.push(JSON.parse(new TextDecoder().decode(request.body.body)))
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ token: "scoped-read-token" }, { status: rejectCredential ? 401 : 201 }),
          )
        }),
      ),
    ),
  ),
)

layer(service)("Repository execution authority", (it) => {
  it.effect(
    "scopes clone credentials and refuses stale, paused, disconnected and unselected repositories",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1)`
        yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence,automation_ready_at) VALUES('9100','77','test','example',TRUE,TRUE,'accessible',1,CLOCK_TIMESTAMP())`
        yield* sql`INSERT INTO agent_session(session_id,title,repository_id) VALUES('inspect','Inspect','9100')`
        const access = yield* RepositoryAccess
        const request = { sessionId: "inspect", repositoryId: "9100", generation: 1, token: true }
        const authorized = yield* access.authorize(request)
        assert.strictEqual(Redacted.value(authorized.token!), "scoped-read-token")
        assert.deepStrictEqual(requests, [
          { repository_ids: [9100], permissions: { contents: "read" } },
        ])
        assert.isUndefined((yield* access.authorize({ ...request, token: false })).token)
        assert.strictEqual(requests.length, 1)
        for (const invalid of [
          { ...request, generation: 0 },
          { ...request, repositoryId: "9101" },
        ])
          assert.strictEqual((yield* access.authorize(invalid).pipe(Effect.result))._tag, "Failure")
        yield* sql`UPDATE github_repository SET enabled = FALSE WHERE repository_id = '9100'`
        assert.strictEqual((yield* access.authorize(request).pipe(Effect.result))._tag, "Failure")
        yield* sql`UPDATE github_repository SET enabled = TRUE, automation_ready_at = CLOCK_TIMESTAMP() WHERE repository_id = '9100'`
        rejectCredential = true
        assert.strictEqual((yield* access.authorize(request).pipe(Effect.result))._tag, "Failure")
        rejectCredential = false
        yield* sql`UPDATE agent_session SET runner_state = 'disconnected' WHERE session_id = 'inspect'`
        assert.strictEqual((yield* access.authorize(request).pipe(Effect.result))._tag, "Failure")
      }),
  )
})
