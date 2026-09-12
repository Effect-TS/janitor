import {
  type AccountView,
  LinkId,
  type LinkedAccount,
  type LinkPlatform,
  type LinkingAvailability,
  type PlatformAccount,
  type RosterEntry,
  TeammateId,
  type TeammateRole,
  type TeammateSummary,
} from "@janitor/domain/Team/Account"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { describeError } from "./SqlErrors.ts"

/**
 * Team membership behind Access sign-in (spec: "Identity and repository
 * selection"). A teammate is the stable identity that platform links,
 * accepted inputs and audit rows point at; Access only proves who is at the
 * browser right now.
 */

export const TeammateErrorReason = Schema.Literals([
  "forbidden",
  "not-found",
  "last-admin",
  "conflict",
  "expired",
  "removed",
  "rejected",
  "unavailable",
])
export type TeammateErrorReason = typeof TeammateErrorReason.Type

export class TeammateError extends Schema.TaggedError<TeammateError>()("TeammateError", {
  reason: TeammateErrorReason,
  message: Schema.String,
}) {}

export const isTeammateError = (error: unknown): error is TeammateError =>
  error instanceof TeammateError

/** The one identity that starts as admin. Everyone else is admitted as a member. */
export interface InitialAdmin {
  readonly issuer: string
  readonly subject: string
}

export class TeammatesConfig extends Context.Service<
  TeammatesConfig,
  { readonly initialAdmin: Option.Option<InitialAdmin> }
>()("@janitor/cluster/Teammates/TeammatesConfig") {}

export interface SignInIdentity {
  readonly issuer: string
  readonly subject: string
  readonly email: string | undefined
}

export type Admission =
  | { readonly _tag: "Admitted"; readonly teammate: TeammateSummary }
  | { readonly _tag: "Removed"; readonly teammate: TeammateSummary }

export interface LinkProof extends PlatformAccount {
  readonly displayName: string
}

export interface LinkAttempt {
  readonly state: string
  readonly nonce: string
}

/**
 * The outcome of asking whether a platform account may direct Janitor.
 * `identityRevision` records which authorization state the caller saw.
 */
export type Authorization =
  | {
      readonly _tag: "Authorized"
      readonly teammateId: TeammateId
      readonly linkId: string
      readonly role: TeammateRole
      readonly displayName: string
      readonly identityRevision: string
    }
  | { readonly _tag: "Denied"; readonly reason: "unknown-account" | "disconnected" | "removed" }

const TeammateRow = Schema.Struct({
  teammate_id: Schema.String,
  issuer: Schema.String,
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  role: Schema.Literals(["admin", "member"]),
  status: Schema.Literals(["active", "removed"]),
  created_at: Schema.DateTimeUtcFromDate,
  removed_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
})
type TeammateRow = typeof TeammateRow.Type

const LinkRow = Schema.Struct({
  link_id: Schema.String,
  teammate_id: Schema.String,
  platform: Schema.Literals(["slack", "github"]),
  workspace_id: Schema.String,
  account_id: Schema.String,
  display_name: Schema.String,
  status: Schema.Literals(["active", "disconnected", "disabled", "replaced"]),
  linked_at: Schema.DateTimeUtcFromDate,
  ended_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
})
type LinkRow = typeof LinkRow.Type

const decodeTeammates = Schema.decodeUnknownEffect(Schema.Array(TeammateRow))
const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(LinkRow))

const summary = (row: TeammateRow): TeammateSummary => ({
  teammateId: TeammateId.make(row.teammate_id),
  issuer: row.issuer,
  subject: row.subject,
  email: row.email,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  removedAt: row.removed_at,
})

const linkedAccount = (row: LinkRow): LinkedAccount => ({
  linkId: LinkId.make(row.link_id),
  platform: row.platform,
  workspaceId: row.workspace_id,
  accountId: row.account_id,
  displayName: row.display_name,
  status: row.status,
  linkedAt: row.linked_at,
  endedAt: row.ended_at,
})

const TEAMMATE_COLUMNS =
  "teammate_id::text AS teammate_id, issuer, subject, email, role, status, created_at, removed_at"
const LINK_COLUMNS =
  "link_id::text AS link_id, teammate_id::text AS teammate_id, platform, workspace_id, account_id, display_name, status, linked_at, ended_at"

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

