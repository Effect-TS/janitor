import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { ConnectionInventory } from "@janitor/domain/GitHub/Connection"
import { SyncTargets } from "./SyncTargets.ts"
import { GitHubTransport, type GitHubResponse } from "./GitHub/Transport.ts"
import { GitHubReadModel } from "./GitHub/ReadModel.ts"
import { nextLink } from "./GitHub/Link.ts"
import type { GitHubApiScope } from "@janitor/domain/GitHub/Api"
import {
  GitHubInstallationSummary,
  GitHubInstallationRepositoriesResponse,
} from "@janitor/domain/GitHub/Installation"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"

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
    const readModel = yield* GitHubReadModel
    const inventory = sql`
    SELECT r.repository_id AS "repositoryId", r.installation_id AS "installationId", r.owner, r.repo,
      r.is_private AS "isPrivate", r.connected, r.enabled, (r.disconnected_at IS NOT NULL) AS reconnect,
      r.access, i.status AS "installationStatus",
      (SELECT count(*)::int FROM labeling_policy p WHERE p.repository_id=r.repository_id) AS "policyCount",
      (SELECT count(*)::int FROM labeling_rule p WHERE p.repository_id=r.repository_id AND p.enabled) AS "ruleCount",
      (SELECT COALESCE(t.last_error,t.blocked_reason) FROM sync_target t
        WHERE t.scope->>'repositoryId'=r.repository_id AND (t.last_error IS NOT NULL OR t.health='blocked')
        ORDER BY t.updated_at DESC LIMIT 1) AS "syncError",
      CASE WHEN NOT r.sync_enabled THEN 'paused' WHEN EXISTS(SELECT 1 FROM sync_target t WHERE t.scope->>'repositoryId'=r.repository_id AND (t.last_error IS NOT NULL OR t.health = 'blocked')) THEN 'failed'
        WHEN r.automation_ready_at IS NULL THEN 'syncing'
        ELSE 'ready' END AS "syncState"
    FROM github_repository r JOIN github_installation i USING(installation_id) ORDER BY r.owner,r.repo
  `.pipe(
      Effect.flatMap((repositories) =>
        Schema.decodeUnknownEffect(ConnectionInventory)({ repositories }),
      ),
      wrap,
    )
    // Discover access in this request; background sync only fills repository content.
    const refresh = Effect.gen(function* () {
      const [watermark] = yield* sql<{ sequence: string }>`
        SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM github_webhook_delivery`
      const sequence = GitHubWebhookJournalSequence.make(watermark!.sequence)
      const pages = <S extends Schema.Top>(scope: GitHubApiScope, firstUrl: string, schema: S) =>
        Effect.gen(function* () {
          const bodies: Array<S["Type"]> = []
          let url: string | undefined = firstUrl
          const visited = new Set<string>()
          while (url !== undefined) {
            if (
              visited.has(url) ||
              new URL(url, "https://api.github.com").origin !== "https://api.github.com"
            )
              return yield* new ConnectionError({
                message: "GitHub returned an invalid pagination link.",
              })
            visited.add(url)
            const response: GitHubResponse = yield* transport.request({
              scope,
              priority: "foreground",
              method: "GET",
              url,
            })
            if (response._tag !== "Ok")
              return yield* new ConnectionError({
                message: "Could not refresh GitHub access. Please retry.",
              })
            bodies.push(yield* Schema.decodeUnknownEffect(schema)(response.body))
            url = Option.getOrUndefined(Option.flatMap(response.link, nextLink))
          }
          return bodies
        })
      const installations = (yield* pages(
        { _tag: "App" },
        "/app/installations?per_page=100",
        Schema.Array(GitHubInstallationSummary),
      )).flat()
      for (const installation of installations) {
        const repositories =
          installation.suspendedAt === null
            ? (yield* pages(
                { _tag: "Installation", installationId: installation.id },
                "/installation/repositories?per_page=100",
                GitHubInstallationRepositoriesResponse,
              )).flatMap((page) => page.repositories)
            : []
        yield* readModel.withTransaction(
          Effect.gen(function* () {
            yield* readModel.applyInstallation({
              installation,
              status: installation.suspendedAt === null ? "active" : "suspended",
              sequence,
              authoritative: true,
            })
            if (installation.suspendedAt === null) {
              yield* readModel.applyRepositories({
                installationId: installation.id,
                repositories,
                sequence,
                authoritative: true,
              })
              yield* readModel.markRepositoriesSuspect({
                installationId: installation.id,
                present: repositories.map((repo) => repo.id),
                sequence,
              })
            }
          }),
        )
      }
    }).pipe(wrap)
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
            if (enabled) {
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
              yield* targets.retryFailedEntities(GitHubRepositoryDatabaseId.make(id))
            }
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
