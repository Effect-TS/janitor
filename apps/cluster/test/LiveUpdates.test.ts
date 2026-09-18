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
        const rows =
          yield* sql`SELECT * FROM live_notification WHERE repository_id=${repositoryId} AND topic='repository'`
        assert.lengthOf(rows, 1)
        let fail = true
        let concurrent = false
        const messages: unknown[] = []
        const service = yield* LiveUpdates.pipe(
          Effect.provide(
            liveUpdatesLayer({
              getByName: (channel) => ({
                fetch: async (_url, init) => {
                  if (channel === repositoryId) messages.push(JSON.parse(String(init?.body)))
                  if (fail) return new Response(null, { status: 503 })
                  if (!concurrent) {
                    concurrent = true
                    await Effect.runPromise(
                      sql`UPDATE live_notification SET revision=nextval('live_notification_revision') WHERE repository_id=${repositoryId} AND topic='repository'`,
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
          yield* sql`SELECT * FROM live_notification WHERE repository_id=${repositoryId} AND topic='repository'`,
          1,
        )
        fail = false
        yield* service.flush
        assert.lengthOf(
          yield* sql`SELECT * FROM live_notification WHERE repository_id=${repositoryId} AND topic='repository'`,
          1,
        )
        yield* service.flush
        assert.lengthOf(
          yield* sql`SELECT * FROM live_notification WHERE repository_id=${repositoryId} AND topic='repository'`,
          0,
        )
        assert.lengthOf(messages, 3)
        assert.strictEqual((yield* service.connect(repositoryId, 0)).status, 204)
        yield* sql`UPDATE github_repository SET connected=false WHERE repository_id=${repositoryId}`
        assert.strictEqual((yield* service.connect(repositoryId, 0)).status, 403)
      }),
  )
  it.effect("notifies inventory subscribers before any repository is connected", () =>
    Effect.gen(function* () {
      yield* seed
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE github_repository SET connected=false`
      yield* sql`DELETE FROM live_notification`
      yield* sql`UPDATE github_installation SET account_handle = account_handle || '-renamed'`
      const notices: Array<{ channel: string; body: unknown }> = []
      const service = yield* LiveUpdates.pipe(
        Effect.provide(
          liveUpdatesLayer({
            getByName: (channel) => ({
              fetch: async (_url, init) => {
                notices.push({ channel, body: JSON.parse(String(init?.body)) })
                return new Response(null, { status: 204 })
              },
            }),
          }),
        ),
      )
      assert.strictEqual((yield* service.connect("application", 0)).status, 204)
      assert.strictEqual((yield* service.connect(repositoryId, 0)).status, 403)
      yield* service.flush
      assert.lengthOf(notices, 1)
      assert.strictEqual(notices[0].channel, "application")
      assert.deepInclude(notices[0].body, { topics: ["connections"], disconnected: false })
      yield* sql`UPDATE github_installation SET observed_at=CLOCK_TIMESTAMP(), projected_sequence=projected_sequence+1`
      assert.lengthOf(yield* sql`SELECT * FROM live_notification`, 0)
    }),
  )
  it.effect("notifies account changes without notifying on authentication timestamps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM live_notification`
      yield* sql`INSERT INTO teammate (issuer, subject, email, role)
        VALUES ('live-test', 'live-user', 'live@example.com', 'member')`
      assert.lengthOf(
        yield* sql`SELECT * FROM live_notification WHERE repository_id='application' AND topic='account'`,
        1,
      )
      yield* sql`DELETE FROM live_notification`
      yield* sql`UPDATE teammate SET updated_at=CLOCK_TIMESTAMP() WHERE issuer='live-test'`
      assert.lengthOf(yield* sql`SELECT * FROM live_notification`, 0)
      yield* sql`UPDATE teammate SET role='admin' WHERE issuer='live-test'`
      assert.lengthOf(
        yield* sql`SELECT * FROM live_notification WHERE repository_id='application' AND topic='account'`,
        1,
      )
    }),
  )
})
