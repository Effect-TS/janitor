import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { ConnectionInventory } from "@janitor/domain/GitHub/Connection"
import { SyncTargets } from "./SyncTargets.ts"
import { GitHubTransport } from "./GitHub/Transport.ts"

export class ConnectionError extends Schema.TaggedError<ConnectionError>()("ConnectionError", {
  message: Schema.String,
}) {}
const wrap = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((error) => new ConnectionError({ message: error.message })))
type Actor = { issuer: string; subject: string }
export class RepositoryConnections extends Context.Service<
  RepositoryConnections,
  {
    readonly inventory: Effect.Effect<typeof ConnectionInventory.Type, ConnectionError>
    readonly change: (
      id: string,
      action: "connect" | "disconnect" | "resume" | "pause",
      actor: Actor,
    ) => Effect.Effect<void, ConnectionError>
    readonly refresh: Effect.Effect<void, ConnectionError>
    readonly github: (
      installationId: string | null,
      actor: Actor,
    ) => Effect.Effect<string, ConnectionError>
    readonly returned: (state: string, actor: Actor) => Effect.Effect<void, ConnectionError>
  }
>()("RepositoryConnections", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const targets = yield* SyncTargets
    const transport = yield* GitHubTransport
    const inventory = sql`
    SELECT r.repository_id AS "repositoryId", r.installation_id AS "installationId", r.owner, r.repo,
      r.is_private AS "isPrivate", r.connected, r.enabled, (r.disconnected_at IS NOT NULL) AS reconnect,
      r.access, i.status AS "installationStatus",
      (SELECT count(*)::int FROM labeling_policy p WHERE p.repository_id=r.repository_id) AS "policyCount",
      (SELECT count(*)::int FROM labeling_rule p WHERE p.repository_id=r.repository_id AND p.enabled) AS "ruleCount",
      CASE WHEN NOT r.sync_enabled THEN 'paused' WHEN EXISTS(SELECT 1 FROM sync_target t WHERE t.scope->>'repositoryId'=r.repository_id AND t.last_error IS NOT NULL) THEN 'failed'
        WHEN EXISTS(SELECT 1 FROM sync_target t WHERE t.scope->>'repositoryId'=r.repository_id AND t.requested_generation>t.completed_generation) THEN 'syncing'
        ELSE 'ready' END AS "syncState"
    FROM github_repository r JOIN github_installation i USING(installation_id) ORDER BY r.owner,r.repo
  `.pipe(
      Effect.flatMap((repositories) =>
        Schema.decodeUnknownEffect(ConnectionInventory)({ repositories }),
      ),
      wrap,
    )
    const refresh = targets
      .invalidate({ scope: { _tag: "AppInventory" }, sequence: Option.none(), immediate: true })
      .pipe(Effect.asVoid, wrap)
    const change = (
      id: string,
      action: "connect" | "disconnect" | "resume" | "pause",
      actor: Actor,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<{
              repository_id: string
              installation_id: string
              owner: string
              repo: string
              connected: boolean
              enabled: boolean
              disconnected_at: Date | null
              access: string
              status: string
            }>`
      SELECT r.*,i.status FROM github_repository r JOIN github_installation i USING(installation_id)
      WHERE repository_id=${id} FOR UPDATE OF r`
            if (!row)
              return yield* new ConnectionError({
                message: "Repository not found. Refresh available repositories.",
              })
            if ((action === "resume" || action === "pause") && !row.connected)
              return yield* new ConnectionError({
                message: "Reconnect this repository before resuming.",
              })
            if (
              (action === "connect" && row.connected) ||
              (action === "disconnect" && !row.connected)
            )
              return
            const enabling = action === "resume" || action === "connect"
            if (enabling) {
              if (row.access !== "accessible" || row.status !== "active")
                return yield* new ConnectionError({
                  message: "Restore GitHub access before connecting or resuming.",
                })
              const response = yield* transport.request({
                scope: {
                  _tag: "Installation",
                  installationId: GitHubInstallationId.make(row.installation_id),
                },
                priority: "foreground",
                method: "GET",
                url: `/repos/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}`,
              })
              if (response._tag !== "Ok")
                return yield* new ConnectionError({
                  message:
                    "GitHub access could not be verified. Check installation permissions and retry.",
                })
              const verified = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ id: Schema.Number }),
              )(response.body)
              if (String(verified.id) !== id)
                return yield* new ConnectionError({
                  message: "Repository identity changed. Refresh inventory and retry.",
                })
            }
            const enabled =
              action === "resume" || (action === "connect" && row.disconnected_at === null)
            yield* sql`UPDATE github_repository SET connected=${action !== "disconnect"}, enabled=${enabled},
      disconnected_at=CASE WHEN ${action === "disconnect"} THEN now() ELSE disconnected_at END,
      observed_at=now() WHERE repository_id=${id}`
            yield* sql`INSERT INTO repository_connection_audit(repository_id,action,issuer,subject) VALUES(${id},${action},${actor.issuer},${actor.subject})`
            if (enabled)
              for (const track of ["labels", "entities", "pull_requests"] as const)
                yield* targets.invalidate({
                  scope: {
                    _tag: "RepositoryTrack",
                    repositoryId: GitHubRepositoryDatabaseId.make(id),
                    track,
                  },
                  sequence: Option.none(),
                  immediate: true,
                  full: true,
                })
          }),
        )
        .pipe(wrap)
    const github = (installationId: string | null, actor: Actor) =>
      Effect.gen(function* () {
        const response = yield* transport.request({
          scope: { _tag: "App" },
          priority: "foreground",
          method: "GET",
          url:
            installationId === null
              ? "/app"
              : `/app/installations/${encodeURIComponent(installationId)}`,
        })
        if (response._tag !== "Ok")
          return yield* new ConnectionError({
            message: "GitHub installation settings are unavailable. Try again.",
          })
        const data = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            slug: Schema.optionalKey(Schema.String),
            html_url: Schema.optionalKey(Schema.String),
          }),
        )(response.body)
        if (installationId === null && !data.slug)
          return yield* new ConnectionError({
            message: "GitHub did not return an app installation URL. Try again.",
          })
        const [attempt] = yield* sql<{
          state: string
        }>`INSERT INTO repository_connection_attempt(issuer,subject) VALUES(${actor.issuer},${actor.subject}) RETURNING state::text`
        yield* sql`DELETE FROM repository_connection_attempt WHERE expires_at < now()`
        const url = new URL(
          installationId === null
            ? `https://github.com/apps/${encodeURIComponent(data.slug ?? "")}/installations/new`
            : (data.html_url ?? "https://github.com/settings/installations"),
        )
        if (url.origin !== "https://github.com")
          return yield* new ConnectionError({ message: "Unexpected GitHub settings URL." })
        url.searchParams.set("state", attempt!.state)
        return url.toString()
      }).pipe(wrap)
    const returned = (state: string, actor: Actor) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`DELETE FROM repository_connection_attempt WHERE state::text=${state} AND issuer=${actor.issuer} AND subject=${actor.subject} AND expires_at>now() RETURNING state`
        if (rows.length === 0)
          return yield* new ConnectionError({
            message: "This connection attempt expired. Refresh repositories to continue.",
          })
        yield* refresh
      }).pipe(wrap)
    return { inventory, change, refresh, github, returned }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
