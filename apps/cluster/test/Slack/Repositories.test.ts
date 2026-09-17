import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubAppAuth } from "../../src/GitHub/AppAuth.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import { Repositories, layerRepositories, pinGeneration } from "../../src/Slack/Repositories.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const service = layerRepositories.pipe(
  Layer.provideMerge(RepositoryEligibility.layer),
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
        // Synchronization has not completed: the UI cache is still warming.
        yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence,automation_ready_at) VALUES('9100','77','test','example',TRUE,TRUE,'accessible',1,NULL)`
        yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence) VALUES('9101','77','test','paused',TRUE,FALSE,'accessible',1)`
        yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence) VALUES('9102','77','test','available',FALSE,FALSE,'accessible',1)`
        const repositories = yield* Repositories
        const listed = yield* repositories.list
        assert.deepStrictEqual(
          listed.map((entry) => ({
            id: entry.id,
            name: entry.name,
            installation: entry.installation,
          })),
          [{ id: "9100", name: "test/example", installation: "77" }],
        )
        assert.strictEqual((yield* repositories.get("TEST/EXAMPLE")).id, "9100")
        assert.strictEqual(Redacted.value(yield* repositories.credentials("9100")), "read-token")
        // Cache failure is reported to the UI but does not stop repository work.
        yield* sql`INSERT INTO sync_target(scope,scope_key,health,last_error) VALUES('{"_tag":"RepositoryTrack","repositoryId":"9100","track":"labels"}','x','blocked','GitHub timeout')`
        assert.strictEqual((yield* repositories.get("9100")).id, "9100")
        assert.strictEqual(
          yield* Effect.flip(repositories.get("test/paused")),
          "This repository is paused in Janitor. Resume it to continue.",
        )
        assert.include(yield* Effect.flip(repositories.get("test/available")), "not connected")
        assert.include(yield* Effect.flip(repositories.get("test/unknown")), "not connected")
        yield* sql`UPDATE github_installation SET access_error='Grant issues: write' WHERE installation_id='77'`
        assert.strictEqual(
          yield* Effect.flip(repositories.credentials("9100")),
          "GitHub access to this repository is unavailable. Restore access on GitHub.",
        )
        yield* sql`UPDATE github_installation SET access_error=NULL WHERE installation_id='77'`
        yield* sql`UPDATE github_repository SET enabled=FALSE WHERE repository_id='9100'`
        assert.strictEqual((yield* repositories.get("9100").pipe(Effect.result))._tag, "Failure")
        yield* sql`UPDATE github_repository SET connected=FALSE, disconnected_at=now() WHERE repository_id='9100'`
        assert.strictEqual(
          yield* Effect.flip(repositories.credentials("9100")),
          "This repository is disconnected from Janitor.",
        )
      }),
  )

  it.effect("refuses a turn's repository once its eligibility generation changes", () =>
    Effect.gen(function* () {
      let generation = "1"
      const repository = () => ({
        id: "9100",
        name: "test/example",
        installation: "77",
        generation,
      })
      const repositories = {
        list: Effect.succeed([]),
        get: () => Effect.succeed(repository()),
        credentials: () => Effect.succeed(Redacted.make("read-token")),
      }
      const turn = pinGeneration(repositories)
      assert.strictEqual((yield* turn.get("9100")).generation, "1")
      assert.strictEqual(Redacted.value(yield* turn.credentials("9100")), "read-token")
      // Paused and resumed while the turn was running: same repository, new generation.
      generation = "3"
      assert.include(
        yield* Effect.flip(turn.get("test/example")),
        "changed since this work was accepted",
      )
      assert.include(
        yield* Effect.flip(turn.credentials("9100")),
        "changed since this work was accepted",
      )
      // The next input observes the current generation.
      assert.strictEqual((yield* pinGeneration(repositories).get("9100")).generation, "3")
    }),
  )
})
