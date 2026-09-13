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

layer(Services, { timeout: "2 minutes" })("Session live channel", (it) => {
  it.effect(
    "never marks the team channel disconnected and tells it which teammates were removed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM live_notification`
        yield* sql`INSERT INTO teammate (issuer, subject, role) VALUES ('iss', 'viewer', 'member') ON CONFLICT DO NOTHING`
        const [viewer] = yield* sql<{
          teammate_id: string
        }>`SELECT teammate_id::text AS teammate_id FROM teammate WHERE subject='viewer'`
        yield* sql`INSERT INTO agent_session (session_id, title) VALUES ('live-1', 'Live')`
        const messages: Array<{ channel: string; body: any }> = []
        const service = yield* LiveUpdates.pipe(
          Effect.provide(
            liveUpdatesLayer({
              getByName: (channel) => ({
                fetch: async (url, init) => {
                  messages.push({ channel, body: init?.body ? JSON.parse(String(init.body)) : url })
                  return new Response(null, { status: 204 })
                },
              }),
            }),
          ),
        )
        yield* service.flush
        assert.deepStrictEqual(
          messages.map((message) => message.channel),
          ["sessions"],
        )
        assert.deepStrictEqual(messages[0]!.body.topics, ["sessions"])
        assert.isFalse(messages[0]!.body.disconnected)
        assert.deepStrictEqual(messages[0]!.body.revoked, [])
        assert.lengthOf(yield* sql`SELECT * FROM live_notification`, 0)

        // A subscription needs an active membership at the boundary, then removal revokes it.
        assert.strictEqual((yield* service.connectSessions(viewer!.teammate_id, 0)).status, 204)
        messages.length = 0
        yield* sql`UPDATE teammate SET status='removed' WHERE subject='viewer'`
        yield* service.flush
        assert.deepStrictEqual(messages[0]!.body.topics, ["membership"])
        assert.deepStrictEqual(messages[0]!.body.revoked, [viewer!.teammate_id])
        assert.strictEqual((yield* service.connectSessions(viewer!.teammate_id, 0)).status, 403)
        yield* sql`DELETE FROM agent_session WHERE session_id='live-1'`
        yield* sql`DELETE FROM live_notification`
      }),
  )
})
