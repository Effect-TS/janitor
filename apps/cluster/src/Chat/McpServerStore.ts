import {
  type McpServerChange,
  type McpServerConfig,
  McpServerNameTaken,
  type NewMcpServer,
} from "@janitor/domain/Chat/McpServer"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"

/**
 * The MCP servers configured on the dashboard (EFF-3443), in Postgres. Only
 * their configuration: each server's credential is in its own Durable
 * Object (`McpCredential.ts`).
 */
export class McpServerStore extends Context.Service<
  McpServerStore,
  {
    /** Every server, by name. */
    readonly list: Effect.Effect<ReadonlyArray<McpServerConfig>, SqlError.SqlError>
    readonly get: (id: string) => Effect.Effect<Option.Option<McpServerConfig>, SqlError.SqlError>
    readonly create: (
      server: NewMcpServer,
    ) => Effect.Effect<McpServerConfig, SqlError.SqlError | McpServerNameTaken>
    /** None when no server has `id`. */
    readonly update: (
      id: string,
      change: McpServerChange,
    ) => Effect.Effect<Option.Option<McpServerConfig>, SqlError.SqlError>
    /** Whether a server had `id`. */
    readonly remove: (id: string) => Effect.Effect<boolean, SqlError.SqlError>
  }
>()("@janitor/cluster/Chat/McpServerStore/McpServerStore") {
  static readonly layer: Layer.Layer<McpServerStore, never, SqlClient.SqlClient> = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const columns = sql.unsafe("id, name, url, auth, private, enabled")

      const get = (id: string) =>
        sql<McpServerConfig>`SELECT ${columns} FROM chat_mcp_servers WHERE id = ${id}`.pipe(
          Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
        )

      return {
        list: sql<McpServerConfig>`SELECT ${columns} FROM chat_mcp_servers ORDER BY name`,
        get,
        create: (server) =>
          sql<McpServerConfig>`
            INSERT INTO chat_mcp_servers ${sql.insert({
              id: crypto.randomUUID(),
              name: server.name,
              url: server.url,
              auth: server.auth,
              private: server.private ?? true,
              enabled: server.enabled ?? true,
            })}
            RETURNING ${columns}`.pipe(
            Effect.flatMap((rows) =>
              rows[0] === undefined
                ? Effect.die(new Error("INSERT returned no row"))
                : Effect.succeed(rows[0]),
            ),
            Effect.catchIf(isUniqueViolation, () =>
              Effect.fail(new McpServerNameTaken({ name: server.name })),
            ),
          ),
        update: (id, change) => {
          const set = {
            ...(change.private === undefined ? {} : { private: change.private }),
            ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
          }
          if (Object.keys(set).length === 0) return get(id)
          return sql<McpServerConfig>`
            UPDATE chat_mcp_servers SET ${sql.update(set)}, updated_at = CLOCK_TIMESTAMP()
            WHERE id = ${id}
            RETURNING ${columns}`.pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])))
        },
        remove: (id) =>
          sql`DELETE FROM chat_mcp_servers WHERE id = ${id} RETURNING id`.pipe(
            Effect.map((rows) => rows.length > 0),
          ),
      }
    }),
  )
}

const UNIQUE_VIOLATION = "23505"

const isUniqueViolation = (error: unknown): boolean => {
  if (!SqlError.isSqlError(error)) return false
  const cause: unknown = error.reason.cause
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === UNIQUE_VIOLATION
  )
}
