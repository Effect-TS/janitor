import * as Schema from "effect/Schema"

export const TeammateId = Schema.NonEmptyString.pipe(Schema.brand("TeammateId")).annotate({
  identifier: "TeammateId",
})
export type TeammateId = typeof TeammateId.Type

export const TeammateRole = Schema.Literals(["admin", "member"])
export type TeammateRole = typeof TeammateRole.Type

export const TeammateStatus = Schema.Literals(["active", "removed"])
export type TeammateStatus = typeof TeammateStatus.Type

/** The platforms a teammate can prove an account on. */
export const LinkPlatform = Schema.Literals(["slack", "github"])
export type LinkPlatform = typeof LinkPlatform.Type

/** GitHub has one namespace of numeric user IDs; Slack accounts are per workspace. */
export const GITHUB_WORKSPACE_ID = "github.com"

export const LinkStatus = Schema.Literals(["active", "disconnected", "disabled", "replaced"])
export type LinkStatus = typeof LinkStatus.Type

export const LinkId = Schema.NonEmptyString.pipe(Schema.brand("LinkId")).annotate({
  identifier: "LinkId",
})
export type LinkId = typeof LinkId.Type

/** A platform account as a platform identifies it: exact strings, never display names. */
export const PlatformAccount = Schema.Struct({
  platform: LinkPlatform,
  workspaceId: Schema.String,
  accountId: Schema.String,
})
export type PlatformAccount = typeof PlatformAccount.Type

export const LinkedAccount = Schema.Struct({
  linkId: LinkId,
  platform: LinkPlatform,
  workspaceId: Schema.String,
  accountId: Schema.String,
  displayName: Schema.String,
  status: LinkStatus,
  linkedAt: Schema.DateTimeUtcFromString,
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
})
export type LinkedAccount = typeof LinkedAccount.Type

export const TeammateSummary = Schema.Struct({
  teammateId: TeammateId,
  issuer: Schema.String,
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  role: TeammateRole,
  status: TeammateStatus,
  createdAt: Schema.DateTimeUtcFromString,
  removedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
})
export type TeammateSummary = typeof TeammateSummary.Type

/** A teammate with their active links, as the roster shows it. */
export const RosterEntry = Schema.Struct({
  ...TeammateSummary.fields,
  links: Schema.Array(LinkedAccount),
})
export type RosterEntry = typeof RosterEntry.Type

/** Which platform links the deployment can start; unconfigured ones show as unavailable. */
export const LinkingAvailability = Schema.Struct({
  slack: Schema.Boolean,
  github: Schema.Boolean,
})
export type LinkingAvailability = typeof LinkingAvailability.Type

export const AccountView = Schema.Struct({
  teammate: TeammateSummary,
  links: Schema.Array(LinkedAccount),
  linking: LinkingAvailability,
  /** Present for admins only. */
  team: Schema.NullOr(Schema.Array(RosterEntry)),
})
export type AccountView = typeof AccountView.Type

export const SetRoleRequest = Schema.Struct({ role: TeammateRole })
export type SetRoleRequest = typeof SetRoleRequest.Type

/** What the browser brings back from a platform's authorization page. */
export const LinkReturnRequest = Schema.Struct({
  state: Schema.String,
  code: Schema.String,
})
export type LinkReturnRequest = typeof LinkReturnRequest.Type
