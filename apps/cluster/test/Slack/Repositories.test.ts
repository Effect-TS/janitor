import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubAppAuth } from "../../src/GitHub/AppAuth.ts"
import { Repositories, layerRepositories } from "../../src/Slack/Repositories.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const service = layerRepositories.pipe(
  Layer.provideMerge(MigratedPostgresLayer),
  Layer.provide(
    Layer.succeed(GitHubAppAuth, {
      appJwt: Effect.succeed(Redacted.make("test-jwt")),
      installationToken: () => Effect.die("Must use repository-scoped credentials"),
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
          assert.strictEqual(request.body._tag, "Uint8Array")
          if (request.body._tag === "Uint8Array") {
            assert.strictEqual(
              new TextDecoder().decode(request.body.body),
              '{"repository_ids":[9100],"permissions":{"contents":"read"}}',
            )
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ token: "read-token" }, { status: 201 }),
          )
        }),
      ),
    ),
  ),
)

layer(service)("Slack repository access", (it) => {
  it.effect(
    "lists ready repositories, scopes credentials and rechecks pause and disconnection",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1)`
        yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence,automation_ready_at) VALUES('9100','77','test','example',TRUE,TRUE,'accessible',1,CLOCK_TIMESTAMP())`
        const repositories = yield* Repositories
        assert.deepStrictEqual(yield* repositories.list, [
          { id: "9100", name: "test/example", installation: "77" },
        ])
        assert.strictEqual((yield* repositories.get("TEST/EXAMPLE")).id, "9100")
        assert.strictEqual(Redacted.value(yield* repositories.credentials("9100")), "read-token")
        yield* sql`UPDATE github_repository SET enabled=FALSE WHERE repository_id='9100'`
        assert.strictEqual((yield* repositories.get("9100").pipe(Effect.result))._tag, "Failure")
        yield* sql`UPDATE github_repository SET connected=FALSE WHERE repository_id='9100'`
        assert.strictEqual(
          (yield* repositories.credentials("9100").pipe(Effect.result))._tag,
          "Failure",
        )
      }),
  )
})
