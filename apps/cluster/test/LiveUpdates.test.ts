import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { LiveUpdates, liveUpdatesLayer } from "../src/LiveUpdates.ts"
import { Services, seed, repositoryId } from "./Labeling/support.ts"

layer(Services, { timeout: "2 minutes" })("Live notification outbox", (it) => {
  it.effect(
    "commits notifications atomically, coalesces topics, and retains concurrent changes",
    () =>
      Effect.gen(function* () {
        yield* seed
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM live_notification`
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE github_repository SET connected=false WHERE repository_id=${repositoryId}`
              return yield* Effect.fail("rollback")
            }),
          )
          .pipe(Effect.ignore)
        assert.lengthOf(yield* sql`SELECT * FROM live_notification`, 0)
        yield* sql`UPDATE github_repository SET connected=false WHERE repository_id=${repositoryId}`
        yield* sql`UPDATE github_repository SET connected=true WHERE repository_id=${repositoryId}`
        const rows = yield* sql`SELECT * FROM live_notification WHERE repository_id=${repositoryId}`
        assert.lengthOf(rows, 1)
        let fail = true
        let concurrent = false
        const messages: unknown[] = []
        const service = yield* LiveUpdates.pipe(
          Effect.provide(
            liveUpdatesLayer({
              getByName: () => ({
                fetch: async (_url, init) => {
                  messages.push(JSON.parse(String(init?.body)))
                  if (fail) return new Response(null, { status: 503 })
                  if (!concurrent) {
                    concurrent = true
                    await Effect.runPromise(
                      sql`UPDATE live_notification SET revision=nextval('live_notification_revision') WHERE repository_id=${repositoryId}`,
                    )
                  }
                  return new Response(null, { status: 204 })
                },
              }),
            }),
          ),
        )
        yield* service.flush
        assert.lengthOf(
          yield* sql`SELECT * FROM live_notification WHERE repository_id=${repositoryId}`,
          1,
        )
        fail = false
        yield* service.flush
        assert.lengthOf(
          yield* sql`SELECT * FROM live_notification WHERE repository_id=${repositoryId}`,
          1,
        )
        yield* service.flush
        assert.lengthOf(
          yield* sql`SELECT * FROM live_notification WHERE repository_id=${repositoryId}`,
          0,
        )
        assert.lengthOf(messages, 3)
        assert.strictEqual((yield* service.connect(repositoryId, 0)).status, 204)
        yield* sql`UPDATE github_repository SET connected=false WHERE repository_id=${repositoryId}`
        assert.strictEqual((yield* service.connect(repositoryId, 0)).status, 403)
      }),
  )
})
