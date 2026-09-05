import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { readiness } from "../../src/Ingress/Readiness.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

layer(MigratedPostgresLayer, { timeout: "60 seconds" })("readiness", (it) => {
  it.effect("accepts a migrated empty database and rejects an incompatible schema", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* readiness).status, 200)
      const sql = yield* SqlClient.SqlClient
      yield* Effect.acquireUseRelease(
        sql`ALTER TABLE github_repository RENAME COLUMN connected TO old_connected`,
        () =>
          Effect.gen(function* () {
            const response = yield* readiness
            assert.strictEqual(response.status, 503)
          }),
        () =>
          sql`ALTER TABLE github_repository RENAME COLUMN old_connected TO connected`.pipe(
            Effect.orDie,
          ),
      )
      assert.strictEqual((yield* readiness).status, 200)
    }),
  )
})
