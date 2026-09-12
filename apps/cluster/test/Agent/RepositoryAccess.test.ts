import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RepositoryAccess } from "../../src/Agent/RepositoryAccess.ts"
import { GitHubAppAuth } from "../../src/GitHub/AppAuth.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

let rejectCredential = false
let expiresAt = "2099-01-01T00:00:00Z"
const requests: unknown[] = []
const installations: string[] = []
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
          assert.match(
            request.url,
            /^https:\/\/api.github.com\/app\/installations\/7[78]\/access_tokens$/,
          )
          installations.push(request.url)
          assert.strictEqual(request.headers.authorization, "Bearer test-app-jwt")
          assert.strictEqual(request.body._tag, "Uint8Array")
          if (request.body._tag === "Uint8Array")
            requests.push(JSON.parse(new TextDecoder().decode(request.body.body)))
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { token: "scoped-read-token", expires_at: expiresAt },
              { status: rejectCredential ? 401 : 201 },
            ),
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
        yield* access.authorize(request)
        assert.strictEqual(requests.length, 1)
        yield* access.authorize({ ...request, permission: "push" })
        assert.deepStrictEqual(requests[1], {
          repository_ids: [9100],
          permissions: { contents: "write" },
        })
        yield* access.authorize({ ...request, permission: "pull_request" })
        assert.deepStrictEqual(requests[2], {
          repository_ids: [9100],
          permissions: { pull_requests: "write" },
        })
        assert.isUndefined((yield* access.authorize({ ...request, token: false })).token)
        assert.strictEqual(requests.length, 3)
        for (const invalid of [
          { ...request, generation: 0 },
          { ...request, repositoryId: "9101" },
        ])
          assert.strictEqual((yield* access.authorize(invalid).pipe(Effect.result))._tag, "Failure")
        yield* sql`UPDATE github_repository SET enabled = FALSE WHERE repository_id = '9100'`
        assert.strictEqual((yield* access.authorize(request).pipe(Effect.result))._tag, "Failure")
        yield* sql`UPDATE github_repository SET enabled = TRUE, automation_ready_at = CLOCK_TIMESTAMP() WHERE repository_id = '9100'`
        yield* sql`UPDATE github_repository SET automation_ready_at = CLOCK_TIMESTAMP() WHERE repository_id = '9100'`
        rejectCredential = true
        assert.strictEqual(
          (yield* access.authorize({ ...request, refresh: true }).pipe(Effect.result))._tag,
          "Failure",
        )
        rejectCredential = false
        yield* access.authorize(request)
        const beforeExpiry = requests.length
        yield* TestClock.setTime(Date.parse("2098-12-31T23:58:59Z"))
        yield* access.authorize(request)
        assert.strictEqual(requests.length, beforeExpiry)
        expiresAt = "2099-01-01T01:00:00Z"
        yield* TestClock.adjust("1 second")
        yield* access.authorize(request)
        assert.strictEqual(requests.length, beforeExpiry + 1)
        yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence,automation_ready_at) VALUES('9101','77','test','second',TRUE,TRUE,'accessible',1,CLOCK_TIMESTAMP())`
        yield* sql`INSERT INTO agent_session(session_id,title,repository_id) VALUES('second','Second','9101')`
        yield* access.authorize({ ...request, sessionId: "second", repositoryId: "9101" })
        assert.deepStrictEqual(requests.at(-1), {
          repository_ids: [9101],
          permissions: { contents: "read" },
        })
        assert.strictEqual(requests.length, beforeExpiry + 2)
        yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'78','2','other','Organization','selected','active','https://github.com/settings/installations/78',1)`
        yield* sql`UPDATE github_repository SET installation_id='78' WHERE repository_id='9101'`
        yield* sql`UPDATE github_repository SET automation_ready_at=CLOCK_TIMESTAMP() WHERE repository_id='9101'`
        yield* access.authorize({ ...request, sessionId: "second", repositoryId: "9101" })
        assert.strictEqual(requests.length, beforeExpiry + 3)
        assert.strictEqual(
          installations.at(-1),
          "https://api.github.com/app/installations/78/access_tokens",
        )
        expiresAt = "2098-12-31T23:59:00Z"
        assert.strictEqual(
          (yield* access.authorize({ ...request, refresh: true }).pipe(Effect.result))._tag,
          "Failure",
        )
        yield* sql`INSERT INTO slack_thread(session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context,repository_id,pr_number) VALUES('inspect','T1','C1','1.000000','1.000000','ready','[]','9100','7')`
        assert.isUndefined((yield* access.authorize({ ...request, token: false })).token)
        assert.strictEqual(
          (yield* access
            .authorize({ ...request, token: false, publication: true })
            .pipe(Effect.result))._tag,
          "Failure",
        )
        yield* sql`UPDATE agent_session SET runner_state = 'disconnected' WHERE session_id = 'inspect'`
        assert.strictEqual((yield* access.authorize(request).pipe(Effect.result))._tag, "Failure")
      }),
  )
})
