import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
export interface LiveNamespace {
  getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

export class LiveUpdates extends Context.Service<
  LiveUpdates,
  {
    readonly flush: Effect.Effect<void>
    readonly connect: (repositoryId: string, expiresAt: number) => Effect.Effect<Response>
  }
>()("Janitor/LiveUpdates") {}

export const flushLive = Effect.serviceOption(LiveUpdates).pipe(
  Effect.flatMap((service) => (Option.isSome(service) ? service.value.flush : Effect.void)),
)

export const liveUpdatesLayer = (namespace: LiveNamespace) =>
  Layer.effect(
    LiveUpdates,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const flush = Effect.gen(function* () {
        const rows = yield* sql<{
          repository_id: string
          topic: string
          revision: string
          disconnected: boolean
        }>`
      SELECT n.repository_id,n.topic,n.revision::text,NOT COALESCE(r.connected AND r.access='accessible',false) AS disconnected
      FROM live_notification n LEFT JOIN github_repository r USING(repository_id) ORDER BY n.revision LIMIT 500`
        const groups = new Map<string, (typeof rows)[number][]>()
        for (const row of rows) {
          const group = groups.get(row.repository_id) ?? []
          group.push(row)
          groups.set(row.repository_id, group)
        }
        yield* Effect.forEach(
          [...groups],
          ([repositoryId, entries]) =>
            Effect.gen(function* () {
              const response = yield* Effect.tryPromise(() =>
                namespace.getByName(repositoryId).fetch("https://live.internal/notify", {
                  method: "POST",
                  body: JSON.stringify({
                    revision: entries.at(-1)!.revision,
                    topics: entries.map((row) => row.topic),
                    disconnected: entries[0]!.disconnected,
                  }),
                }),
              ).pipe(Effect.timeout("5 seconds"))
              if (!response.ok)
                return yield* Effect.fail(new Error(`Live notification failed: ${response.status}`))
              for (const row of entries)
                yield* sql`DELETE FROM live_notification WHERE repository_id=${row.repository_id} AND topic=${row.topic} AND revision=${row.revision}::bigint`
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Live notification retained for retry", cause),
              ),
            ),
          { concurrency: 4, discard: true },
        )
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchCause((cause) => Effect.logWarning("Live notification dispatch failed", cause)),
      )
      return {
        flush,
        connect: (repositoryId, expiresAt) =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id=${repositoryId} AND connected AND access='accessible'`.pipe(
                Effect.orDie,
              )
            if (!rows.length) return new Response(null, { status: 403 })
            if (expiresAt === 0) return new Response(null, { status: 204 })
            return yield* Effect.promise(
              async () =>
                (await namespace
                  .getByName(repositoryId)
                  .fetch(`https://live.internal/connect?expiresAt=${expiresAt}`, {
                    headers: { Upgrade: "websocket" },
                  })) as unknown as Response,
            )
          }),
      }
    }),
  )