/** Anything the database refuses becomes `unavailable`, except an ownership race. */
const wrap = <A, R>(
  effect: Effect.Effect<A, TeammateError | SqlError.SqlError | Schema.SchemaError, R>,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error._tag === "TeammateError"
        ? error
        : isUniqueViolation(error)
          ? new TeammateError({
              reason: "conflict",
              message: "That account was just connected by another teammate.",
            })
          : new TeammateError({ reason: "unavailable", message: describeError(error) }),
    ),
  )

export class Teammates extends Context.Service<
  Teammates,
  {
    /** Resolves or creates the teammate for a verified Access identity. */
    readonly admit: (identity: SignInIdentity) => Effect.Effect<Admission, TeammateError>
    readonly account: (
      teammateId: TeammateId,
      linking: LinkingAvailability,
    ) => Effect.Effect<AccountView, TeammateError>
    readonly roster: Effect.Effect<ReadonlyArray<RosterEntry>, TeammateError>
    readonly setRole: (
      actor: TeammateId,
      target: TeammateId,
      role: TeammateRole,
    ) => Effect.Effect<void, TeammateError>
    readonly remove: (actor: TeammateId, target: TeammateId) => Effect.Effect<void, TeammateError>
    readonly restore: (actor: TeammateId, target: TeammateId) => Effect.Effect<void, TeammateError>
    readonly disconnect: (
      teammateId: TeammateId,
      linkId: string,
    ) => Effect.Effect<void, TeammateError>
    readonly beginLink: (
      teammateId: TeammateId,
      platform: LinkPlatform,
    ) => Effect.Effect<LinkAttempt, TeammateError>
    /** Single use: a second call with the same state fails as expired. */
    readonly consumeLinkAttempt: (
      teammateId: TeammateId,
      platform: LinkPlatform,
      state: string,
    ) => Effect.Effect<{ readonly nonce: string }, TeammateError>
    /** Records a proven account. Replaces the teammate's earlier link in that workspace. */
    readonly link: (
      teammateId: TeammateId,
      proof: LinkProof,
    ) => Effect.Effect<LinkedAccount, TeammateError>
    /**
     * Decides whether a platform account may direct Janitor. Run it inside
     * the transaction that accepts the input: it takes a share lock on the
     * owning teammate and link rows, so a concurrent removal waits for the
     * acceptance to commit, and an input evaluated after removal is denied.
     */
    readonly authorize: (account: PlatformAccount) => Effect.Effect<Authorization, TeammateError>
  }
