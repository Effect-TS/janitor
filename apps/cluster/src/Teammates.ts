import {
  type AccountView,
  LinkId,
  type LinkedAccount,
  type LinkPlatform,
  type LinkingAvailability,
  type PlatformAccount,
  TeammateId,
  type TeammateSummary,
} from "@janitor/domain/Team/Account"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { describeError } from "./SqlErrors.ts"

/**
 * The identity behind Access sign-in. Access decides who may use Janitor;
 * everyone it admits is a teammate with every permission. A teammate is the
 * stable identity that platform links, accepted inputs and audit rows point
 * at; Access only proves who is at the browser right now.
 */

export const TeammateErrorReason = Schema.Literals([
  "not-found",
  "conflict",
  "expired",
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

export interface SignInIdentity {
  readonly issuer: string
  readonly subject: string
  readonly email: string | undefined
}

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
      readonly displayName: string
      readonly identityRevision: string
    }
  | { readonly _tag: "Denied"; readonly reason: "unknown-account" | "disconnected" }

const TeammateRow = Schema.Struct({
  teammate_id: Schema.String,
  issuer: Schema.String,
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  created_at: Schema.DateTimeUtcFromDate,
})
type TeammateRow = typeof TeammateRow.Type

const LinkRow = Schema.Struct({
  link_id: Schema.String,
  teammate_id: Schema.String,
  platform: Schema.Literals(["slack", "github"]),
  workspace_id: Schema.String,
  account_id: Schema.String,
  display_name: Schema.String,
  status: Schema.Literals(["active", "disconnected", "replaced"]),
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
  createdAt: row.created_at,
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

const TEAMMATE_COLUMNS = "teammate_id::text AS teammate_id, issuer, subject, email, created_at"
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
    readonly admit: (identity: SignInIdentity) => Effect.Effect<TeammateSummary, TeammateError>
    readonly account: (
      teammateId: TeammateId,
      linking: LinkingAvailability,
    ) => Effect.Effect<AccountView, TeammateError>
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
     * owning teammate and link rows, so a concurrent disconnect waits for the
     * acceptance to commit, and an input evaluated after it is denied.
     */
    readonly authorize: (account: PlatformAccount) => Effect.Effect<Authorization, TeammateError>
  }
>()("@janitor/cluster/Teammates", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const loadTeammate = (teammateId: string) =>
      sql
        .unsafe(`SELECT ${TEAMMATE_COLUMNS} FROM teammate WHERE teammate_id::text = $1`, [
          teammateId,
        ])
        .pipe(
          Effect.flatMap(decodeTeammates),
          Effect.map((rows) => rows[0]),
        )

    /** Locks the target row; every link change goes through here. */
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

    const advanceIdentityRevision = (teammateId: string) =>
      sql`UPDATE teammate SET identity_revision = identity_revision + 1, updated_at = now()
          WHERE teammate_id::text = ${teammateId}`

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
        // Every browser request admits, so the common case is one read.
        const known = yield* findTeammate(identity)
        if (known !== undefined && (identity.email === undefined || identity.email === known.email))
          return summary(known)
        const rows = yield* sql
          .unsafe(
            `INSERT INTO teammate (issuer, subject, email)
             VALUES ($1, $2, $3)
             ON CONFLICT (issuer, subject) DO UPDATE
               SET email = COALESCE(EXCLUDED.email, teammate.email), updated_at = now()
             RETURNING ${TEAMMATE_COLUMNS}`,
            [identity.issuer, identity.subject, identity.email ?? null],
          )
          .pipe(Effect.flatMap(decodeTeammates))
        return summary(rows[0]!)
      }).pipe(wrap)

    const account = (teammateId: TeammateId, linking: LinkingAvailability) =>
      Effect.gen(function* () {
        const row = yield* loadTeammate(teammateId)
        if (row === undefined) {
          return yield* new TeammateError({ reason: "not-found", message: "Unknown teammate." })
        }
        const links = (yield* linksOf([teammateId])).map(linkedAccount)
        const view: AccountView = { teammate: summary(row), links, linking }
        return view
      }).pipe(wrap)

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
            yield* advanceIdentityRevision(teammateId)
            yield* audit(teammateId, teammateId, "disconnect", { linkId })
          }),
        )
        .pipe(wrap)

    const beginLink = (teammateId: TeammateId, platform: LinkPlatform) =>
      Effect.gen(function* () {
        const row = yield* loadTeammate(teammateId)
        if (row === undefined) {
          return yield* new TeammateError({ reason: "not-found", message: "Unknown teammate." })
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
            if (teammate === undefined) {
              return yield* new TeammateError({ reason: "not-found", message: "Unknown teammate." })
            }
            const owners = yield* sql
              .unsafe(
                `SELECT ${LINK_COLUMNS} FROM teammate_link
                 WHERE platform = $1 AND workspace_id = $2 AND account_id = $3
                   AND status = 'active' FOR UPDATE`,
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
              // Fresh proof of the same account: keep the link, note the re-proof.
              const updated = yield* sql
                .unsafe(
                  `UPDATE teammate_link SET display_name = $2, status = 'active', ended_at = NULL
                   WHERE link_id::text = $1 RETURNING ${LINK_COLUMNS}`,
                  [owner.link_id, proof.displayName],
                )
                .pipe(Effect.flatMap(decodeLinks))
              yield* advanceIdentityRevision(teammateId)
              yield* audit(teammateId, teammateId, "relink", { linkId: owner.link_id })
              return linkedAccount(updated[0]!)
            }
            yield* sql`UPDATE teammate_link SET status = 'replaced', ended_at = now()
              WHERE teammate_id::text = ${teammateId} AND platform = ${proof.platform}
                AND workspace_id = ${proof.workspaceId} AND status = 'active'`
            const inserted = yield* sql
              .unsafe(
                `INSERT INTO teammate_link (teammate_id, platform, workspace_id, account_id, display_name)
                 VALUES ($1::uuid, $2, $3, $4, $5) RETURNING ${LINK_COLUMNS}`,
                [teammateId, proof.platform, proof.workspaceId, proof.accountId, proof.displayName],
              )
              .pipe(Effect.flatMap(decodeLinks))
            yield* advanceIdentityRevision(teammateId)
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
        identity_revision: string
      }>`SELECT l.link_id::text AS link_id, l.teammate_id::text AS teammate_id, l.status AS link_status,
          l.display_name, t.identity_revision::text AS identity_revision
        FROM teammate_link l JOIN teammate t USING (teammate_id)
        WHERE l.platform = ${account.platform} AND l.workspace_id = ${account.workspaceId}
          AND l.account_id = ${account.accountId}
        ORDER BY (l.status = 'active') DESC, l.linked_at DESC
        LIMIT 1 FOR SHARE OF l, t`.pipe(
        Effect.map((rows): Authorization => {
          const row = rows[0]
          if (row === undefined) return { _tag: "Denied", reason: "unknown-account" }
          if (row.link_status !== "active") return { _tag: "Denied", reason: "disconnected" }
          return {
            _tag: "Authorized",
            teammateId: TeammateId.make(row.teammate_id),
            linkId: row.link_id,
            displayName: row.display_name,
            identityRevision: row.identity_revision,
          }
        }),
        wrap,
      )

    return {
      admit,
      account,
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
