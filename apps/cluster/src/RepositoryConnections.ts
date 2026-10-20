import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { ConnectionInventory } from "@janitor/domain/GitHub/Connection"
import { SyncTargets } from "./SyncTargets.ts"
import { GitHubTransport, type GitHubRequest, type GitHubResponse } from "./GitHub/Transport.ts"
import { GitHubReadModel } from "./GitHub/ReadModel.ts"
import { nextLink } from "./GitHub/Link.ts"
import type { GitHubApiScope } from "@janitor/domain/GitHub/Api"
import {
  GitHubInstallationSummary,
  requiredGitHubAccessError,
  GitHubInstallationRepositoriesResponse,
} from "@janitor/domain/GitHub/Installation"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { AuthorizationExpired } from "@janitor/domain/GitHub/Authorization"
import {
  RepositoryBlocked,
  RepositoryIdentityChanged,
  RepositoryNotFound,
} from "@janitor/domain/GitHub/Repository"
import { repositoryOfPayload } from "./GitHub/RepositoryPayload.ts"

type Actor = { issuer: string; subject: string }
/**
 * Only a refused connection change and a spent connection return fail;
 * database, GitHub and decoding failures die.
 */
export class RepositoryConnections extends Context.Service<
  RepositoryConnections,
  {
    readonly inventory: Effect.Effect<typeof ConnectionInventory.Type>
    readonly change: (
      id: GitHubRepositoryDatabaseId,
      action: "connect" | "disconnect" | "resume" | "pause",
      actor: Actor,
    ) => Effect.Effect<void, RepositoryNotFound | RepositoryBlocked | RepositoryIdentityChanged>
    readonly refresh: Effect.Effect<void>
    readonly github: (installationId: string | null, actor: Actor) => Effect.Effect<string>
    readonly returned: (state: string, actor: Actor) => Effect.Effect<void, AuthorizationExpired>
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
      CASE WHEN i.access_error IS NOT NULL THEN 'lost' ELSE r.access END AS access,
      i.access_error AS "accessError", i.status AS "installationStatus",
      repository_block_reason(r.repository_id) AS "blockReason",
      (SELECT count(*)::int FROM labeling_policy p WHERE p.repository_id=r.repository_id) AS "policyCount",
      (SELECT count(*)::int FROM labeling_rule p WHERE p.repository_id=r.repository_id AND p.enabled) AS "ruleCount",
      (SELECT COALESCE(t.last_error,t.blocked_reason) FROM sync_target t
        WHERE t.scope->>'repositoryId'=r.repository_id AND (t.last_error IS NOT NULL OR t.health='blocked')
        ORDER BY t.updated_at DESC LIMIT 1) AS "syncError",
      CASE WHEN NOT repository_access_current(r.repository_id) THEN 'access-unavailable'
        WHEN NOT r.connected OR NOT i.sync_enabled THEN 'disabled'
        WHEN NOT r.enabled THEN 'paused'
        WHEN EXISTS(SELECT 1 FROM sync_target t WHERE t.scope->>'repositoryId'=r.repository_id
          AND (t.last_error IS NOT NULL OR t.health = 'blocked')) THEN 'failed'
        WHEN EXISTS(SELECT 1 FROM sync_target t WHERE t.scope->>'repositoryId'=r.repository_id
          AND (t.requested_generation > t.completed_generation OR t.full_requested))
          OR (SELECT count(*) FROM sync_target t WHERE t.scope->>'repositoryId'=r.repository_id
            AND t.scope->>'_tag'='RepositoryTrack' AND t.verified_at IS NOT NULL) < 3 THEN 'syncing'
        ELSE 'ready' END AS "syncState"
    FROM github_repository r JOIN github_installation i USING(installation_id) ORDER BY r.owner,r.repo
  `.pipe(
      Effect.flatMap((repositories) =>
        Schema.decodeUnknownEffect(ConnectionInventory)({ repositories }),
      ),
      Effect.orDie,
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
              return yield* Effect.die("GitHub returned an invalid pagination link")
            visited.add(url)
            const response: GitHubResponse = yield* transport.request({
              scope,
              priority: "foreground",
              method: "GET",
              url,
            })
            if (response._tag !== "Ok")
              return yield* Effect.die(`GitHub answered ${url} with ${response._tag}`)
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
      const absent =
        installations.length === 0
          ? sql``
          : sql`AND installation_id NOT IN ${sql.in(installations.map((installation) => installation.id))}`
      yield* sql`UPDATE github_installation SET status = 'deleted', projected_sequence = ${sequence}
        WHERE projected_sequence <= ${sequence} ${absent}`
      for (const installation of installations) {
        yield* readModel.applyInstallation({
          installation,
          status: installation.suspendedAt === null ? "active" : "suspended",
          sequence,
          authoritative: true,
        })
        if (installation.suspendedAt !== null || requiredGitHubAccessError(installation) !== null)
          continue
        const repositories = (yield* pages(
          { _tag: "Installation", installationId: installation.id },
          "/installation/repositories?per_page=100",
          GitHubInstallationRepositoriesResponse,
        )).flatMap((page) => page.repositories)
        yield* readModel.withTransaction(
          Effect.gen(function* () {
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
          }),
        )
      }
    }).pipe(Effect.orDie)
    const change = (
      id: GitHubRepositoryDatabaseId,
      action: "connect" | "disconnect" | "resume" | "pause",
      actor: Actor,
    ) => {
      const accessUnavailable = new RepositoryBlocked({
        repositoryId: id,
        reason: "access-unavailable",
      })
      // A 404 means the App can no longer see it; any other answer is a defect.
      const verify = (request: GitHubRequest) =>
        transport.request(request).pipe(
          Effect.orDie,
          Effect.flatMap((response) =>
            response._tag === "Ok"
              ? Effect.succeed(response.body)
              : response._tag === "Failed" && response.status === 404
                ? Effect.fail(accessUnavailable)
                : Effect.die(`GitHub answered ${request.url} with ${response._tag}`),
          ),
        )
      return sql
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
              access_error: string | null
            }>`
      SELECT r.*,i.status,i.access_error FROM github_repository r JOIN github_installation i USING(installation_id)
      WHERE repository_id=${id} FOR UPDATE OF r`
            if (!row) return yield* new RepositoryNotFound({ repositoryId: id })
            if ((action === "resume" || action === "pause") && !row.connected)
              return yield* new RepositoryBlocked({
                repositoryId: id,
                reason: row.disconnected_at === null ? "not-connected" : "disconnected",
              })
            if (action === "connect" && row.connected) return
            const enabling = action === "resume" || action === "connect"
            if (enabling) {
              if (
                row.access !== "accessible" ||
                row.status !== "active" ||
                row.access_error !== null
              )
                return yield* accessUnavailable
              const installation = yield* Schema.decodeUnknownEffect(GitHubInstallationSummary)(
                yield* verify({
                  scope: { _tag: "App" },
                  priority: "foreground",
                  method: "GET",
                  url: `/app/installations/${row.installation_id}`,
                }),
              )
              if (
                installation.id !== row.installation_id ||
                installation.suspendedAt !== null ||
                requiredGitHubAccessError(installation) !== null
              )
                return yield* accessUnavailable
              const repository = yield* verify({
                scope: {
                  _tag: "Installation",
                  installationId: GitHubInstallationId.make(row.installation_id),
                },
                priority: "foreground",
                method: "GET",
                url: `/repos/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}`,
              })
              const verified = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ id: Schema.Number }),
              )(repository)
              if (String(verified.id) !== id)
                return yield* new RepositoryIdentityChanged({ repositoryId: id })
            }
            const enabled = enabling
            yield* sql`UPDATE github_repository SET connected=${action !== "disconnect"}, enabled=${enabled},
      disconnected_at=CASE WHEN ${action === "disconnect"} THEN now() ELSE disconnected_at END,
      observed_at=now() WHERE repository_id=${id}`
            if (action === "disconnect" || (action === "connect" && row.disconnected_at !== null)) {
              // Older journals lacked repository attribution. Identify them
              // before deleting so retained payloads cannot survive disconnect.
              const legacy = yield* sql<{ delivery_id: string; payload: Uint8Array }>`
                SELECT delivery_id, payload FROM github_webhook_delivery
                WHERE repository_id IS NULL AND event_name NOT IN ('installation','installation_repositories','ping') AND purged_at IS NULL`
              for (const delivery of legacy) {
                if (Option.contains(repositoryOfPayload(delivery.payload), id))
                  yield* sql`UPDATE github_webhook_delivery SET repository_id=${id} WHERE delivery_id=${delivery.delivery_id}`
              }
              yield* sql`SELECT delete_repository_data(${id})`
            }
            if (action !== "disconnect")
              yield* sql`INSERT INTO repository_connection_audit(repository_id,action,issuer,subject) VALUES(${id},${action},${actor.issuer},${actor.subject})`
            if (enabled) {
              for (const track of ["labels", "entities", "pull_requests"] as const)
                yield* targets.invalidate({
                  scope: { _tag: "RepositoryTrack", repositoryId: id, track },
                  sequence: Option.none(),
                  immediate: true,
                  full: true,
                })
              yield* targets.retryFailedEntities(id)
            }
          }),
        )
        .pipe(
          Effect.catchTag(
            ["SqlError", "SchemaError", "@janitor/cluster/SyncTargets/SyncTargetError"],
            Effect.die,
          ),
        )
    }
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
          return yield* Effect.die(`GitHub answered the installation lookup with ${response._tag}`)
        const data = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            slug: Schema.optionalKey(Schema.String),
            html_url: Schema.optionalKey(Schema.String),
          }),
        )(response.body)
        if (installationId === null && !data.slug)
          return yield* Effect.die("GitHub did not return the App's slug")
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
          return yield* Effect.die(`Unexpected GitHub settings URL ${url.origin}`)
        url.searchParams.set("state", attempt!.state)
        return url.toString()
      }).pipe(Effect.orDie)
    const returned = (state: string, actor: Actor) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`DELETE FROM repository_connection_attempt WHERE state::text=${state} AND issuer=${actor.issuer} AND subject=${actor.subject} AND expires_at>now() RETURNING state`
        if (rows.length === 0) return yield* new AuthorizationExpired()
        yield* refresh
      }).pipe(Effect.catchTag("SqlError", Effect.die))
    return { inventory, change, refresh, github, returned }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