>()("@janitor/cluster/Teammates", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const config = yield* TeammatesConfig

    const loadTeammate = (teammateId: string) =>
      sql
        .unsafe(`SELECT ${TEAMMATE_COLUMNS} FROM teammate WHERE teammate_id::text = $1`, [
          teammateId,
        ])
        .pipe(
          Effect.flatMap(decodeTeammates),
          Effect.map((rows) => rows[0]),
        )

    /** Locks the target row; every role, status and link change goes through here. */
    const lockTeammate = (teammateId: string) =>
      sql
        .unsafe(
          `SELECT ${TEAMMATE_COLUMNS} FROM teammate WHERE teammate_id::text = $1 FOR UPDATE`,
          [teammateId],
        )
        .pipe(
          Effect.flatMap(decodeTeammates),
          Effect.map((rows) => rows[0]),
        )

    const linksOf = (teammateIds: ReadonlyArray<string>) =>
      teammateIds.length === 0
        ? Effect.succeed<ReadonlyArray<LinkRow>>([])
        : sql`SELECT ${sql.literal(LINK_COLUMNS)} FROM teammate_link
            WHERE teammate_id::text IN ${sql.in(teammateIds)}
            ORDER BY (status = 'active') DESC, linked_at DESC, link_id`.pipe(
            Effect.flatMap(decodeLinks),
          )

    const audit = (
      actor: string | null,
      subject: string,
      action: string,
      details: Record<string, unknown> = {},
    ) =>
      sql`INSERT INTO teammate_audit (actor_teammate_id, subject_teammate_id, action, details)
          VALUES (${actor}::uuid, ${subject}::uuid, ${action}, ${JSON.stringify(details)}::jsonb)`

    const touch = (teammateId: string) =>
      sql`UPDATE teammate SET identity_revision = identity_revision + 1, updated_at = now()
          WHERE teammate_id::text = ${teammateId}`

    // Role and status changes serialize on one advisory lock so the count of
    // active admins cannot change between the check and the write.
    const withRoles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(
        sql`SELECT pg_advisory_xact_lock(hashtext('teammate-roles'))`.pipe(Effect.andThen(effect)),
      )

    const requireAdmin = (actor: string) =>
      Effect.gen(function* () {
        const row = yield* loadTeammate(actor)
        if (row === undefined || row.status !== "active" || row.role !== "admin") {
          return yield* new TeammateError({
            reason: "forbidden",
            message: "Only an active admin can manage teammates.",
          })
        }
        return row
      })

    const otherActiveAdmins = (teammateId: string) =>
      sql<{ count: number }>`SELECT count(*)::int AS count FROM teammate
        WHERE role = 'admin' AND status = 'active' AND teammate_id::text <> ${teammateId}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      )

    // The configured admin may have been admitted as a member before the
    // configuration named them; make them admin as long as nobody else is.
    const ensureInitialAdmin = (teammate: TeammateRow) =>
      withRoles(
        Effect.gen(function* () {
          if ((yield* otherActiveAdmins(teammate.teammate_id)) > 0) return teammate
          yield* sql`UPDATE teammate SET role = 'admin' WHERE teammate_id::text = ${teammate.teammate_id}`
          yield* touch(teammate.teammate_id)
          yield* audit(null, teammate.teammate_id, "initial-admin")
          return (yield* loadTeammate(teammate.teammate_id)) ?? teammate
        }),
      )

    const findTeammate = (identity: SignInIdentity) =>
      sql
        .unsafe(`SELECT ${TEAMMATE_COLUMNS} FROM teammate WHERE issuer = $1 AND subject = $2`, [
          identity.issuer,
          identity.subject,
        ])
        .pipe(
          Effect.flatMap(decodeTeammates),
          Effect.map((rows) => rows[0]),
        )

    const admit = (identity: SignInIdentity) =>
      Effect.gen(function* () {
        const isInitialAdmin = Option.exists(
          config.initialAdmin,
          (admin) => admin.issuer === identity.issuer && admin.subject === identity.subject,
        )
        // Every browser request admits, so the common case is one read.
        const known = yield* findTeammate(identity)
        const current =
          known !== undefined &&
          (identity.email === undefined || identity.email === known.email) &&
          !(isInitialAdmin && known.status === "active" && known.role !== "admin")
            ? known
            : undefined
        if (current !== undefined) {
          return current.status === "removed"
            ? ({ _tag: "Removed", teammate: summary(current) } as const)
            : ({ _tag: "Admitted", teammate: summary(current) } as const)
        }
        const rows = yield* sql
          .unsafe(
            `INSERT INTO teammate (issuer, subject, email, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (issuer, subject) DO UPDATE
               SET email = COALESCE(EXCLUDED.email, teammate.email), updated_at = now()
             RETURNING ${TEAMMATE_COLUMNS}`,
            [
              identity.issuer,
              identity.subject,
              identity.email ?? null,
              isInitialAdmin ? "admin" : "member",
            ],
          )
          .pipe(Effect.flatMap(decodeTeammates))
        const admitted = rows[0]!
        const teammate =
          isInitialAdmin && admitted.status === "active" && admitted.role !== "admin"
            ? yield* ensureInitialAdmin(admitted)
            : admitted
        return teammate.status === "removed"
          ? ({ _tag: "Removed", teammate: summary(teammate) } as const)
          : ({ _tag: "Admitted", teammate: summary(teammate) } as const)
      }).pipe(wrap)

    const roster = sql
      .unsafe(`SELECT ${TEAMMATE_COLUMNS} FROM teammate ORDER BY created_at, teammate_id`)
      .pipe(
        Effect.flatMap(decodeTeammates),
        Effect.flatMap((rows) =>
          Effect.map(
            linksOf(rows.map((row) => row.teammate_id)),
            (links): ReadonlyArray<RosterEntry> =>
              rows.map((row) => ({
                ...summary(row),
                links: links
                  .filter((link) => link.teammate_id === row.teammate_id)
                  .map(linkedAccount),
              })),
          ),
        ),
        wrap,
      )

    const account = (teammateId: TeammateId, linking: LinkingAvailability) =>
      Effect.gen(function* () {
        const row = yield* loadTeammate(teammateId)
        if (row === undefined) {
          return yield* new TeammateError({ reason: "not-found", message: "Unknown teammate." })
        }
        const links = (yield* linksOf([teammateId])).map(linkedAccount)
        const team = row.role === "admin" && row.status === "active" ? yield* roster : null
        const view: AccountView = { teammate: summary(row), links, linking, team }
        return view
      }).pipe(wrap)

    const setRole = (actor: TeammateId, target: TeammateId, role: TeammateRole) =>
      withRoles(
        Effect.gen(function* () {
          yield* requireAdmin(actor)
          const current = yield* lockTeammate(target)
          if (current === undefined || current.status !== "active") {
            return yield* new TeammateError({
              reason: "not-found",
              message: "That teammate is not active.",
            })
          }
          if (current.role === role) return
          if (role === "member" && (yield* otherActiveAdmins(target)) === 0) {
            return yield* new TeammateError({
              reason: "last-admin",
              message: "The last active admin cannot be demoted.",
            })
          }
          yield* sql`UPDATE teammate SET role = ${role} WHERE teammate_id::text = ${target}`
          yield* touch(target)
          yield* audit(actor, target, "set-role", { role })
        }),
      ).pipe(wrap)

    const remove = (actor: TeammateId, target: TeammateId) =>
      withRoles(
        Effect.gen(function* () {
          yield* requireAdmin(actor)
          const current = yield* lockTeammate(target)
          if (current === undefined) {
            return yield* new TeammateError({ reason: "not-found", message: "Unknown teammate." })
          }
          if (current.status === "removed") return
          if (current.role === "admin" && (yield* otherActiveAdmins(target)) === 0) {
            return yield* new TeammateError({
              reason: "last-admin",
              message: "The last active admin cannot be removed.",
            })
          }
          yield* sql`UPDATE teammate SET status = 'removed', removed_at = now()
            WHERE teammate_id::text = ${target}`
          yield* sql`UPDATE teammate_link SET status = 'disabled', ended_at = now()
            WHERE teammate_id::text = ${target} AND status = 'active'`
          yield* touch(target)
          yield* audit(actor, target, "remove")
        }),
      ).pipe(wrap)

    const restore = (actor: TeammateId, target: TeammateId) =>
      withRoles(
        Effect.gen(function* () {
          yield* requireAdmin(actor)
          const current = yield* lockTeammate(target)
          if (current === undefined) {
            return yield* new TeammateError({ reason: "not-found", message: "Unknown teammate." })
          }
          if (current.status === "active") return
          yield* sql`UPDATE teammate SET status = 'active', removed_at = NULL
            WHERE teammate_id::text = ${target}`
          // Links disabled by removal carry proof that is still valid.
          yield* sql`UPDATE teammate_link SET status = 'active', ended_at = NULL
            WHERE teammate_id::text = ${target} AND status = 'disabled'`
          yield* touch(target)
          yield* audit(actor, target, "restore")
        }),
      ).pipe(wrap)

    const disconnect = (teammateId: TeammateId, linkId: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* lockTeammate(teammateId)
            const rows =
              yield* sql`UPDATE teammate_link SET status = 'disconnected', ended_at = now()
              WHERE link_id::text = ${linkId} AND teammate_id::text = ${teammateId} AND status = 'active'
              RETURNING link_id`
            if (rows.length === 0) {
              return yield* new TeammateError({
                reason: "not-found",
                message: "That connected account is not yours or is already disconnected.",
              })
            }
            yield* touch(teammateId)
            yield* audit(teammateId, teammateId, "disconnect", { linkId })
          }),
        )
        .pipe(wrap)

    const beginLink = (teammateId: TeammateId, platform: LinkPlatform) =>
      Effect.gen(function* () {
        const row = yield* loadTeammate(teammateId)
        if (row === undefined || row.status !== "active") {
          return yield* new TeammateError({
            reason: "removed",
            message: "Your Janitor membership was removed.",
          })
        }
        const [attempt] = yield* sql<{ state: string; nonce: string }>`
          INSERT INTO teammate_link_attempt (teammate_id, platform)
          VALUES (${teammateId}::uuid, ${platform}) RETURNING state::text, nonce::text`
        yield* sql`DELETE FROM teammate_link_attempt WHERE expires_at < now()`
        return { state: attempt!.state, nonce: attempt!.nonce }
      }).pipe(wrap)

    const consumeLinkAttempt = (teammateId: TeammateId, platform: LinkPlatform, state: string) =>
      Effect.gen(function* () {
        // A malformed state is not a UUID; treat it like any unknown one.
        const rows = yield* sql<{ nonce: string }>`
          DELETE FROM teammate_link_attempt
          WHERE state::text = ${state} AND teammate_id::text = ${teammateId}
            AND platform = ${platform} AND expires_at > now()
          RETURNING nonce::text`
        if (rows.length === 0) {
          return yield* new TeammateError({
            reason: "expired",
            message: "This connection attempt expired or was already used. Start again.",
          })
        }
        return { nonce: rows[0]!.nonce }
      }).pipe(wrap)

    const link = (teammateId: TeammateId, proof: LinkProof) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const teammate = yield* lockTeammate(teammateId)
            if (teammate === undefined || teammate.status !== "active") {
              return yield* new TeammateError({
                reason: "removed",
                message: "Your Janitor membership was removed.",
              })
            }
            const owners = yield* sql
              .unsafe(
                `SELECT ${LINK_COLUMNS} FROM teammate_link
                 WHERE platform = $1 AND workspace_id = $2 AND account_id = $3
                   AND status IN ('active', 'disabled') FOR UPDATE`,
                [proof.platform, proof.workspaceId, proof.accountId],
              )
              .pipe(Effect.flatMap(decodeLinks))
            const owner = owners[0]
            if (owner !== undefined && owner.teammate_id !== teammateId) {
              return yield* new TeammateError({
                reason: "conflict",
                message: "That account is connected to another teammate.",
              })
            }
            if (owner !== undefined) {
              const updated = yield* sql
                .unsafe(
                  `UPDATE teammate_link SET display_name = $2, status = 'active', ended_at = NULL
                   WHERE link_id::text = $1 RETURNING ${LINK_COLUMNS}`,
                  [owner.link_id, proof.displayName],
                )
                .pipe(Effect.flatMap(decodeLinks))
              return linkedAccount(updated[0]!)
            }
            yield* sql`UPDATE teammate_link SET status = 'replaced', ended_at = now()
              WHERE teammate_id::text = ${teammateId} AND platform = ${proof.platform}
                AND workspace_id = ${proof.workspaceId} AND status IN ('active', 'disabled')`
            const inserted = yield* sql
              .unsafe(
                `INSERT INTO teammate_link (teammate_id, platform, workspace_id, account_id, display_name)
                 VALUES ($1::uuid, $2, $3, $4, $5) RETURNING ${LINK_COLUMNS}`,
                [teammateId, proof.platform, proof.workspaceId, proof.accountId, proof.displayName],
              )
              .pipe(Effect.flatMap(decodeLinks))
            yield* touch(teammateId)
            yield* audit(teammateId, teammateId, "link", {
              platform: proof.platform,
              workspaceId: proof.workspaceId,
              accountId: proof.accountId,
            })
            return linkedAccount(inserted[0]!)
          }),
        )
        .pipe(wrap)

    const authorize = (account: PlatformAccount) =>
      sql<{
        link_id: string
        teammate_id: string
        link_status: string
        display_name: string
        teammate_status: string
        role: TeammateRole
        identity_revision: string
      }>`SELECT l.link_id::text AS link_id, l.teammate_id::text AS teammate_id, l.status AS link_status,
          l.display_name, t.status AS teammate_status, t.role, t.identity_revision::text AS identity_revision
        FROM teammate_link l JOIN teammate t USING (teammate_id)
        WHERE l.platform = ${account.platform} AND l.workspace_id = ${account.workspaceId}
          AND l.account_id = ${account.accountId}
        ORDER BY (l.status IN ('active', 'disabled')) DESC, l.linked_at DESC
        LIMIT 1 FOR SHARE OF l, t`.pipe(
        Effect.map((rows): Authorization => {
          const row = rows[0]
          if (row === undefined) return { _tag: "Denied", reason: "unknown-account" }
          if (row.teammate_status !== "active" || row.link_status === "disabled") {
            return { _tag: "Denied", reason: "removed" }
          }
          if (row.link_status !== "active") return { _tag: "Denied", reason: "disconnected" }
          return {
            _tag: "Authorized",
            teammateId: TeammateId.make(row.teammate_id),
            linkId: row.link_id,
            role: row.role,
            displayName: row.display_name,
            identityRevision: row.identity_revision,
          }
        }),
        wrap,
      )

    return {
      admit,
      account,
      roster,
      setRole,
      remove,
      restore,
      disconnect,
      beginLink,
      consumeLinkAttempt,
      link,
      authorize,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
